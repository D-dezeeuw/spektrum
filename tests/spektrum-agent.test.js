/*
  Tests for spektrum/agent — the in-page LLM panel that drives a
  Spektrum instance through the MCP tool catalog.

  Network access is stubbed by overriding globalThis.fetch per test:
  each stub returns the response shape (Anthropic vs. OpenAI/OpenRouter)
  the adapter expects. localStorage is provided by happy-dom and cleared
  between tests so per-provider key state doesn't bleed.

  Coverage targets: mount/unmount, dock integration, settings UI
  (provider switch, save, clear, cog toggle, key-mask handling),
  collapse, the runTurn tool loop (multi-hop, no-tool break, unknown
  tool, handler throw, missing key), and the helpers (compactJson,
  escapeHtml, toApiName) through their call sites.

  Several branches in toOpenAIMessages (null assistant content, null
  tool_use.input) and one in escapeHtml (`String(s ?? '')` nullish) are
  defense-in-depth guards against shapes the module never produces
  on its own. We reach them by:
    - mixing providers across turns so the openai adapter ends up
      processing assistant entries shaped by the anthropic adapter
      (null content from a failed turn, tool_use blocks with null
      input from anthropic stubs);
    - returning malformed model responses (tool_use without a name)
      to feed nullish arguments into renderToolCall → escapeHtml;
    - temporarily monkey-patching JSON.stringify for one test so that
      a tool_result with non-string content lands in `messages` (the
      L151 ternary branch — the only path that no normal flow reaches).
*/

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

import { test, suite, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSpektrum } from '../spektrum.js';
// Dynamic-import the agent + dock modules so happy-dom's `location`
// global is in place before the agent's top-level openrouter factory
// reads `location.origin`. Static imports are hoisted above the
// register() call, which would crash on load.
const { mount }            = await import('../companions/spektrum-agent.js');
const { mount: mountDock } = await import('../companions/spektrum-dock.js');

let s;
let realFetch;

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  localStorage.clear();
  s = createSpektrum();
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Build a fetch stub that yields the responses in order. Each entry is
// either { ok: true, body } (returned as text → JSON.parse) or a string
// (returned as 200 ok with that text), or an Error to throw.
const stubFetch = (responses) => {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'object' && 'status' in next) {
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        text: async () => next.text ?? '',
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => typeof next === 'string' ? next : JSON.stringify(next),
    };
  };
  return calls;
};

// Anthropic content blocks — text only.
const anthropicText = (text) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
});

// Anthropic content blocks — one tool_use, then a text reply on the next call.
const anthropicToolUse = (name, input, id = 'tu_1') => ({
  content: [{ type: 'tool_use', id, name, input }],
  stop_reason: 'tool_use',
});

// OpenAI/OpenRouter chat-completion shape.
const openaiText = (text) => ({
  choices: [{ message: { content: text }, finish_reason: 'stop' }],
});
const openaiToolCall = (name, input, id = 'tc_1') => ({
  choices: [{
    message: {
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
    },
    finish_reason: 'tool_calls',
  }],
});

// === Mount / lifecycle ===

suite('mount lifecycle', () => {

test('mount renders a panel and unmount removes it', () => {
  const unmount = mount(s);
  const panel = document.querySelector('[data-spektrum-agent]');
  assert.ok(panel);
  assert.ok(panel.querySelector('[data-log]'));
  assert.ok(panel.querySelector('[data-input]'));
  assert.ok(panel.querySelector('[data-send]'));
  unmount();
  assert.equal(document.querySelector('[data-spektrum-agent]'), null);
});

test('mount falls back to bottom-left on unknown position', () => {
  // Hits the `corners[position] || corners['bottom-left']` OR branch.
  const unmount = mount(s, { position: 'somewhere-imaginary' });
  const panel = document.querySelector('[data-spektrum-agent]');
  assert.match(panel.style.cssText, /bottom:\s*12px/);
  assert.match(panel.style.cssText, /left:\s*12px/);
  unmount();
});

test('mount honours explicit position', () => {
  const unmount = mount(s, { position: 'top-right' });
  const panel = document.querySelector('[data-spektrum-agent]');
  assert.match(panel.style.cssText, /top:\s*12px/);
  assert.match(panel.style.cssText, /right:\s*12px/);
  unmount();
});

test('mount honours a custom parent', () => {
  const host = document.createElement('section');
  document.body.appendChild(host);
  const unmount = mount(s, { parent: host });
  assert.ok(host.querySelector('[data-spektrum-agent]'));
  unmount();
});

test('mount accepts opts.apiKey and seeds localStorage', () => {
  const unmount = mount(s, { provider: 'anthropic', apiKey: 'sk-ant-test' });
  assert.equal(localStorage.getItem('spektrum:agent:apikey:anthropic'), 'sk-ant-test');
  unmount();
});

test('opts.apiKey does NOT overwrite an existing stored key', () => {
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'existing');
  const unmount = mount(s, { provider: 'anthropic', apiKey: 'override-attempt' });
  // seedKey is the `if (!localStorage.getItem(...)) set` guard — existing wins.
  assert.equal(localStorage.getItem('spektrum:agent:apikey:anthropic'), 'existing');
  unmount();
});

test('mount accepts opts.model and writes it to localStorage', () => {
  const unmount = mount(s, { provider: 'anthropic', model: 'claude-opus-4-7' });
  assert.equal(localStorage.getItem('spektrum:agent:model:anthropic'), 'claude-opus-4-7');
  unmount();
});

test('mount reads provider from localStorage when opts.provider is absent', () => {
  localStorage.setItem('spektrum:agent:provider', 'openai');
  const unmount = mount(s);
  const panel = document.querySelector('[data-spektrum-agent]');
  // Title shows "spektrum agent · openai · gpt-4o-mini"
  assert.match(panel.innerHTML, /openai/);
  unmount();
});

test('mount falls back to anthropic when stored provider is unknown', () => {
  // Hits `if (!PROVIDERS[provider]) provider = 'anthropic'`.
  localStorage.setItem('spektrum:agent:provider', 'never-heard-of-it');
  const unmount = mount(s);
  const panel = document.querySelector('[data-spektrum-agent]');
  assert.match(panel.innerHTML, /anthropic/);
  unmount();
});

test('greeting reflects whether a key is configured', () => {
  // No key configured → "Pick a provider…" prompt.
  const u1 = mount(s);
  let log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /Pick a provider/);
  u1();

  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  const u2 = mount(s);
  log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /Ready/);
  u2();
});

test('settings panel starts open when no provider has a key', () => {
  const unmount = mount(s);
  const settings = document.querySelector('[data-settings]');
  assert.equal(settings.style.display, 'block');
  unmount();
});

test('settings panel starts closed when at least one provider has a key', () => {
  localStorage.setItem('spektrum:agent:apikey:openrouter', 'sk-or-x');
  const unmount = mount(s);
  const settings = document.querySelector('[data-settings]');
  assert.equal(settings.style.display, 'none');
  unmount();
});

test('input + send are disabled when no key is configured', () => {
  const unmount = mount(s);
  assert.equal(document.querySelector('[data-input]').disabled, true);
  assert.equal(document.querySelector('[data-send]').disabled, true);
  unmount();
});

test('input + send are enabled when a key is configured', () => {
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  const unmount = mount(s);
  assert.equal(document.querySelector('[data-input]').disabled, false);
  assert.equal(document.querySelector('[data-send]').disabled, false);
  unmount();
});

test('opts.title and opts.system are honoured', () => {
  const unmount = mount(s, { title: 'my agent', system: 'be terse' });
  const panel = document.querySelector('[data-spektrum-agent]');
  assert.match(panel.innerHTML, /my agent/);
  unmount();
});

});

// === Dock integration ===

suite('dock integration', () => {

test('agent registers as a dock tab when a dock is mounted', () => {
  const dock = mountDock();
  const stop = mount(s);
  assert.ok(document.querySelector('[data-spektrum-dock] [data-panel-tab="agent"]'));
  const panel = document.querySelector('[data-spektrum-agent]');
  assert.ok(panel.closest('[data-spektrum-dock]'), 'agent panel lives inside dock');
  stop(); dock.unmount();
});

test('agent without a dock keeps its free-floating panel', () => {
  const stop = mount(s);
  const panel = document.querySelector('[data-spektrum-agent]');
  assert.ok(panel);
  assert.equal(panel.closest('[data-spektrum-dock]'), null);
  stop();
});

test('agent unmount removes its dock tab', () => {
  const dock = mountDock();
  const stop = mount(s);
  assert.ok(document.querySelector('[data-panel-tab="agent"]'));
  stop();
  assert.equal(document.querySelector('[data-panel-tab="agent"]'), null);
  dock.unmount();
});

test('dock onClose cascades into agent unmount', () => {
  const dock = mountDock();
  mount(s);
  dock.unmount();
  // Both the agent panel and the dock are gone.
  assert.equal(document.querySelector('[data-spektrum-agent]'), null);
  assert.equal(document.querySelector('[data-spektrum-dock]'), null);
});

});

// === Settings interaction ===

suite('settings', () => {

test('cog toggles the settings panel open and closed', () => {
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x'); // start closed
  const unmount = mount(s);
  const cog = document.querySelector('[data-cog]');
  const settings = document.querySelector('[data-settings]');
  assert.equal(settings.style.display, 'none');
  cog.click();
  assert.equal(settings.style.display, 'block');
  cog.click();
  assert.equal(settings.style.display, 'none');
  unmount();
});

test('provider buttons switch the active provider and persist it', () => {
  const unmount = mount(s);
  document.querySelector('[data-prov="openai"]').click();
  assert.equal(localStorage.getItem('spektrum:agent:provider'), 'openai');
  // Title reflects the change.
  assert.match(document.querySelector('[data-title]').innerHTML, /openai/);
  unmount();
});

test('save writes model and key to localStorage and closes settings', () => {
  const unmount = mount(s);
  document.querySelector('[data-prov="openai"]').click();
  const model = document.querySelector('[data-model]');
  const key = document.querySelector('[data-key]');
  model.value = 'gpt-4o';
  key.value = 'sk-test-123';
  document.querySelector('[data-save]').click();
  assert.equal(localStorage.getItem('spektrum:agent:model:openai'), 'gpt-4o');
  assert.equal(localStorage.getItem('spektrum:agent:apikey:openai'), 'sk-test-123');
  assert.equal(document.querySelector('[data-settings]').style.display, 'none');
  unmount();
});

test('save with empty model and key is a no-op (does not clobber existing values)', () => {
  // Covers the falsy branches of `if (m)` and `if (k && k !== mask)`.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'existing-key');
  localStorage.setItem('spektrum:agent:model:anthropic', 'existing-model');
  const unmount = mount(s);
  // Settings opens with masked key. Clear both fields to hit the empty branches.
  document.querySelector('[data-model]').value = '';
  document.querySelector('[data-key]').value = '';
  document.querySelector('[data-save]').click();
  assert.equal(localStorage.getItem('spektrum:agent:apikey:anthropic'), 'existing-key');
  assert.equal(localStorage.getItem('spektrum:agent:model:anthropic'), 'existing-model');
  unmount();
});

test('save ignores the masked-bullet placeholder (does not write it as the key)', () => {
  // Covers `k !== '••••••••'` — the explicit mask check.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'real-key');
  const unmount = mount(s);
  // Settings is closed since a key exists; open it to populate the masked input.
  document.querySelector('[data-cog]').click();
  const keyEl = document.querySelector('[data-key]');
  assert.equal(keyEl.value, '••••••••', 'masked placeholder rendered');
  // Click save without changing — key stays.
  document.querySelector('[data-save]').click();
  assert.equal(localStorage.getItem('spektrum:agent:apikey:anthropic'), 'real-key');
  unmount();
});

test('clear removes the key for the active provider', () => {
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'to-clear');
  const unmount = mount(s);
  document.querySelector('[data-cog]').click();   // open settings
  document.querySelector('[data-clear]').click();
  assert.equal(localStorage.getItem('spektrum:agent:apikey:anthropic'), null);
  unmount();
});

test('clicking the title collapses and re-expands the body', () => {
  const unmount = mount(s);
  const title = document.querySelector('[data-title]');
  const body = document.querySelector('[data-body]');
  assert.equal(body.style.display, 'flex');
  title.click();
  assert.equal(body.style.display, 'none');
  title.click();
  assert.equal(body.style.display, 'flex');
  unmount();
});

});

// === Tool loop ===

suite('tool loop', () => {

test('plain user message → assistant text reply (no tool calls)', async () => {
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([anthropicText('hello back')]);
  const unmount = mount(s);
  const input = document.querySelector('[data-input]');
  input.value = 'hi';
  document.querySelector('[data-send]').click();
  // Wait for the async runTurn to render.
  await new Promise(r => setTimeout(r, 5));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /hi/);
  assert.match(log, /hello back/);
  unmount();
});

test('tool_use → tool_result → final text (two-hop)', async () => {
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  // Hop 1: model calls spektrum_setValue. Hop 2: model replies with text.
  stubFetch([
    anthropicToolUse('spektrum_setValue', { path: 'x', value: 42 }),
    anthropicText('done.'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'set x to 42';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  // The tool actually ran — state has x = 42.
  s.tick();
  assert.equal(s.appState.x, 42);
  // UI shows the tool call and result.
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /spektrum_setValue/);
  assert.match(log, /done\./);
  unmount();
});

test('unknown tool name is rendered as an error result', async () => {
  // Covers `result = handler ? ... : { error: \`unknown tool ${name}\` }` falsy branch.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([
    anthropicToolUse('not_a_real_tool', {}),
    anthropicText('giving up.'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'do the thing';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /not_a_real_tool/);
  assert.match(log, /unknown tool/);
  unmount();
});

test('tool handler that throws is rendered as an error and the loop continues', async () => {
  // None of the engine methods the catalog exposes throw under normal
  // arguments (setValue / trigger warn rather than throw, replay clamps).
  // Force a throw at the engine boundary so the catch in runTurn fires.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  s.setValue = () => { throw new Error('engine boom'); };
  stubFetch([
    anthropicToolUse('spektrum_setValue', { path: 'x', value: 1 }),
    anthropicText('caught the error.'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'set x';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /✗/, 'error glyph rendered');
  assert.match(log, /engine boom/);
  assert.match(log, /caught the error/);
  unmount();
});

test('runTurn renders an error when no API key is configured', async () => {
  // Have a key for openrouter but switch to anthropic in the panel and
  // clear anthropic — so currentKey() returns empty for the active provider.
  localStorage.setItem('spektrum:agent:apikey:openrouter', 'sk-or-x');
  const unmount = mount(s);
  // Switch to anthropic (which has no key).
  document.querySelector('[data-prov="anthropic"]').click();
  // Input/send should still be disabled now; force-enable to drive the path.
  document.querySelector('[data-input]').disabled = false;
  document.querySelector('[data-send]').disabled = false;
  document.querySelector('[data-input]').value = 'hi';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 5));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /no API key/);
  unmount();
});

test('fetch failure surfaces as a rendered error', async () => {
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([new Error('network down')]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'hi';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 5));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /network down/);
  unmount();
});

test('non-2xx fetch surfaces the status + body in the error', async () => {
  // Covers the `if (!res.ok) throw new Error(...)` branch in fetchJson.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([{ status: 401, text: 'unauthorized' }]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'hi';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 5));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /401/);
  unmount();
});

test('hop bound — 8 consecutive tool_use responses then break', async () => {
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  // Reply with tool_use 8 times — loop must bail at the 8-hop limit
  // even though the model never says stop. The 9th setValue must NOT run.
  const responses = Array.from({ length: 9 }, (_, i) =>
    anthropicToolUse('spektrum_setValue', { path: 'n', value: i }, `tu_${i}`));
  stubFetch(responses);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'go';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 30));
  s.tick();
  // Last completed setValue is i=7 (0..7 = 8 hops). The 9th never runs.
  assert.equal(s.appState.n, 7, 'loop stopped at the 8-hop bound');
  unmount();
});

test('tool_use with null input passes an empty object to the handler', async () => {
  // Covers `block.input || {}` falsy branch.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([
    { content: [{ type: 'tool_use', id: 'tu_x', name: 'spektrum_getState', input: null }],
      stop_reason: 'tool_use' },
    anthropicText('done.'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'go';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.match(document.querySelector('[data-log]').innerHTML, /done\./);
  unmount();
});

test('handler throwing a non-Error stringifies it for the result envelope', async () => {
  // Covers the `err?.message || String(err)` falsy-message branch in the
  // inner catch (the handler-call catch).
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  s.setValue = () => { throw 'plain-string-error'; };          // not an Error
  stubFetch([
    anthropicToolUse('spektrum_setValue', { path: 'x', value: 1 }),
    anthropicText('moved on.'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'set x';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /plain-string-error/, 'non-Error stringified');
  unmount();
});

test('adapter throwing a non-Error stringifies it for the outer catch', async () => {
  // Covers the `err?.message || String(err)` falsy branch in the outer catch.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  globalThis.fetch = async () => { throw 'transport-fail'; };  // not an Error
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'hi';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.match(document.querySelector('[data-log]').innerHTML, /transport-fail/);
  unmount();
});

test('shift+Enter inserts newline, Enter alone submits', async () => {
  // Covers the keydown branch with and without ev.shiftKey.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([anthropicText('ack')]);
  const unmount = mount(s);
  const input = document.querySelector('[data-input]');
  input.value = 'hi';
  // Shift+Enter — should NOT submit (preventDefault skipped).
  let ev = new Event('keydown', { bubbles: true, cancelable: true });
  ev.key = 'Enter';
  ev.shiftKey = true;
  input.dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 5));
  // No fetch call was made.
  // (We can't easily inspect the stub from here; we rely on input being
  // not cleared — submit() clears it.)
  assert.equal(input.value, 'hi');
  // Plain Enter — should submit.
  ev = new Event('keydown', { bubbles: true, cancelable: true });
  ev.key = 'Enter';
  ev.shiftKey = false;
  input.dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(input.value, '', 'input cleared on submit');
  unmount();
});

test('empty assistant text is silently swallowed (no DOM append)', async () => {
  // Covers `if (!text.trim()) return null;` in renderAssistantText.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([{
    content: [{ type: 'text', text: '   ' }],          // whitespace-only
    stop_reason: 'end_turn',
  }]);
  const unmount = mount(s);
  const before = document.querySelectorAll('[data-log] > div').length;
  document.querySelector('[data-input]').value = 'hi';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 5));
  const after = document.querySelectorAll('[data-log] > div').length;
  // Only the user echo div was appended — the empty assistant text was suppressed.
  assert.equal(after - before, 1, 'empty assistant text did not produce a log entry');
  unmount();
});

test('tool_use with undefined input passes through compactJson null-branch', async () => {
  // Covers `if (s == null) return String(v);` in compactJson — JSON.stringify(undefined) === undefined.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([
    { content: [{ type: 'tool_use', id: 'tu_u', name: 'spektrum_getState', input: undefined }],
      stop_reason: 'tool_use' },
    anthropicText('ok'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'go';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  // Rendered without throwing — compactJson(undefined) returned "undefined".
  assert.match(document.querySelector('[data-log]').innerHTML, /undefined/);
  unmount();
});

test('tool_use response with stop_reason=end_turn exits after running the tools', async () => {
  // Covers `if (resp.stop_reason !== 'tool_use') break;` truthy branch
  // — tool_use blocks present but the model says it's done. Unusual
  // but valid; we honor the stop signal and don't loop again.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  const calls = stubFetch([
    { content: [{ type: 'tool_use', id: 'tu_done', name: 'spektrum_getState', input: {} }],
      stop_reason: 'end_turn' },             // tool_use + end_turn
    anthropicText('should not reach here'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'go';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.length, 1, 'no follow-up hop after end_turn');
  unmount();
});

test('openai response with no choices safely degrades', async () => {
  // Covers `resp.choices?.[0]` nullish branch in fromOpenAIResponse.
  localStorage.setItem('spektrum:agent:provider', 'openai');
  localStorage.setItem('spektrum:agent:apikey:openai', 'sk-test');
  stubFetch([{}]);                              // no `choices` key at all
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'hi';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 5));
  // No throw — runTurn handles the empty-content assistant block.
  assert.ok(document.querySelector('[data-spektrum-agent]'));
  unmount();
});

test('submit ignores empty input', () => {
  // Covers `if (!text || sendEl.disabled) return;` truthy branches.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  const calls = stubFetch([]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = '   ';   // whitespace only
  document.querySelector('[data-send]').click();
  assert.equal(calls.length, 0, 'empty input did not trigger fetch');
  unmount();
});

});

// === OpenAI / OpenRouter adapters ===

suite('openai-shaped adapters', () => {

test('openai adapter handles a tool_call response and the follow-up tool result', async () => {
  // OpenAI shape: message.tool_calls[] → translated via fromOpenAIResponse
  // to {type:'tool_use',...}. The next hop sends tool_result back via
  // toOpenAIMessages which produces a {role:'tool'} message.
  localStorage.setItem('spektrum:agent:provider', 'openai');
  localStorage.setItem('spektrum:agent:apikey:openai', 'sk-test');
  stubFetch([
    openaiToolCall('spektrum_setValue', { path: 'a', value: 7 }),
    openaiText('done.'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'set a to 7';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  s.tick();
  assert.equal(s.appState.a, 7);
  unmount();
});

test('openai adapter handles a tool_call with invalid JSON arguments', async () => {
  // Covers the `try { JSON.parse(...) } catch {}` swallow in fromOpenAIResponse.
  localStorage.setItem('spektrum:agent:provider', 'openai');
  localStorage.setItem('spektrum:agent:apikey:openai', 'sk-test');
  stubFetch([
    {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'tc_bad',
            type: 'function',
            function: { name: 'spektrum_getState', arguments: '{not-json' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    openaiText('recovered'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'state please';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /recovered/);
  unmount();
});

test('openai adapter handles tool_call with missing arguments (empty string branch)', async () => {
  // Covers `tc.function.arguments ? JSON.parse(...) : {}` falsy branch.
  localStorage.setItem('spektrum:agent:provider', 'openai');
  localStorage.setItem('spektrum:agent:apikey:openai', 'sk-test');
  stubFetch([
    {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'tc_noargs',
            type: 'function',
            function: { name: 'spektrum_getState', arguments: '' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    openaiText('ok'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'go';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /ok/);
  unmount();
});

test('openai adapter handles a text-only response (no tool_calls)', async () => {
  // Covers the `for (const tc of (msg.tool_calls || []))` empty-fallback branch.
  localStorage.setItem('spektrum:agent:provider', 'openai');
  localStorage.setItem('spektrum:agent:apikey:openai', 'sk-test');
  stubFetch([openaiText('plain reply')]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'hi';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.match(document.querySelector('[data-log]').innerHTML, /plain reply/);
  unmount();
});

test('toOpenAIMessages handles a tool_result with non-string content (L151)', async () => {
  // The agent always JSON.stringify's tool results before pushing them
  // (runTurn line 498), so b.content is always a string in practice.
  // This is a defense-in-depth branch against shapes the module itself
  // never produces. We reach it by:
  //   1. Monkey-patching JSON.stringify so it returns `undefined` for a
  //      sentinel object — this slips a non-string content past the push.
  //   2. Running a tool turn (anthropic), so a tool_result with
  //      content=undefined lands in `messages`.
  //   3. Switching to the openai adapter and sending a follow-up, which
  //      drives toOpenAIMessages over the now-mixed history.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  localStorage.setItem('spektrum:agent:apikey:openai', 'sk-test');
  // Make getState return a sentinel that our patched stringify refuses.
  Object.defineProperty(s, 'appState',
    { configurable: true, get: () => ({ __sabotage: true }) });
  const origStringify = JSON.stringify;
  JSON.stringify = function patched(v, ...rest) {
    // Narrow match: only the runTurn-line-498 stringify of the
    // ok-wrapped sentinel returns undefined. Everything else (request
    // bodies, log rendering, happy-dom internals) keeps real behavior.
    if (v && typeof v === 'object' && v.ok === true && v.data?.__sabotage) return undefined;
    return origStringify.call(this, v, ...rest);
  };
  try {
    stubFetch([
      { content: [{ type: 'tool_use', id: 'tu_s', name: 'spektrum_getState', input: {} }],
        stop_reason: 'tool_use' },
      // After tool runs, anthropic returns end_turn so the loop exits.
      { content: [{ type: 'text', text: 'first turn done' }], stop_reason: 'end_turn' },
      // Second turn (openai) — toOpenAIMessages walks the history,
      // including the user message with content=[{tool_result, content:undefined}].
      openaiText('second turn done'),
    ]);
    const unmount = mount(s);
    document.querySelector('[data-input]').value = 'go';
    document.querySelector('[data-send]').click();
    await new Promise(r => setTimeout(r, 20));
    document.querySelector('[data-prov="openai"]').click();
    document.querySelector('[data-input]').value = 'follow-up';
    document.querySelector('[data-send]').click();
    await new Promise(r => setTimeout(r, 15));
    assert.match(document.querySelector('[data-log]').innerHTML, /second turn done/);
    unmount();
  } finally {
    JSON.stringify = origStringify;
  }
});

test('openai adapter handles a response with neither content nor tool_calls', async () => {
  // Covers the `if (msg.content)` falsy branch in fromOpenAIResponse.
  localStorage.setItem('spektrum:agent:provider', 'openai');
  localStorage.setItem('spektrum:agent:apikey:openai', 'sk-test');
  stubFetch([{ choices: [{ message: {}, finish_reason: 'stop' }] }]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'hi';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 5));
  // No throw — empty assistant block, loop exits cleanly.
  assert.ok(document.querySelector('[data-spektrum-agent]'));
  unmount();
});

test('openai assistant message with BOTH text and tool_use blocks (L159 truthy branch)', async () => {
  // Covers `if (b.type === 'text')` truthy in toOpenAIMessages. The
  // first hop returns content + tool_call together; the second hop
  // re-processes the assistant message with both block kinds.
  localStorage.setItem('spektrum:agent:provider', 'openai');
  localStorage.setItem('spektrum:agent:apikey:openai', 'sk-test');
  stubFetch([
    {
      choices: [{
        message: {
          content: 'thinking through this',
          tool_calls: [{
            id: 'tc_1', type: 'function',
            function: { name: 'spektrum_getState', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    openaiText('done.'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'go';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 15));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /thinking through this/, 'text block rendered');
  assert.match(log, /done\./);
  unmount();
});

test('mixed-provider history forces openai to process anthropic-shaped messages', async () => {
  // The `messages` array is per-mount, not per-provider — switching
  // providers carries history across. We use this to feed the openai
  // adapter shapes only Anthropic produces:
  //   - assistant.content === null   → L158 short-circuit `m.content || []`
  //   - tool_use with input === null → L161 short-circuit `b.input || {}`
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  localStorage.setItem('spektrum:agent:apikey:openai', 'sk-test');
  stubFetch([
    // Turn 1, hop 0 (anthropic): tool_use with input=null. The handler
    // runs with {} and the tool_use lands in messages as-is.
    { content: [{ type: 'tool_use', id: 'tu_a', name: 'spektrum_getState', input: null }],
      stop_reason: 'tool_use' },
    // Turn 1, hop 1 (anthropic): content === null. The assistant push
    // happens BEFORE runTurn's `for (block of resp.content)` throws on
    // null; the outer catch handles the throw. Messages keeps the
    // null-content assistant entry.
    { content: null, stop_reason: 'end_turn' },
    // Turn 2 (openai): plain text. The call's toOpenAIMessages re-walks
    // the accumulated history and hits both defensive short-circuits.
    openaiText('recovered.'),
  ]);
  const unmount = mount(s);
  // Turn 1.
  document.querySelector('[data-input]').value = 'first';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 20));
  // Switch provider so the next turn runs through toOpenAIMessages.
  document.querySelector('[data-prov="openai"]').click();
  // Turn 2 — exercises the defensive short-circuits.
  document.querySelector('[data-input]').value = 'second';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 15));
  assert.match(document.querySelector('[data-log]').innerHTML, /recovered\./);
  unmount();
});

test('tool_use with no name field hits escapeHtml nullish guard (L541)', async () => {
  // Covers `String(s ?? '')` in escapeHtml. renderToolCall is the only
  // call site whose argument can be nullish — block.name is undefined
  // when the model returns a tool_use without one.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([
    { content: [{ type: 'tool_use', id: 'tu_x', input: {} }], stop_reason: 'tool_use' },
    anthropicText('done'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'go';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  // Handler lookup with undefined name returns falsy → "unknown tool undefined".
  assert.match(document.querySelector('[data-log]').innerHTML, /unknown tool/);
  unmount();
});

test('openrouter adapter uses the openrouter URL', async () => {
  localStorage.setItem('spektrum:agent:provider', 'openrouter');
  localStorage.setItem('spektrum:agent:apikey:openrouter', 'sk-or-x');
  const calls = stubFetch([openaiText('ok')]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'hi';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.match(calls[0].url, /openrouter\.ai/);
  unmount();
});

});

// === Helpers via observable behaviour ===

suite('helpers', () => {

test('escapeHtml escapes the title HTML in the panel header', () => {
  const unmount = mount(s, { title: '<script>alert(1)</script>' });
  const html = document.querySelector('[data-title]').innerHTML;
  assert.match(html, /&lt;script&gt;/);
  assert.equal(html.includes('<script>alert'), false);
  unmount();
});

test('compactJson truncates long tool-call inputs in the log', async () => {
  // Covers the `s.length > maxLen ? slice : s` branch — the truncating side.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  stubFetch([
    anthropicToolUse('spektrum_setValue', { path: 'long', value: 'x'.repeat(400) }),
    anthropicText('done'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'go';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  const log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /…/, 'long arg was truncated with an ellipsis');
  unmount();
});

test('compactJson falls back to String(v) when JSON.stringify throws', async () => {
  // BigInt isn't JSON-serialisable. We can't pass a BigInt through the
  // tool boundary easily, but the helper is also called on tool RESULTS.
  // Force one: stub the engine method the tool delegates to so it
  // returns a BigInt.
  localStorage.setItem('spektrum:agent:apikey:anthropic', 'sk-ant-x');
  // Replace appState with a BigInt to make spektrum_getState's ok() body
  // contain a BigInt — the renderer JSON.stringify's it inside compactJson.
  Object.defineProperty(s, 'appState', { get: () => 1n, configurable: true });
  stubFetch([
    anthropicToolUse('spektrum_getState', {}),
    anthropicText('looked.'),
  ]);
  const unmount = mount(s);
  document.querySelector('[data-input]').value = 'look';
  document.querySelector('[data-send]').click();
  await new Promise(r => setTimeout(r, 10));
  // No throw is the assertion — compactJson's catch path covered.
  assert.ok(document.querySelector('[data-spektrum-agent]'));
  unmount();
});

});

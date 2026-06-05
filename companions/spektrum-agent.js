/*
  Spektrum Agent — in-page LLM assistant that drives a Spektrum
  instance via the agent surface (describe / explain / setValue /
  attempt / findByIntent / replay / serialize).

  The companion to spektrum-devtools.js: where devtools gives a human
  a scrubber, this gives an LLM a full operational surface inside the
  page. The agent runs inside the browser tab — no MCP server, no
  bridge — using direct fetch() against the configured provider's API.

  Standalone module, zero deps. Reuses createTools() from
  spektrum-mcp so the agent and any external MCP integration share
  the same vocabulary.

  Providers supported (set via the panel's settings cog):
    - anthropic  (Anthropic Messages API; default model claude-haiku-4-5)
    - openai     (OpenAI Chat Completions; default gpt-4o-mini)
    - openrouter (OpenAI-compatible; default anthropic/claude-sonnet-4.6)

  OpenRouter is the most reliable choice for direct browser use — it
  proxies to dozens of model providers behind a single OpenAI-shaped
  endpoint with permissive CORS. Anthropic enables direct browser
  access via the `anthropic-dangerous-direct-browser-access` header.
  OpenAI's CORS posture varies; if your direct fetch is blocked, fall
  back to OpenRouter or proxy through your own backend.

  Usage:

    import { mount } from 'spektrum/agent';
    const unmount = mount(spektrum, {
      provider: 'anthropic',                 // optional; panel UI also sets this
      apiKey:   '<key>',                     // optional; panel prompts otherwise
      model:    'claude-haiku-4-5',          // optional; provider default applies
      position: 'bottom-left',
    });

  If `apiKey` is omitted the panel prompts the user to paste one. Keys
  are stored per-provider in localStorage so switching providers
  doesn't lose your other keys. Treat this as a development affordance
  — production deployments should proxy through your own backend
  rather than ship API keys to the browser.

  Security: the agent has the same authority over the engine as any
  caller of setValue/trigger. It cannot escape into the wider page.
  But it CAN make any state mutation your app exposes — only mount
  it when you accept that.
*/

import { createTools } from './spektrum-mcp.js';

// === Styling — matches the devtools panel aesthetic ===

const STYLES = `
  position: fixed;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  background: rgba(15, 15, 16, 0.96);
  color: #ddd;
  border: 1px solid #2a2a2e;
  border-radius: 6px;
  width: min(360px, calc(100vw - 24px));
  height: min(540px, calc(100vh - 48px));
  backdrop-filter: blur(6px);
`;

const corners = {
  'top-right':    'top: 12px; right: 12px;',
  'top-left':     'top: 12px; left: 12px;',
  'bottom-right': 'bottom: 12px; right: 12px;',
  'bottom-left':  'bottom: 12px; left: 12px;',
};

// Anthropic API constraint: tool names match /^[a-zA-Z0-9_-]{1,64}$/.
// OpenAI uses the same constraint. Our MCP catalog uses dotted names
// ('spektrum.attempt.start'); translate at the boundary.
const toApiName = (n) => n.replace(/\./g, '_');

const STORAGE_PREFIX = 'spektrum:agent:';
const PROVIDER_KEY = STORAGE_PREFIX + 'provider';
const keyOf   = (p) => STORAGE_PREFIX + 'apikey:' + p;
const modelOf = (p) => STORAGE_PREFIX + 'model:'  + p;

const SYSTEM_PROMPT =
  `You are an in-page assistant operating a Spektrum reactive engine inside the user's browser. ` +
  `You have tools to read state (spektrum_getState, spektrum_describe, spektrum_serialize), ` +
  `locate UI by intent (spektrum_findByIntent), mutate state (spektrum_setValue, spektrum_trigger, spektrum_checkpoint), ` +
  `run speculative attempts that can be committed or discarded (spektrum_attempt_start / _commit / _discard), ` +
  `scrub time (spektrum_replay), and explain causality (spektrum_explain).\n\n` +
  `On the first interaction in a session, call spektrum_describe to learn the app's state shape, registered verbs (fns), and semantic intents. ` +
  `Then act with the tools — don't just describe what you would do. Be concise: one or two sentences before each tool call, and a short summary at the end. ` +
  `Prefer setValue over trigger unless the user asks for an additive change. ` +
  `When the user describes an action ("add a banana", "undo", "show me what's in the cart") translate it into the right tools, don't ask for permission for every step.`;

// === Provider adapters ===
//
// Each provider's `complete()` accepts a normalized request and
// returns a normalized response in Anthropic content-block shape:
//
//   request:  { apiKey, model, system, messages, tools }
//     messages: [{role:'user'|'assistant', content: string | block[]}]
//     tools:    [{name, description, inputSchema}]
//   response: { content: block[], stop_reason: 'tool_use'|'end_turn'|... }
//     block: {type:'text',text} | {type:'tool_use',id,name,input}
//
// Internal conversation state is kept in this normalized shape; the
// OpenAI adapter translates to/from native shapes at the boundary.

const fetchJson = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url.split('/').slice(-2).join('/')} ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
};

// --- Anthropic ---

const anthropicAdapter = {
  defaultModel: 'claude-haiku-4-5',
  keyHint: 'sk-ant-…',
  async complete({ apiKey, model, system, messages, tools }) {
    return fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model, system, messages, max_tokens: 4096,
        tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      }),
    });
  },
};

// --- OpenAI / OpenRouter (shared shape) ---

const toOpenAIMessages = (system, messages) => {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      // user content is either a string (plain user turn) or an array
      // of {type:'tool_result',...} blocks (response to tool calls).
      if (typeof m.content === 'string') { out.push({ role: 'user', content: m.content }); continue; }
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
        }
      }
    } else if (m.role === 'assistant') {
      // collect text + tool_use blocks into one assistant message
      const textParts = [];
      const toolCalls = [];
      for (const b of (m.content || [])) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
        }
      }
      const msg = { role: 'assistant', content: textParts.join('\n') || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
};

const fromOpenAIResponse = (resp) => {
  const choice = resp.choices?.[0];
  const msg = choice?.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of (msg.tool_calls || [])) {
    let input = {};
    try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch {}
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  // Map OpenAI finish_reason → Anthropic-flavored stop_reason.
  const stop_reason = choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return { content, stop_reason };
};

const openaiToolSpec = (tools) => tools.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

// Both OpenAI and OpenRouter speak the same chat-completions shape;
// only URL + a couple of attribution headers differ. One factory.
const openaiCall = (url, extraHeaders) => async ({ apiKey, model, system, messages, tools }) => {
  const resp = await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey, ...extraHeaders },
    body: JSON.stringify({
      model, messages: toOpenAIMessages(system, messages), tools: openaiToolSpec(tools), max_tokens: 4096,
    }),
  });
  return fromOpenAIResponse(resp);
};

const openaiAdapter = {
  defaultModel: 'gpt-4o-mini',
  keyHint: 'sk-…',
  complete: openaiCall('https://api.openai.com/v1/chat/completions'),
};

const openrouterAdapter = {
  defaultModel: 'anthropic/claude-sonnet-4.6',
  keyHint: 'sk-or-…',
  // OpenRouter uses HTTP-Referer / X-Title for attribution + rankings.
  complete: openaiCall('https://openrouter.ai/api/v1/chat/completions', {
    'http-referer': location.origin,
    'x-title': 'Spektrum Agent',
  }),
};

const PROVIDERS = {
  anthropic:  anthropicAdapter,
  openai:     openaiAdapter,
  openrouter: openrouterAdapter,
};

// === Mount ===

/**
 * Mount the agent panel for a Spektrum instance.
 *
 * @param {object} spektrum - instance from createSpektrum() or default singleton
 * @param {object} [opts]
 * @param {'anthropic'|'openai'|'openrouter'} [opts.provider] - default provider; user can switch in the panel.
 * @param {string} [opts.apiKey] - API key for the chosen provider. If omitted, panel prompts (stored in localStorage).
 * @param {string} [opts.model] - model id; provider default applies if omitted.
 * @param {'top-right'|'top-left'|'bottom-right'|'bottom-left'} [opts.position='bottom-left']
 * @param {Element} [opts.parent=document.body]
 * @param {string} [opts.title='spektrum agent']
 * @param {string} [opts.system] - override the system prompt entirely.
 * @param {Array<string|RegExp>} [opts.protectedPaths] - paths the agent may not write. Forwarded to the internal createTools() call; denied writes return an error to the model. When set, a sentence enumerating the protected paths is appended to the system prompt so the model knows up-front (saves wasted tool calls). Use to keep agent-driven mutations out of sensitive state like API keys.
 * @param {boolean} [opts.allowAllPaths] - explicit acknowledgement that the agent may write anywhere. Forwarded to createTools() to silence the unrestricted-write safety warning when full access is intended.
 * @returns {() => void} unmount
 */
export const mount = (spektrum, opts = {}) => {
  const parent = opts.parent || document.body;
  const position = opts.position || 'bottom-left';
  const title = opts.title || 'spektrum agent';
  const protectedPaths = opts.protectedPaths;
  // Tell the model its write limits up-front so it doesn't waste tool
  // calls on rejected writes. Three cases, matching createTools':
  // specific paths fenced, everything fenced (read-only default), or
  // unrestricted.
  const guardNote = protectedPaths && protectedPaths.length
    ? `\n\nYou may NOT write to these paths (writes will be rejected): ${protectedPaths.map(p => p instanceof RegExp ? p.toString() : p).join(', ')}. Don't attempt them.`
    : opts.allowAllPaths
      ? ''
      : '\n\nYou have READ-ONLY access: state-writing tools (setValue, trigger, attempt) will be rejected. Use them only to read, describe, explain, and replay.';
  const system = opts.system || (SYSTEM_PROMPT + guardNote);

  // Provider + key + model are stored per-provider so switching back
  // doesn't lose anything. Initial values: explicit opts override
  // localStorage override the Anthropic default.
  let provider = opts.provider || localStorage.getItem(PROVIDER_KEY) || 'anthropic';
  if (!PROVIDERS[provider]) provider = 'anthropic';

  const seedKey = (p, v) => { if (v && !localStorage.getItem(keyOf(p))) localStorage.setItem(keyOf(p), v); };
  if (opts.apiKey) seedKey(provider, opts.apiKey);
  if (opts.model)  localStorage.setItem(modelOf(provider), opts.model);

  const currentKey   = () => localStorage.getItem(keyOf(provider))   || '';
  const currentModel = () => localStorage.getItem(modelOf(provider)) || PROVIDERS[provider].defaultModel;

  // Build the tool catalog once. We translate dotted MCP names to
  // API-legal underscored names for both providers. `protectedPaths`
  // forwards straight to the MCP layer — that's where the gate lives;
  // the in-page panel just surfaces the option and the prompt note.
  const tools = createTools(spektrum, { protectedPaths, allowAllPaths: opts.allowAllPaths }).map(t => ({
    name: toApiName(t.name),
    description: t.description,
    inputSchema: t.inputSchema,
    handler: t.handler,
  }));
  const handlerByName = Object.fromEntries(tools.map(t => [t.name, t.handler]));

  // === DOM ===

  // Dock integration: if a dock is mounted, render inside it as a tab
  // instead of as a free-floating panel. Skip our own corner placement;
  // the dock owns layout. Detected by DOM query — no import needed.
  const dock = document.querySelector('[data-spektrum-dock]')?._spektrumDock;
  let dockPanel = null;
  const root = document.createElement('div');
  root.setAttribute('data-spektrum-agent', '');
  if (dock) {
    dockPanel = dock.registerPanel({ id: 'agent', label: 'Agent', onClose: () => unmount() });
    // Inside the dock: flat, fills the container; the dock provides
    // border, shadow, and positioning.
    root.style.cssText = 'position:static;width:auto;height:100%;border:0;border-radius:0;background:transparent;box-shadow:none;display:flex;flex-direction:column;';
  } else {
    root.style.cssText = STYLES + (corners[position] || corners['bottom-left']);
  }

  root.innerHTML = `
    <div data-header style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a2a2e;">
      <strong data-title style="flex:1;font-size:10px;letter-spacing:0.18em;color:#888;font-weight:normal;cursor:pointer;"></strong>
      <button data-cog title="provider settings" style="background:transparent;border:1px solid #36363c;color:#888;border-radius:3px;padding:1px 6px;font:inherit;cursor:pointer;font-size:11px;">⚙</button>
      <span data-toggle style="color:#888;font-size:10px;cursor:pointer;">▾</span>
    </div>
    <div data-body style="display:flex;flex-direction:column;flex:1;min-height:0;">
      <div data-settings style="display:none;padding:10px 12px;border-bottom:1px solid #2a2a2e;background:rgba(40,40,46,0.4);">
        <div style="display:flex;gap:4px;margin-bottom:8px;">
          <button data-prov="anthropic"  style="flex:1;padding:4px 6px;font:inherit;font-size:10px;border-radius:3px;cursor:pointer;">anthropic</button>
          <button data-prov="openai"     style="flex:1;padding:4px 6px;font:inherit;font-size:10px;border-radius:3px;cursor:pointer;">openai</button>
          <button data-prov="openrouter" style="flex:1;padding:4px 6px;font:inherit;font-size:10px;border-radius:3px;cursor:pointer;">openrouter</button>
        </div>
        <input data-model type="text" placeholder="model"
               style="width:100%;padding:5px 8px;background:#1a1a1c;border:1px solid #36363c;color:#ddd;border-radius:3px;font:inherit;margin-bottom:6px;">
        <input data-key type="password" placeholder="api key" autocomplete="off"
               style="width:100%;padding:5px 8px;background:#1a1a1c;border:1px solid #36363c;color:#ddd;border-radius:3px;font:inherit;margin-bottom:6px;">
        <div style="display:flex;gap:6px;">
          <button data-save style="flex:1;padding:5px;background:#26262a;border:1px solid #36363c;color:#ddd;border-radius:3px;font:inherit;cursor:pointer;">save</button>
          <button data-clear title="clear stored key for this provider" style="padding:5px 10px;background:transparent;border:1px solid #36363c;color:#888;border-radius:3px;font:inherit;cursor:pointer;">clear</button>
        </div>
        <div style="font-size:10px;color:#666;margin-top:8px;line-height:1.5;">Keys stored in localStorage per provider. Dev-only convenience — proxy through your own backend in production.</div>
      </div>
      <div data-log style="flex:1;overflow-y:auto;padding:10px 12px;line-height:1.5;"></div>
      <div data-input-row style="border-top:1px solid #2a2a2e;padding:8px;display:flex;gap:6px;">
        <textarea data-input rows="2" placeholder="ask the agent to do something…"
                  style="flex:1;padding:6px 8px;background:#1a1a1c;border:1px solid #36363c;color:#ddd;border-radius:3px;font:inherit;resize:none;"></textarea>
        <button data-send style="padding:6px 12px;background:#26262a;border:1px solid #36363c;color:#ddd;border-radius:3px;font:inherit;cursor:pointer;">send</button>
      </div>
    </div>
  `;
  if (dockPanel) dockPanel.container.appendChild(root);
  else parent.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const titleEl    = $('[data-title]');
  const cogEl      = $('[data-cog]');
  const toggleEl   = $('[data-toggle]');
  const bodyEl     = $('[data-body]');
  const settingsEl = $('[data-settings]');
  const modelEl    = $('[data-model]');
  const keyEl      = $('[data-key]');
  const saveEl     = $('[data-save]');
  const clearEl    = $('[data-clear]');
  const logEl      = $('[data-log]');
  const inputEl    = $('[data-input]');
  const sendEl     = $('[data-send]');
  const provBtns   = root.querySelectorAll('[data-prov]');

  // --- Settings UI sync ---

  const refreshTitle = () => {
    titleEl.innerHTML = `${escapeHtml(title)} <span style="color:#444;">·</span> <span style="color:#666;">${escapeHtml(provider)}</span> <span style="color:#444;">·</span> <span style="color:#666;">${escapeHtml(currentModel())}</span>`;
  };
  const refreshSettings = () => {
    for (const b of provBtns) {
      const active = b.dataset.prov === provider;
      b.style.background    = active ? '#26262a' : 'transparent';
      b.style.borderColor   = active ? '#4ade80' : '#36363c';
      b.style.color         = active ? '#ddd' : '#888';
      b.style.border        = '1px solid ' + (active ? '#4ade80' : '#36363c');
    }
    modelEl.value = currentModel();
    keyEl.value = currentKey() ? '••••••••' : '';
    keyEl.placeholder = `api key (${PROVIDERS[provider].keyHint})`;
    const enabled = !!currentKey();
    inputEl.disabled = sendEl.disabled = !enabled;
    refreshTitle();
  };
  // Open settings on first mount when no key configured for any provider.
  const anyKey = Object.keys(PROVIDERS).some(p => localStorage.getItem(keyOf(p)));
  let settingsOpen = !anyKey;
  const renderSettingsVisibility = () => { settingsEl.style.display = settingsOpen ? 'block' : 'none'; };
  renderSettingsVisibility();
  refreshSettings();

  cogEl.addEventListener('click', (ev) => {
    ev.stopPropagation();
    settingsOpen = !settingsOpen;
    renderSettingsVisibility();
    if (settingsOpen) keyEl.focus();
  });

  for (const b of provBtns) {
    b.addEventListener('click', () => {
      provider = b.dataset.prov;
      localStorage.setItem(PROVIDER_KEY, provider);
      refreshSettings();
    });
  }

  saveEl.addEventListener('click', () => {
    const m = modelEl.value.trim();
    const k = keyEl.value.trim();
    if (m) localStorage.setItem(modelOf(provider), m);
    // Don't overwrite the stored key with the masked placeholder.
    if (k && k !== '••••••••') localStorage.setItem(keyOf(provider), k);
    settingsOpen = false;
    renderSettingsVisibility();
    refreshSettings();
    inputEl.focus();
  });

  clearEl.addEventListener('click', () => {
    localStorage.removeItem(keyOf(provider));
    refreshSettings();
    keyEl.focus();
  });

  // Collapse on title click
  let collapsed = false;
  titleEl.addEventListener('click', () => {
    collapsed = !collapsed;
    bodyEl.style.display = collapsed ? 'none' : 'flex';
    toggleEl.textContent = collapsed ? '▸' : '▾';
    root.style.height = collapsed ? 'auto' : 'min(540px, calc(100vh - 48px))';
  });

  // === Conversation state ===

  /** @type {Array<{role: 'user'|'assistant', content: any}>} */
  const messages = [];

  // === Rendering ===

  const append = (html) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    return div;
  };

  const renderUser = (text) => append(`
    <div style="margin-bottom:10px;">
      <span style="color:#4ade80;">›</span>
      <span style="color:#ddd;">${escapeHtml(text)}</span>
    </div>
  `);

  const renderAssistantText = (text) => {
    if (!text.trim()) return null;
    return append(`<div style="color:#aaa;margin-bottom:8px;white-space:pre-wrap;">${escapeHtml(text)}</div>`);
  };

  const renderToolCall = (name, input) => append(`
    <div style="margin-bottom:6px;color:#666;font-size:10px;">
      <span style="color:#60a5fa;">→</span>
      <span style="color:#888;">${escapeHtml(name)}</span><span style="color:#444;">(${escapeHtml(compactJson(input))})</span>
    </div>
  `);

  const renderToolResult = (result, isError) => append(`
    <div style="margin:-4px 0 8px 14px;color:${isError ? '#ef4444' : '#4ade80'};font-size:10px;">
      <span>${isError ? '✗' : '✓'}</span>
      <span style="color:#666;">${escapeHtml(compactJson(result, 80))}</span>
    </div>
  `);

  const renderError = (text) => append(`<div style="color:#ef4444;margin-bottom:8px;">⚠ ${escapeHtml(text)}</div>`);

  const renderThinking = () => {
    const el = append(`<div style="color:#666;font-style:italic;margin-bottom:8px;">thinking…</div>`);
    return () => el.remove();
  };

  // === Tool loop ===

  const runTurn = async (userText) => {
    renderUser(userText);
    messages.push({ role: 'user', content: userText });

    inputEl.disabled = sendEl.disabled = true;
    const stop = renderThinking();

    try {
      const adapter = PROVIDERS[provider];
      const apiKey = currentKey();
      const model = currentModel();
      if (!apiKey) throw new Error(`no API key for ${provider} — open ⚙ to add one`);

      // Loop: call model, execute tool_use blocks, append tool_results,
      // call again. Bounded at 8 hops to avoid runaway tool chains.
      for (let hop = 0; hop < 8; hop++) {
        const resp = await adapter.complete({ apiKey, model, system, messages, tools });

        // Append assistant message verbatim so subsequent hops see it.
        messages.push({ role: 'assistant', content: resp.content });

        // Render text + execute tool_uses, collect tool_results.
        const toolResults = [];
        for (const block of resp.content) {
          if (block.type === 'text') renderAssistantText(block.text);
          else if (block.type === 'tool_use') {
            renderToolCall(block.name, block.input);
            const handler = handlerByName[block.name];
            let result, isError = false;
            try {
              result = handler ? await handler(block.input || {}) : { error: `unknown tool ${block.name}` };
              if (!handler) isError = true;
            } catch (err) {
              result = { error: err?.message || String(err) };
              isError = true;
            }
            renderToolResult(result, isError);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
              is_error: isError || undefined,
            });
          }
        }

        if (toolResults.length === 0) break; // no tools called → final answer
        messages.push({ role: 'user', content: toolResults });

        if (resp.stop_reason !== 'tool_use') break;
      }
    } catch (err) {
      renderError(err?.message || String(err));
    } finally {
      stop();
      inputEl.disabled = sendEl.disabled = false;
      inputEl.focus();
    }
  };

  // === Input wiring ===

  const submit = () => {
    const text = inputEl.value.trim();
    if (!text || sendEl.disabled) return;
    inputEl.value = '';
    runTurn(text);
  };

  sendEl.addEventListener('click', submit);
  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
  });

  // Greeting
  append(`<div style="color:#666;margin-bottom:10px;">${currentKey() ? 'Ready. Try: <em style="color:#888;">"what does this app do?"</em>' : 'Pick a provider and paste an API key in ⚙ to begin.'}</div>`);

  const unmount = () => { root.remove(); dockPanel?.detach(); };
  return unmount;
};

// === Helpers ===

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const compactJson = (v, maxLen = 200) => {
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  if (s == null) return String(v);
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
};

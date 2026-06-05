/*
  Tests for spektrum/mcp — the SDK-agnostic tool catalog that exposes a
  Spektrum instance as MCP tools. The module is DOM-free except for
  findByIntent (which we exercise with happy-dom).

  Each tool returns a plain JSON-shaped result: { ok: true, data } on
  success, or { ok: false, error } when a speculative attempt id is
  unknown.
*/

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

import { test, suite, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSpektrum } from '../spektrum.js';
import { createTools } from '../companions/spektrum-mcp.js';

let s;
let tools;
const byName = (name) => tools.find(t => t.name === name);

beforeEach(() => {
  document.body.innerHTML = '';
  s = createSpektrum();
  // allowAllPaths acknowledges the ungated catalog so the harness
  // doesn't trip the unrestricted-write safety warning on every test.
  // The warning itself is covered in the 'safe-by-default' suite.
  tools = createTools(s, { allowAllPaths: true });
});

// === Catalog shape ===

suite('catalog', () => {

test('createTools returns the full catalog with default "spektrum." prefix', () => {
  const expected = [
    'spektrum.getState',
    'spektrum.describe',
    'spektrum.explain',
    'spektrum.setValue',
    'spektrum.trigger',
    'spektrum.checkpoint',
    'spektrum.attempt.start',
    'spektrum.attempt.commit',
    'spektrum.attempt.discard',
    'spektrum.replay',
    'spektrum.findByIntent',
    'spektrum.serialize',
  ];
  assert.deepEqual(tools.map(t => t.name).sort(), expected.sort());
});

test('opts.prefix overrides the namespace on every tool', () => {
  const t = createTools(s, { prefix: 'app/', allowAllPaths: true });
  assert.ok(t.every(x => x.name.startsWith('app/')));
  assert.ok(t.find(x => x.name === 'app/getState'));
});

test('opts.prefix="" produces unprefixed names', () => {
  // The `??` default only kicks in for nullish; empty string passes through.
  const t = createTools(s, { prefix: '', allowAllPaths: true });
  assert.ok(t.find(x => x.name === 'getState'));
});

test('every tool exposes { name, description, inputSchema, handler }', () => {
  for (const t of tools) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(typeof t.inputSchema, 'object');
    assert.equal(typeof t.handler, 'function');
    assert.equal(t.inputSchema.type, 'object');
  }
});

});

// === Read tools ===

suite('read tools', () => {

test('getState returns the live appState wrapped in ok envelope', () => {
  s.setValue('user.name', 'alice');
  s.tick();
  const res = byName('spektrum.getState').handler();
  assert.deepEqual(res, { ok: true, data: { user: { name: 'alice' } } });
});

test('describe returns the manifest from spektrum.describe()', () => {
  s.defineFn('hit', () => {});
  const res = byName('spektrum.describe').handler();
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.data.systems));
  assert.ok(res.data.fns.find(f => f.name === 'hit'), 'manifest includes registered fns');
});

test('explain with no args returns the full history trace', () => {
  s.setValue('x', 1);
  s.setValue('y', 2);
  s.tick();
  const res = byName('spektrum.explain').handler();
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 2);
});

test('explain honours from/to slice arguments', () => {
  s.setValue('a', 1);
  s.setValue('b', 2);
  s.setValue('c', 3);
  s.tick();
  const res = byName('spektrum.explain').handler({ from: 1, to: 2 });
  assert.equal(res.data.length, 1);
});

});

// === Write tools ===

suite('write tools', () => {

test('setValue lands the value and returns the new cursor', () => {
  const res = byName('spektrum.setValue').handler({ path: 'count', value: 5 });
  s.tick();
  assert.equal(s.appState.count, 5);
  assert.deepEqual(res, { ok: true, data: { cursor: s.cursor } });
});

test('setValue accepts an optional id', () => {
  byName('spektrum.setValue').handler({ path: 'flag', value: true, id: 'init-flag' });
  s.tick();
  assert.equal(s.history.at(-1).id, 'init-flag');
});

test('trigger records an additive numeric change', () => {
  s.setValue('count', 10);
  s.tick();
  byName('spektrum.trigger').handler({ id: 'inc', path: 'count', value: 5 });
  s.tick();
  assert.equal(s.appState.count, 15);
});

test('checkpoint marks a tagged boundary in history', () => {
  const res = byName('spektrum.checkpoint').handler({ name: 'cp-a', metadata: { tag: 'ok' } });
  assert.equal(res.ok, true);
  assert.equal(s.checkpoints.length, 1);
  assert.equal(s.checkpoints[0].id, 'cp-a');
  assert.deepEqual(s.checkpoints[0].value, { tag: 'ok' });
});

});

// === attempt.start / commit / discard ===

suite('attempt', () => {

test('attempt.start runs the actions and returns an id + cursor + state', () => {
  s.setValue('x', 0);
  s.tick();
  const res = byName('spektrum.attempt.start').handler({
    name: 'try-1',
    actions: [
      { op: 'set', path: 'x', value: 1 },
      { op: 'add', path: 'x', value: 4, id: 'bump' },
    ],
  });
  assert.equal(res.ok, true);
  assert.ok(res.data.id.startsWith('try-1:'), 'id is "<name>:<cursor>"');
  // attempt() doesn't auto-tick — verify the actions actually queued by ticking.
  s.tick();
  assert.equal(s.appState.x, 5);
});

test('attempt.start with op=checkpoint accepts an explicit name', () => {
  byName('spektrum.attempt.start').handler({
    name: 'A',
    actions: [
      { op: 'checkpoint', name: 'inner-marker', value: { tag: 'x' } },
    ],
  });
  assert.ok(s.checkpoints.some(c => c.id === 'inner-marker'));
});

test('attempt.start with op=checkpoint falls back to the attempt name', () => {
  // Covers the `a.name || name` short-circuit branch.
  byName('spektrum.attempt.start').handler({
    name: 'fallback-cp',
    actions: [
      { op: 'checkpoint' },                  // no inner name → uses 'fallback-cp'
    ],
  });
  assert.ok(s.checkpoints.some(c => c.id === 'fallback-cp'));
});

test('attempt.commit records the named commit and forgets the handle', () => {
  const start = byName('spektrum.attempt.start').handler({
    name: 'commit-me',
    actions: [{ op: 'set', path: 'k', value: 1 }],
  });
  const res = byName('spektrum.attempt.commit').handler({ id: start.data.id });
  assert.equal(res.ok, true);
  // After commit, a second commit on the same id fails — handle is gone.
  const again = byName('spektrum.attempt.commit').handler({ id: start.data.id });
  assert.deepEqual(again, { ok: false, error: 'unknown attempt id' });
});

test('attempt.discard rewinds the cursor and returns the rewound state', () => {
  s.setValue('k', 'before');
  s.tick();
  const start = byName('spektrum.attempt.start').handler({
    name: 'discard-me',
    actions: [{ op: 'set', path: 'k', value: 'inside' }],
  });
  s.tick();
  assert.equal(s.appState.k, 'inside');
  const res = byName('spektrum.attempt.discard').handler({ id: start.data.id });
  assert.equal(res.ok, true);
  assert.equal(s.appState.k, 'before', 'discard rewinds via replay()');
});

test('attempt.commit on an unknown id returns ok:false with an error message', () => {
  const res = byName('spektrum.attempt.commit').handler({ id: 'no-such-handle' });
  assert.deepEqual(res, { ok: false, error: 'unknown attempt id' });
});

test('attempt.discard on an unknown id returns ok:false', () => {
  const res = byName('spektrum.attempt.discard').handler({ id: 'ghost' });
  assert.deepEqual(res, { ok: false, error: 'unknown attempt id' });
});

});

// === time + UI ===

suite('replay / serialize / findByIntent', () => {

test('replay moves the cursor to the given index', () => {
  s.setValue('x', 1);
  s.setValue('x', 2);
  s.setValue('x', 3);
  s.tick();
  byName('spektrum.replay').handler({ n: 1 });
  assert.equal(s.cursor, 1);
  assert.equal(s.appState.x, 1);
});

test('serialize default returns state + history + cursor', () => {
  s.setValue('x', 1);
  s.tick();
  const res = byName('spektrum.serialize').handler();
  assert.equal(res.ok, true);
  assert.ok(res.data.state);
  assert.ok(Array.isArray(res.data.history));
});

test('serialize honours includeForks', () => {
  // Just confirm the option flows through — fork population requires
  // a scrubbed-back fork, which is exercised in engine tests.
  const res = byName('spektrum.serialize').handler({ includeForks: true });
  assert.equal(res.ok, true);
});

test('findByIntent returns element descriptors (tag, id, classes, dataset, text)', () => {
  document.body.innerHTML = `
    <button id="pay" class="primary big" data-intent="checkout.submit" data-foo="bar">Pay now</button>
    <a data-intent="checkout.submit">Skip</a>`;
  s.bindDOM(document.body);
  const res = byName('spektrum.findByIntent').handler({ name: 'checkout.submit' });
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 2);
  const btn = res.data.find(d => d.tag === 'button');
  assert.equal(btn.id, 'pay');
  assert.deepEqual(btn.classes, ['primary', 'big']);
  assert.equal(btn.dataset.foo, 'bar');
  assert.match(btn.text, /Pay now/);
});

test('findByIntent omits id/classes when the element has none', () => {
  document.body.innerHTML = `<a data-intent="nav.home"></a>`;
  s.bindDOM(document.body);
  const res = byName('spektrum.findByIntent').handler({ name: 'nav.home' });
  assert.equal(res.data[0].id, undefined);
  assert.equal(res.data[0].classes, undefined);
});

test('findByIntent truncates text content at 80 chars', () => {
  document.body.innerHTML = `<a data-intent="nav.home">${'X'.repeat(200)}</a>`;
  s.bindDOM(document.body);
  const res = byName('spektrum.findByIntent').handler({ name: 'nav.home' });
  assert.equal(res.data[0].text.length, 80);
});

test('findByIntent returns an empty array when no elements match', () => {
  const res = byName('spektrum.findByIntent').handler({ name: 'never.registered' });
  assert.deepEqual(res.data, []);
});

test('findByIntent describes element-shaped objects without a dataset', () => {
  // Covers the `el.dataset ? { ...el.dataset } : undefined` falsy branch.
  // Real DOM Elements always carry a dataset, so we stub findByIntent
  // with a plain object that mimics the shape but lacks one.
  s.findByIntent = () => [{ tagName: 'DIV', id: '', className: '', textContent: 'plain' }];
  const res = byName('spektrum.findByIntent').handler({ name: 'whatever' });
  assert.equal(res.data[0].tag, 'div');
  assert.equal(res.data[0].dataset, undefined);
});

});

// === protectedPaths gate (1.0.1) ===

suite('protectedPaths', () => {

const gatedTools = (patterns) => createTools(s, { protectedPaths: patterns });
const gatedBy = (gt, name) => gt.find(t => t.name === name);

test('no protectedPaths → write tools behave normally (default)', () => {
  // Catalog built in beforeEach (allowAllPaths, so still ungated); this
  // asserts that *not* passing protectedPaths leaves writes ungated even
  // for sensitive-looking names that would otherwise look protected.
  byName('spektrum.setValue').handler({ path: 'apiKey', value: 'secret' });
  s.tick();
  assert.equal(s.appState.apiKey, 'secret');
});

test('exact-string match denies setValue and skips the engine call', () => {
  const gt = gatedTools(['apiKey']);
  const res = gatedBy(gt, 'spektrum.setValue').handler({ path: 'apiKey', value: 'hacked' });
  s.tick();
  assert.deepEqual(res, { ok: false, error: 'protected: apiKey' });
  assert.equal(s.appState.apiKey, undefined);
  assert.equal(s.history.length, 0);
});

test('dot-segment prefix match covers nested paths (llm covers llm.apiKey)', () => {
  const gt = gatedTools(['llm']);
  const res = gatedBy(gt, 'spektrum.setValue').handler({ path: 'llm.apiKey', value: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /protected: llm\.apiKey/);
  s.tick();
  assert.equal(s.appState.llm, undefined);
});

test('prefix match does NOT swallow same-prefix unrelated keys (llm vs llmFoo)', () => {
  const gt = gatedTools(['llm']);
  const res = gatedBy(gt, 'spektrum.setValue').handler({ path: 'llmFoo', value: 1 });
  s.tick();
  assert.equal(res.ok, true);
  assert.equal(s.appState.llmFoo, 1);
});

test('RegExp pattern is honored', () => {
  const gt = gatedTools([/^llm\./]);
  const a = gatedBy(gt, 'spektrum.setValue').handler({ path: 'llm.apiKey', value: 'x' });
  const b = gatedBy(gt, 'spektrum.setValue').handler({ path: 'cart.total', value: 5 });
  s.tick();
  assert.equal(a.ok, false);
  assert.equal(b.ok, true);
  assert.equal(s.appState.cart.total, 5);
});

test('mixed string + RegExp patterns both apply', () => {
  const gt = gatedTools(['playerSelection', /^llm\./]);
  const x = gatedBy(gt, 'spektrum.setValue').handler({ path: 'playerSelection', value: 1 });
  const y = gatedBy(gt, 'spektrum.setValue').handler({ path: 'llm.model', value: 'gpt' });
  assert.equal(x.ok, false);
  assert.equal(y.ok, false);
});

test('trigger is gated the same way as setValue', () => {
  const gt = gatedTools(['locked']);
  s.setValue('locked', 10); s.tick();
  const res = gatedBy(gt, 'spektrum.trigger').handler({ id: 'inc', path: 'locked', value: 5 });
  s.tick();
  assert.deepEqual(res, { ok: false, error: 'protected: locked' });
  assert.equal(s.appState.locked, 10);  // unchanged
});

test('attempt.start refuses to start when any action targets a protected path', () => {
  const gt = gatedTools(['llm']);
  const beforeCursor = s.cursor;
  const res = gatedBy(gt, 'spektrum.attempt.start').handler({
    name: 'mixed',
    actions: [
      { op: 'set', path: 'cart.x', value: 1 },
      { op: 'set', path: 'llm.apiKey', value: 'leak' },
    ],
  });
  s.tick();
  assert.deepEqual(res, { ok: false, error: 'protected: llm.apiKey' });
  // The attempt never ran — neither the allowed nor the denied write
  // landed, and the cursor never moved past the prior tip.
  assert.equal(s.appState.cart, undefined);
  assert.equal(s.cursor, beforeCursor);
});

test('attempt.start with the "add" op is also gated on protected paths', () => {
  const gt = gatedTools(['secret']);
  const res = gatedBy(gt, 'spektrum.attempt.start').handler({
    name: 'add-secret',
    actions: [{ op: 'add', id: 'inc', path: 'secret', value: 1 }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /protected: secret/);
});

test('attempt.start with guard set but no action matching runs the attempt normally', () => {
  // Exercises the pre-check loop's fall-through: protectedPaths is
  // active, every action is inspected, none match, and the attempt
  // actually starts and mutates state. Also confirms `checkpoint` ops
  // are intentionally not gated (they don't write a path).
  const gt = gatedTools(['llm']);
  const res = gatedBy(gt, 'spektrum.attempt.start').handler({
    name: 'safe',
    actions: [
      { op: 'set', path: 'cart.x', value: 1 },
      { op: 'add', id: 'inc', path: 'count', value: 5 },
      { op: 'checkpoint', name: 'mid' },
    ],
  });
  s.tick();
  assert.equal(res.ok, true);
  assert.equal(s.appState.cart.x, 1);
  assert.equal(s.appState.count, 5);
  assert.ok(s.checkpoints.some(c => c.id === 'mid'));
});

});

// === safe-by-default posture ===
// Writes stay ungated by default (no breaking change), but creating an
// unguarded catalog without consciously acknowledging it warns loudly.
suite('safe-by-default', () => {

const captureWarn = (fn) => {
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try { fn(); } finally { console.warn = orig; }
  return warns;
};

test('ungated catalog (no protectedPaths, no allowAllPaths) warns', () => {
  const warns = captureWarn(() => createTools(s));
  assert.ok(
    warns.some(w => w.includes('[spektrum/mcp]') && w.includes('protectedPaths')),
    `expected an unrestricted-write warning; got: ${warns.join(' | ')}`,
  );
});

test('allowAllPaths: true acknowledges and silences the warning', () => {
  const warns = captureWarn(() => createTools(s, { allowAllPaths: true }));
  assert.deepEqual(warns, [], 'allowAllPaths should silence the warning');
});

test('protectedPaths present silences the warning (the gate speaks for itself)', () => {
  const warns = captureWarn(() => createTools(s, { protectedPaths: ['apiKey'] }));
  assert.deepEqual(warns, [], 'a gated catalog should not warn');
});

test('ungated catalog still grants full write access (no behavior break)', () => {
  const t = captureWarnTools();
  t.find(x => x.name === 'spektrum.setValue').handler({ path: 'apiKey', value: 'secret' });
  s.tick();
  assert.equal(s.appState.apiKey, 'secret');
});

// Build an ungated catalog while swallowing the (expected) warning.
function captureWarnTools() {
  let t;
  captureWarn(() => { t = createTools(s); });
  return t;
}

});

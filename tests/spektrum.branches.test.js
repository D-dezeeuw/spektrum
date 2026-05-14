/*
  Branch-coverage tests for spektrum.js. Each test targets a specific
  conditional branch that the behavior-driven test suite happens not
  to exercise — empty-attribute fast-paths, the `String(err)` fallback
  in addAsync's catch, applyClass's array form, and so on. Grouped
  here so the behavior tests stay focused on *behavior*; these are
  the engine's edge-case net.
*/

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import spektrum, {
  setValue, trigger, bindDOM, tick, reset,
  appState, getPathObj, defineFn, addAsync, explain, onRecord, onError, checkpoint,
  addSystem, describe,
} from '../spektrum.js';
import { setPathValue } from '../spektrum.js';

beforeEach(() => {
  const orig = console.warn;
  console.warn = () => {};
  try { reset(); } finally { console.warn = orig; }
  onError(null); onRecord(null);
  document.body.innerHTML = '';
});

// === parseValue branches (data-value coercion) ===

test('parseValue: data-value="true" → boolean true', () => {
  // Hits L107 — the `s === 'true'` literal coercion. Exercised through
  // the trigger built-in which calls parseValue on dataset.value.
  defineFn('keepTrue', (el, _s, _d, v) => setValue('flag', v, 'capture-true'));
  document.body.innerHTML = `<button data-action="click" data-fn="keepTrue" data-id="flag" data-value="true">x</button>`;
  bindDOM(document.body);
  document.body.querySelector('button').click();
  tick();
  assert.equal(appState.flag, true);
});

test('parseValue: data-value="false" → boolean false', () => {
  // L108 — the `s === 'false'` literal coercion.
  defineFn('keepFalse', (el, _s, _d, v) => setValue('flag', v, 'capture-false'));
  document.body.innerHTML = `<button data-action="click" data-fn="keepFalse" data-id="flag" data-value="false">x</button>`;
  bindDOM(document.body);
  document.body.querySelector('button').click();
  tick();
  assert.equal(appState.flag, false);
});

// === extractPaths: reserved-word filter ===

test('expressions referencing globals (Math.PI) are not auto-subscribed', () => {
  // L184 — RESERVED filter in extractPaths. Exercised by binding an
  // expression that starts with a JS global; the path must be filtered
  // out so we don't subscribe to a non-existent state key.
  document.body.innerHTML = `<p>{{Math.PI}}</p>`;
  bindDOM(document.body);
  tick();
  assert.match(document.body.querySelector('p').textContent, /3\.14/);
});

// === applyClass: array form ===

test(':class accepts an array (filter + join)', () => {
  // L194 — applyClass's Array.isArray branch.
  setValue('cls', ['a', '', 'b', false, 'c']);
  document.body.innerHTML = `<div :class="cls">x</div>`;
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelector('div').className, 'a b c');
});

// === applyEntry: add with no prior numeric value ===

test('trigger on a path with no prior value treats baseline as 0', () => {
  // L295 — the `(typeof cur === 'number' ? cur : 0)` branch when there
  // is no prior numeric leaf.
  trigger('init-add', 'never.set', 5);
  tick();
  assert.equal(getPathObj(appState, 'never.set'), 5);
});

// === addAsync: non-Error rejection ===

test('addAsync that throws a non-Error value stringifies it for error state', async () => {
  // L445 — the `err?.message || String(err)` fallback when the thrown
  // value has no .message property (e.g. throw 'oops' or throw 42).
  const refetch = addAsync('thing', async () => { throw 'plain-string'; });
  await refetch();
  await new Promise(r => setTimeout(r, 0));
  tick();
  assert.equal(getPathObj(appState, 'thing.error'), 'plain-string');
});

// === Empty-attribute fast paths ===

test(':attr with empty expression is skipped', () => {
  // L593 — `if (!expr) continue;` in bindAttrs.
  document.body.innerHTML = `<div :class="">x</div>`;
  // Should not throw; the empty expr is silently skipped.
  bindDOM(document.body);
});

test('data-if="" is skipped', () => {
  // L610 — bindIf early return on empty expression.
  document.body.innerHTML = `<div data-if="">x</div>`;
  bindDOM(document.body);
  assert.equal(document.body.querySelector('div').style.display, '');
});

test('data-model="" is skipped', () => {
  // L630 — bindModel early return on empty model string.
  document.body.innerHTML = `<input data-model="">`;
  bindDOM(document.body);
});

test('data-model with only modifiers (no path) is skipped', () => {
  // L637 — bindModel: parts.pop()s all modifiers, leaving empty path.
  document.body.innerHTML = `<input data-model=".lazy.trim">`;
  bindDOM(document.body);
});

test('data-ref="" is skipped', () => {
  // L661 — bindRef early return.
  document.body.innerHTML = `<div data-ref="">x</div>`;
  bindDOM(document.body);
  assert.deepEqual(Object.keys(spektrum.refs), []);
});

test('data-intent="" is skipped', () => {
  // L673 — bindIntent early return.
  document.body.innerHTML = `<div data-intent="">x</div>`;
  bindDOM(document.body);
  assert.deepEqual(Object.keys(spektrum.intents), []);
});

test('data-each="" is skipped', () => {
  // L721 — bindEach early return.
  document.body.innerHTML = `<ul data-each=""><li>x</li></ul>`;
  bindDOM(document.body);
  // No clones rendered, no error.
  assert.equal(document.body.querySelectorAll('li').length, 1);   // template stays
});

// === bindEach edge paths ===

test('data-each keyed: switching the bound path to non-array wipes the cache', () => {
  // L765 — wipeAll loop over cache.values() in keyed mode.
  setValue('rows', [{ id: 1 }, { id: 2 }]);
  document.body.innerHTML = `<ul data-each="rows" data-key="item.id"><li>{{item.id}}</li></ul>`;
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelectorAll('li').length, 2);
  setValue('rows', null);                       // not an array → wipe
  tick();
  assert.equal(document.body.querySelectorAll('li').length, 0);
});

test('data-each unkeyed: shrinking the array pops the tail (pre === newN branch)', () => {
  // L792 — the `pre === newN && newN < oldN` branch (shared prefix, shorter).
  const items = [{ k: 'a' }, { k: 'b' }, { k: 'c' }];
  setValue('rows', items);
  document.body.innerHTML = `<ul data-each="rows"><li>{{item.k}}</li></ul>`;
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelectorAll('li').length, 3);
  setValue('rows', items.slice(0, 2));          // same identity prefix, shorter
  tick();
  assert.equal(document.body.querySelectorAll('li').length, 2);
});

// === data-action modifiers ===

test('data-action="click.stop" stops event propagation', () => {
  // L883 — `has('stop') && ev.stopPropagation()`.
  let outerSawIt = false;
  defineFn('inner', () => {});
  document.body.innerHTML = `
    <div><button data-action="click.stop" data-fn="inner">x</button></div>`;
  document.body.querySelector('div').addEventListener('click', () => { outerSawIt = true; });
  bindDOM(document.body);
  document.body.querySelector('button').click();
  assert.equal(outerSawIt, false, 'outer click handler should not see the stopped event');
});

// === bindDOM: no-arg call falls back to document ===

test('bindDOM() with no argument binds the whole document', () => {
  // L909 — `root = root || document;`.
  document.body.innerHTML = `<p>{{val}}</p>`;
  setValue('val', 'ok');
  bindDOM();                                    // no arg
  assert.equal(document.body.querySelector('p').textContent, 'ok');
});

// === Nested data-each: outer detach guard ===

test('nested data-each inside another data-each does not double-bind the inner', () => {
  // L920 — `if (!root.contains(el)) continue;` — the inner [data-each]
  // was detached by its outer template, so the bindDOM loop should
  // skip re-processing it.
  setValue('groups', [{ items: [1, 2] }, { items: [3] }]);
  document.body.innerHTML = `
    <div data-each="groups" data-as="g">
      <section>
        <ul data-each="g.items" data-as="item"><li>{{item}}</li></ul>
      </section>
    </div>`;
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelectorAll('section').length, 2);
});

// === describe + explain: anonymous system name fallback ===

test('describe() reports anonymous systems with name=""', () => {
  // L982 — `s.fn.name || ''` for anonymous fns.
  addSystem(['x'], () => {});                   // arrow has empty name
  const sys = describe().systems.find(s => s.paths[0] === 'x');
  assert.equal(sys.name, '');
});

test('explain() over a checkpoint returns triggers=[] (skip-system branch)', () => {
  // L1002 — `e.op === 'checkpoint' ? [] : …`.
  checkpoint('point-a');
  const out = explain();
  const cp = out.find(e => e.op === 'checkpoint');
  assert.deepEqual(cp.triggers, []);
});

test('explain() reports anonymous system names as ""', () => {
  // L1005 — `s.fn.name || ''` in explain.
  addSystem(['y'], () => {});
  setValue('y', 1); tick();
  const last = explain().at(-1);
  assert.ok(last.triggers.includes(''), `expected anon trigger in ${JSON.stringify(last.triggers)}`);
});

// === Utility branches (setPathValue, isPath via instance) ===

test('setPathValue silently bails on prototype-pollution attempts', () => {
  // L79 — `keys.every(SAFE_KEY)` returns false. The function exits
  // without writing — exported `setPathValue` is the cleanest test.
  const obj = {};
  setPathValue(obj, '__proto__.polluted', 'bad');
  assert.equal(obj.polluted, undefined);
  assert.equal(({}).polluted, undefined, 'Object.prototype untouched');
});

test('setPathValue reuses an existing intermediate parent (L79 OR short-circuit)', () => {
  // L79 — `acc[k] = acc[k] || {}` — the truthy short-circuit when
  // `acc[k]` already exists. Two writes under the same parent — the
  // second sees the parent already materialised.
  const obj = {};
  setPathValue(obj, 'a.b', 1);                  // creates a (right side)
  setPathValue(obj, 'a.c', 2);                  // a already exists (left side)
  assert.equal(obj.a.b, 1);
  assert.equal(obj.a.c, 2);
});

test('isPath returns false when intermediate parent is null (L55)', () => {
  // The `obj == null ? undefined : obj[k]` branch — exercised when an
  // intermediate segment of a path resolves to null. Tested through
  // setValue's checkPath, which uses isPath internally; if isPath
  // mishandled null parents, the next setValue would throw.
  setValue('root', null);
  tick();
  setValue('root.child', 'now-an-object');      // crosses a null parent
  tick();
  assert.equal(getPathObj(appState, 'root.child'), 'now-an-object');
});

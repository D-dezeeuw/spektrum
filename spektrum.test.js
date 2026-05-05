/*
  Engine tests, run via Node's built-in test runner: `node --test`.

  Cover the parts of spektrum.js that don't need a DOM. The DOM-dependent
  binding helpers (bindText, bindAttrs, bindIf, bindEach, bindDOM) are
  exercised in the browser by loading index.html — keeping them out of
  node-only tests avoids pulling in a DOM polyfill.
*/

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import spektrum, {
  appState, appStateDelta, history,
  setValue, trigger, addSystem, removeSystem, computed,
  tick, replay, reset,
  getPathObj,
} from './spektrum.js';
import { createSpektrum } from './spektrum.js';

beforeEach(() => reset());

// === Core engine ===

test('setValue lands the value in state on tick', () => {
  setValue('gas.value', 100);
  tick();
  assert.equal(getPathObj(appState, 'gas.value'), 100);
});

test('trigger accumulates additive changes within a tick', () => {
  setValue('gas.value', 100);
  trigger('a', 'gas.value', +10);
  trigger('b', 'gas.value', -5);
  tick();
  assert.equal(getPathObj(appState, 'gas.value'), 105);
});

test('tick merges and clears delta even with no subscribers', () => {
  setValue('gas.value', 50);
  tick();
  assert.equal(getPathObj(appState, 'gas.value'), 50);
  assert.equal(Object.keys(appStateDelta).length, 0);
});

test('tick is a no-op when delta is empty', () => {
  tick();
  assert.deepEqual(appState, {});
});

test('addSystem fires only when subscribed paths are in delta', () => {
  let calls = 0;
  addSystem(['gas.value'], () => { calls++; });

  setValue('other.thing', 1);
  tick();
  assert.equal(calls, 0);

  setValue('gas.value', 1);
  tick();
  assert.equal(calls, 1);
});

// === Cleanup (Plan 3) ===

test('addSystem returns an unsubscribe function', () => {
  let calls = 0;
  const unsub = addSystem(['x'], () => { calls++; });
  setValue('x', 1);
  tick();
  assert.equal(calls, 1);

  unsub();
  setValue('x', 2);
  tick();
  assert.equal(calls, 1, 'system should not fire after unsub');
});

test('removeSystem detaches by function reference', () => {
  let calls = 0;
  const fn = () => { calls++; };
  addSystem(['y'], fn);
  setValue('y', 1);
  tick();
  assert.equal(calls, 1);

  assert.equal(removeSystem(fn), true);
  setValue('y', 2);
  tick();
  assert.equal(calls, 1);
});

test('removeSystem returns false when fn is not registered', () => {
  assert.equal(removeSystem(() => {}), false);
});

// === Replay ===

test('replay reconstructs state from history', () => {
  setValue('gas.value', 100);
  trigger('refuel', 'gas.value', +10);
  trigger('burn',   'gas.value', -5);
  trigger('burn',   'gas.value', -5);
  tick();
  assert.equal(getPathObj(appState, 'gas.value'), 100);

  replay(2);
  assert.equal(getPathObj(appState, 'gas.value'), 110);

  replay(1);
  assert.equal(getPathObj(appState, 'gas.value'), 100);

  replay(history.length);
  assert.equal(getPathObj(appState, 'gas.value'), 100);
});

test('replay preserves history (no truncation)', () => {
  setValue('gas.value', 100);
  trigger('a', 'gas.value', 10);
  trigger('b', 'gas.value', 10);
  tick();
  const lenBefore = history.length;
  replay(2);
  assert.equal(history.length, lenBefore);
});

test('trigger while scrubbed truncates the future', () => {
  setValue('gas.value', 100);
  trigger('a', 'gas.value', 10);
  trigger('b', 'gas.value', 10);
  // history: [seed, a, b] — length 3

  replay(2);
  trigger('c', 'gas.value', 5);
  // truncates to length 2, then pushes c → length 3

  assert.equal(history.length, 3);
  assert.equal(history[2].id, 'c');
});

test('replaying flag flips during replay', () => {
  const observed = [];
  setValue('gas.value', 1);
  trigger('a', 'gas.value', 1);
  tick();
  // observe spektrum.replaying inside a system
  addSystem(['gas.value'], () => { observed.push(spektrum.replaying); });
  replay(1);
  assert.ok(observed.every(v => v === true), 'replaying should be true during replay ticks');
  assert.equal(spektrum.replaying, false, 'replaying clears after replay');
});

// === Multiple instances (Plan 4) ===

test('createSpektrum produces isolated state', () => {
  const a = createSpektrum();
  const b = createSpektrum();

  a.setValue('foo', 1);
  a.tick();
  b.setValue('foo', 99);
  b.tick();

  assert.equal(getPathObj(a.appState, 'foo'), 1);
  assert.equal(getPathObj(b.appState, 'foo'), 99);
});

test('createSpektrum produces isolated history', () => {
  const a = createSpektrum();
  const b = createSpektrum();

  a.setValue('x', 1);
  a.trigger('hit', 'x', 1);
  b.setValue('y', 2);

  assert.equal(a.history.length, 2);
  assert.equal(b.history.length, 1);
});

test('createSpektrum instances expose live cursor and replaying', () => {
  const a = createSpektrum();
  assert.equal(a.cursor, 0);
  assert.equal(a.replaying, false);

  a.setValue('x', 1);
  assert.equal(a.cursor, 1);

  a.trigger('hit', 'x', 1);
  assert.equal(a.cursor, 2);
});

// === Pure utility ===

test('getPathObj returns undefined for missing paths', () => {
  assert.equal(getPathObj({}, 'a.b.c'), undefined);
  assert.equal(getPathObj({ a: { b: 1 } }, 'a.b.c'), undefined);
  assert.equal(getPathObj({ a: { b: 1 } }, 'a.b'), 1);
});

test('getPathObj walks numeric segments (array indices)', () => {
  assert.equal(getPathObj({ users: [{ name: 'a' }, { name: 'b' }] }, 'users.1.name'), 'b');
});

// === Computed ===

test('computed derives a value from deps and updates on change', () => {
  setValue('count', 5);
  computed('doubled', ['count'], (state) => state.count * 2);
  tick();
  assert.equal(getPathObj(appState, 'doubled'), 10);

  setValue('count', 7);
  tick();
  assert.equal(getPathObj(appState, 'doubled'), 14);
});

test('computed returns an unsubscribe', () => {
  setValue('x', 1);
  const unsub = computed('y', ['x'], (state) => state.x + 100);
  tick();
  assert.equal(getPathObj(appState, 'y'), 101);

  unsub();
  setValue('x', 5);
  tick();
  // y stays at the last computed value because the system was detached.
  assert.equal(getPathObj(appState, 'y'), 101);
});

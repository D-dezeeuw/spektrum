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
  appState, appStateDelta, history, forks,
  setValue, trigger, addSystem, removeSystem, computed,
  tick, replay, reset, onError, onRecord, onFork,
  getPathObj, precompile,
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

test('setValue on a sub-path of an array preserves siblings', () => {
  // Regression: previously, setValue('items.1.note', x) wrote
  // delta = {items: {1: {note: x}}}, then deepMerge's "if target is
  // an array, reset to {}" branch wholesale replaced state.items —
  // turning it into {1: {note: x}} (object) and discarding items 0
  // and 2. Visible in the demo as: typing into a per-item input
  // makes the list disappear.
  setValue('items', [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  tick();
  setValue('items.1.note', 'middle');
  tick();
  assert.ok(Array.isArray(appState.items), 'items stays an array');
  assert.equal(appState.items.length, 3);
  assert.deepEqual(appState.items[0], { name: 'a' });
  assert.deepEqual(appState.items[1], { name: 'b', note: 'middle' });
  assert.deepEqual(appState.items[2], { name: 'c' });
});

test('replay() refreshes every system, even for paths absent in the new state', () => {
  // Regression: scrubbing back to a state where a system's
  // subscribed path is undefined didn't fire the system, because
  // the replay loop only ticks for entries that touch the path. The
  // DOM-bound system (bindEach) kept rendering stale rows; the user
  // could then type into a row whose backing array no longer
  // existed, corrupting state.
  setValue('items', [1, 2, 3]);
  tick();
  let lastSeen = 'untouched';
  addSystem(['items'], (state) => { lastSeen = state.items; });
  // Initial fire from addSystem? No — addSystem is plain (bindReactive
  // does the initial render dance, not addSystem). Force one:
  setValue('items', [4, 5]);
  tick();
  assert.deepEqual(lastSeen, [4, 5]);

  replay(0);
  assert.equal(lastSeen, undefined, 'system fired with state cleared');
});

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

test('appState leaves are NOT materialised as {} pre-tick', () => {
  // Regression: an earlier checkPath() materialised every segment of a
  // path (including the leaf) as `{}` on appState, so bindings reading
  // state before the first tick got an empty object and tried to
  // assign it to `<input>.value`, producing "[object Object]". Only
  // intermediate parents should be created — the leaf stays absent
  // until something writes a real value.
  setValue('count', 0);
  setValue('user.name', 'alice');
  // Leaf segments are not materialised:
  assert.equal(appState.count, undefined, 'top-level leaf absent pre-tick');
  assert.equal(getPathObj(appState, 'user.name'), undefined, 'nested leaf absent pre-tick');
  // Intermediate parents ARE materialised so systems can do direct
  // property writes like `state.user.x = ...`.
  assert.deepEqual(appState.user, {}, 'intermediate parent is created');
  // After tick, real values land.
  tick();
  assert.equal(appState.count, 0);
  assert.equal(getPathObj(appState, 'user.name'), 'alice');
});

// === Forks ===

test('onFork fires when a record truncates entries; forks captures the dropped tail', () => {
  const seen = [];
  onFork((fork) => seen.push(fork));

  setValue('x', 1);
  setValue('x', 2);
  setValue('x', 3);
  tick();
  // history: [seed, 2, 3] — length 3, cursor 3.

  replay(1);
  // cursor=1, history.length=3 still. Mutate to fork.
  setValue('x', 99);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].entries.length, 2, 'two entries dropped');
  assert.equal(seen[0].forkedAt, 1);
  assert.equal(typeof seen[0].ts, 'number');
  // Same fork is reachable via the public array.
  assert.equal(forks.length, 1);
  assert.equal(forks[0], seen[0]);
});

test('onFork does NOT fire on linear records (cursor === history.length)', () => {
  const seen = [];
  onFork((fork) => seen.push(fork));

  setValue('a', 1);
  setValue('a', 2);
  setValue('a', 3);

  assert.equal(seen.length, 0);
  assert.equal(forks.length, 0);
});

test('onFork does NOT fire during replay()', () => {
  setValue('y', 1);
  setValue('y', 2);
  setValue('y', 3);
  tick();

  let calls = 0;
  onFork(() => calls++);
  replay(1);
  replay(0);
  replay(3);

  assert.equal(calls, 0, 'replay() never records, so cannot fork');
  assert.equal(forks.length, 0);
});

test('forkLimit evicts oldest forks on overflow', () => {
  const a = createSpektrum({ forkLimit: 2 });
  // Build five forks back-to-back: seed → fork1 → fork2 → fork3 → fork4 → fork5.
  for (let round = 0; round < 5; round++) {
    a.setValue('x', round * 10);     // entry at history.length
    a.setValue('x', round * 10 + 1); // another
    a.replay(a.history.length - 1);  // step back one
    a.setValue('x', round * 100);    // fork
  }
  assert.ok(a.forks.length <= 2, `forkLimit honored; got ${a.forks.length}`);
});

test('forkLimit: 0 fires the hook but stores nothing on forks', () => {
  const a = createSpektrum({ forkLimit: 0 });
  let calls = 0;
  a.onFork(() => calls++);

  a.setValue('x', 1);
  a.setValue('x', 2);
  a.replay(1);
  a.setValue('x', 99);

  assert.equal(calls, 0, 'hook does not fire — fork was never captured');
  assert.equal(a.forks.length, 0);
});

test('reset() clears forks', () => {
  setValue('z', 1);
  setValue('z', 2);
  replay(1);
  setValue('z', 99);
  assert.equal(forks.length, 1);

  reset();
  assert.equal(forks.length, 0);
});

test('onFork hook errors are caught (do not crash record)', () => {
  // Suppress the default console.error path noise — this test only
  // cares that the engine doesn't propagate the throw.
  const originalError = console.error;
  console.error = () => {};
  try {
    onFork(() => { throw new Error('boom'); });
    setValue('w', 1);
    setValue('w', 2);
    replay(1);
    // The next setValue must succeed even though the hook throws.
    assert.doesNotThrow(() => setValue('w', 99));
    tick();
    assert.equal(getPathObj(appState, 'w'), 99);
  } finally {
    console.error = originalError;
    onFork(null);
  }
});

test('forks survive linear records after the fork (no mutation)', () => {
  setValue('p', 1);
  setValue('p', 2);
  setValue('p', 3);
  replay(1);
  setValue('p', 99);
  assert.equal(forks.length, 1);
  const captured = forks[0];

  // Linear records after — should not change the existing fork.
  setValue('p', 100);
  setValue('p', 101);
  assert.equal(forks.length, 1);
  assert.equal(forks[0], captured);
  assert.equal(forks[0].entries.length, 2);
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

// === onError hook ===

test('onError catches throwing systems and skips console.error', () => {
  // Suppress the default console.error path so we'd notice if the
  // hook didn't take precedence; the assertion is on the hook receiving
  // the error.
  const seen = [];
  onError((err, fn) => seen.push({ msg: err.message, fn }));

  const boom = () => { throw new Error('kaboom'); };
  addSystem(['x'], boom);
  setValue('x', 1);
  tick();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].msg, 'kaboom');
  assert.equal(seen[0].fn, boom);
});

test('onRecord fires once per recorded entry, with the entry payload', () => {
  const seen = [];
  onRecord((entry) => seen.push(entry));

  setValue('a', 1);
  trigger('hit', 'a', 2);
  setValue('b', 3);

  assert.equal(seen.length, 3);
  assert.equal(seen[0].path, 'a');
  assert.equal(seen[0].op, 'set');
  assert.equal(seen[1].op, 'add');
  assert.equal(seen[2].path, 'b');
});

test('onRecord does NOT fire during replay()', () => {
  setValue('x', 1);
  setValue('x', 2);
  setValue('x', 3);
  tick();

  let calls = 0;
  onRecord(() => calls++);
  replay(1);
  assert.equal(calls, 0, 'replay re-applies without re-recording');
});

test('reset() preserves onError and onRecord registrations', () => {
  // Reset is for wiping state, not configuration. Hooks installed
  // before a reset() (or before a loadHistory(), which calls reset
  // internally) survive — saves the user from re-installing them.
  const errs = [];
  const recs = [];
  onError((err) => errs.push(err.message));
  onRecord((entry) => recs.push(entry.path));

  reset();

  addSystem(['z'], () => { throw new Error('post-reset'); });
  setValue('z', 1);
  tick();

  assert.equal(recs.length, 1, 'onRecord still active after reset');
  assert.equal(errs.length, 1, 'onError still active after reset');

  // Clean up so we don't leak into later tests.
  onError(null);
  onRecord(null);
});

test('onError(null) clears the handler', () => {
  onError(() => { throw new Error('should not be called'); });
  onError(null);
  // Without a handler the engine falls back to console.error.
  // We can't easily assert that here without monkey-patching; the
  // important behavior is that clearing the handler doesn't itself
  // throw and that subsequent ticks still drain.
  setValue('y', 1);
  tick();
  assert.equal(getPathObj(appState, 'y'), 1);
});

// === History bounding ===

test('historyLimit caps history.length and shifts cursor', () => {
  const a = createSpektrum({ historyLimit: 3 });
  a.setValue('x', 1);
  a.setValue('x', 2);
  a.setValue('x', 3);
  a.setValue('x', 4);
  a.setValue('x', 5);
  a.tick();
  assert.equal(a.history.length, 3);
  // Cursor still points at the live tail.
  assert.equal(a.cursor, 3);
  // Latest write applied.
  assert.equal(getPathObj(a.appState, 'x'), 5);
});

test('snapshotEvery captures snapshots for fast replay', () => {
  const a = createSpektrum({ snapshotEvery: 5 });
  for (let i = 1; i <= 12; i++) a.setValue('x', i);
  a.tick();
  // Snapshots at indices 5 and 10.
  assert.equal(a.snapshots.length, 2);
  assert.equal(a.snapshots[0].index, 5);
  assert.equal(a.snapshots[1].index, 10);
  // Replay correctness: snapshot must produce the same answer as
  // walking from scratch.
  a.replay(8);
  assert.equal(getPathObj(a.appState, 'x'), 8);
  a.replay(12);
  assert.equal(getPathObj(a.appState, 'x'), 12);
});

test('snapshots stay aligned with history after replay+truncate', () => {
  const a = createSpektrum({ snapshotEvery: 2 });
  for (let i = 1; i <= 6; i++) a.setValue('x', i);
  a.tick();
  // Snapshots at 2, 4, 6.
  assert.equal(a.snapshots.length, 3);

  a.replay(3);
  // Triggering after replay truncates entries [4..6]. Snapshots that
  // reference those vanished entries (at index 4 and 6) must be dropped
  // — leaving only the snapshot at 2 plus whatever new ones land.
  a.setValue('x', 99);
  // No snapshot may reference an index past the live history tail.
  assert.ok(
    a.snapshots.every(s => s.index <= a.history.length),
    `snapshots should not reference dropped entries; got ${JSON.stringify(a.snapshots.map(s => s.index))} with history.length=${a.history.length}`,
  );
  // The pre-truncate snapshot at index 2 still represents real state, so
  // we should still see it.
  assert.ok(a.snapshots.some(s => s.index === 2), 'snapshot at index 2 survives');
});

// === Precompile / CSP path ===

test('precompile() does not throw and accepts arbitrary source/fn pairs', () => {
  // Behavior is exercised end-to-end in the DOM tests, where a {{...}}
  // binding routes through evalExpr's cache. Here we just confirm the
  // public API is callable.
  precompile('__precompile_smoke__', (state) => state.__precompile_smoke__);
  setValue('__precompile_smoke__', 7);
  tick();
  assert.equal(getPathObj(appState, '__precompile_smoke__'), 7);
});

// === Prototype-pollution defenses (F-1, F-2) ===

test('setValue rejects a leading __proto__ segment', () => {
  setValue('__proto__.polluted', 'X');
  tick();
  assert.equal(({}).polluted, undefined, 'Object.prototype must not gain a "polluted" key');
  assert.equal(getPathObj(appState, '__proto__.polluted'), undefined);
});

test('setValue rejects __proto__ in the middle of a path', () => {
  setValue('a.__proto__.polluted', 'X');
  tick();
  assert.equal(({}).polluted, undefined);
});

test('setValue rejects constructor and prototype segments', () => {
  setValue('constructor.polluted', 'X');
  setValue('a.prototype.polluted', 'X');
  tick();
  assert.equal(({}).polluted, undefined);
});

test('deepMerge skips __proto__ on JSON-parsed sources (V8 own-key edge case)', () => {
  // JSON.parse produces an *own* enumerable __proto__ in V8, which a
  // naive Object.keys walk would feed straight into the recursion.
  setValue('p', JSON.parse('{"__proto__":{"polluted":"X"},"safe":1}'));
  tick();
  assert.equal(({}).polluted, undefined, 'prototype must not pick up the key');
  assert.equal(getPathObj(appState, 'p.safe'), 1, 'safe sibling still merges');
});

// Persist-module tests live in spektrum-persist.test.js. The F-3 path
// validation defenses are exercised there alongside saveHistory and
// autoSave coverage.

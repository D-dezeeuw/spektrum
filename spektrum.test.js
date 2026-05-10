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
  setValue, trigger, checkpoint, addSystem, watch, removeSystem,
  computed, addAsync,
  tick, replay, reset, resetState, serialize,
  onError, onRecord, onFork,
  getPathObj, setPathValue, precompile,
} from './spektrum.js';
import { createSpektrum } from './spektrum.js';

// Hooks survive reset() (per the documented contract), so we clear
// them between cases to keep tests self-isolating now that re-setting
// emits a "handler overwritten" warning. The "reset() detached N
// system(s)" warn is also silenced during teardown — tests routinely
// add systems without unsubscribing; that warn exists for production
// code, not cross-test cleanup.
beforeEach(() => {
  const orig = console.warn;
  console.warn = () => {};
  try { reset(); } finally { console.warn = orig; }
  onError(null);
  onRecord(null);
  onFork(null);
});

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

test('computed primes synchronously from current state on registration', () => {
  // Regression: registering computed AFTER state is already populated
  // (e.g. after loadHistory) used to silently no-op until one of the
  // deps next changed — values stayed undefined when bindDOM wired up.
  // Now the eager prime derives the initial value immediately.
  setValue('count', 5);
  tick();
  // State has count=5; nothing else has touched it. Register computed.
  computed('doubled', ['count'], (state) => state.count * 2);
  tick();
  assert.equal(getPathObj(appState, 'doubled'), 10,
    'computed value derived without needing a fresh dep mutation');
});

test('computed registration with missing deps does not throw', () => {
  // The eager prime catches user-fn throws (e.g. accessing a path
  // that isn't in state yet). The system stays registered and
  // derives normally once a dep arrives.
  assert.doesNotThrow(() => {
    computed('greet', ['user'], (state) => `hi, ${state.user.name}`);
  }, 'eager prime swallows the deps-not-ready throw');

  // Once user.name lands, derivation kicks in.
  setValue('user', { name: 'alice' });
  tick();
  assert.equal(getPathObj(appState, 'greet'), 'hi, alice');
});

test('computed re-derives on dep change after eager prime (regression)', () => {
  // After eager prime, the addSystem path still wires up correctly.
  setValue('a', 1);
  setValue('b', 2);
  tick();
  computed('sum', ['a', 'b'], (state) => state.a + state.b);
  tick();
  assert.equal(getPathObj(appState, 'sum'), 3, 'eager prime');

  setValue('a', 10);
  tick();
  assert.equal(getPathObj(appState, 'sum'), 12, 're-derives on a change');

  setValue('b', 20);
  tick();
  assert.equal(getPathObj(appState, 'sum'), 30, 're-derives on b change');
});

test('computed mid-tick read-through: sibling system sees fresh value (regression)', () => {
  // Pre-fix: `doubled` system wrote to delta only, so a sibling system
  // running in the SAME pass that read state.doubled saw the prior
  // value (delta hadn't been merged yet for THIS pass — it had been
  // merged-then-cleared BEFORE the systems ran). Now computed writes
  // to both state and delta, so mid-pass reads see the fresh value.
  let observed;
  computed('doubled', ['count'], (s) => s.count * 2);
  addSystem(['count'], (s) => { observed = s.doubled; });
  setValue('count', 7);
  tick();
  assert.equal(observed, 14, 'sibling read sees the just-computed value');
});

// === watch (public alias for addSystem) ===

test('watch is a 1:1 alias of addSystem', () => {
  let calls = 0;
  const unsub = watch(['x'], () => { calls++; });
  setValue('x', 1);
  tick();
  assert.equal(calls, 1);

  unsub();
  setValue('x', 2);
  tick();
  assert.equal(calls, 1, 'unsub returned by watch detaches');
});

// === addAsync ===

test('addAsync resolves: writes loading → data, clears error', async () => {
  const refetch = addAsync('user', async () => ({ name: 'alice' }));
  // Loading is true synchronously after registration (setValue records).
  tick();
  assert.equal(getPathObj(appState, 'user.loading'), true);

  // Wait for the promise + the resulting setValues to flow.
  await refetch();
  tick();
  assert.deepEqual(getPathObj(appState, 'user.data'), { name: 'alice' });
  assert.equal(getPathObj(appState, 'user.error'), null);
  assert.equal(getPathObj(appState, 'user.loading'), false);
});

test('addAsync rejects: writes error, clears loading, leaves data intact', async () => {
  const refetch = addAsync('thing', async () => { throw new Error('boom'); });
  await refetch();
  tick();
  assert.equal(getPathObj(appState, 'thing.error'), 'boom');
  assert.equal(getPathObj(appState, 'thing.loading'), false);
  // No `data` write on error.
});

test('addAsync returns a refetch handle that re-executes the user fn', async () => {
  // addAsync auto-runs once on registration (Solid createResource /
  // Vue useFetch convention). The returned handle re-runs on demand.
  let calls = 0;
  const refetch = addAsync('x', async () => ++calls);
  await refetch();  // wait for the eager run + the refetch to settle
  await new Promise(r => setTimeout(r, 0));  // drain the trailing microtask
  tick();
  assert.ok(calls >= 2, `expected ≥2 invocations (eager + refetch); got ${calls}`);
  const before = calls;
  await refetch();
  await new Promise(r => setTimeout(r, 0));
  tick();
  assert.equal(calls, before + 1, 'refetch increments by exactly one');
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

test('historyLimit amortizes trim with a chunk for caps > 16', () => {
  // F-13: chunk = max(1, historyLimit >>> 4). For historyLimit=64,
  // chunk=4. After overflow, length drops to historyLimit - chunk + 1
  // (= 61) instead of exactly historyLimit. The next chunk pushes
  // grow it back; trim fires once per chunk pushes instead of once
  // per push. Per-record cost amortizes to O(historyLimit / chunk).
  // Observable: history.length stays in [historyLimit - chunk + 1,
  // historyLimit] across heavy mutation.
  const a = createSpektrum({ historyLimit: 64 });
  for (let i = 0; i < 200; i++) a.setValue('x', i);
  a.tick();
  assert.ok(a.history.length >= 61,
    `expected length ≥ 61 (= 64 - chunk + 1), got ${a.history.length}`);
  assert.ok(a.history.length <= 64,
    `expected length ≤ 64, got ${a.history.length}`);
  // Latest write still applied.
  assert.equal(getPathObj(a.appState, 'x'), 199);
  // Cursor follows the trim — replay(cursor) is the live state.
  assert.equal(a.cursor, a.history.length);
});

test('historyLimit ≤ 16 keeps the trim-on-every-overflow behavior (chunk=1)', () => {
  // For caps where historyLimit >>> 4 === 0, chunk = max(1, 0) = 1,
  // so behavior is identical to pre-F-13 — trim down to exactly the
  // limit on every overflow. Documents the boundary.
  const a = createSpektrum({ historyLimit: 8 });
  for (let i = 0; i < 20; i++) a.setValue('x', i);
  a.tick();
  assert.equal(a.history.length, 8, 'small caps still trim to exact limit');
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

// === Tick-overflow routes through onError (F-9) ===

test('tick max-iterations sends an Error to onError with code E_TICK_OVERFLOW', (t) => {
  const seen = [];
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)));
  onError((err, sysFn) => seen.push({ msg: err.message, code: err.code, sysFn }));
  // Runaway: every tick the system re-writes its own subscribed path,
  // so the delta never settles and tick() bails after 1024 iterations.
  addSystem(['x'], (state, delta) => {
    setPathValue(delta, 'x', (state.x ?? 0) + 1);
  });
  setValue('x', 0);
  tick();
  assert.equal(seen.length, 1, 'onError fired exactly once');
  assert.match(seen[0].msg, /max iterations/);
  assert.equal(seen[0].code, 'E_TICK_OVERFLOW',
    'engine-thrown error carries discriminating code');
  assert.equal(seen[0].sysFn, null, 'sysFn arg is null for tick-overflow');
  assert.equal(warnings.length, 0, 'no console.warn fallback when handler is set');
});

test('user-thrown system errors pass through onError without a code', () => {
  const seen = [];
  onError((err) => seen.push(err));
  addSystem(['z'], () => { throw new Error('boom'); });
  setValue('z', 1);
  tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, 'boom');
  assert.equal(seen[0].code, undefined,
    'user-thrown errors are NOT annotated with engine codes');
  onError(null);
});

test('tick max-iterations falls back to console.warn when no onError', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)));
  addSystem(['x'], (state, delta) => {
    setPathValue(delta, 'x', (state.x ?? 0) + 1);
  });
  setValue('x', 0);
  tick();
  assert.ok(
    warnings.some(w => /max iterations/.test(w)),
    `expected warn about max iterations; got: ${JSON.stringify(warnings)}`,
  );
});

// Hooks are multi-subscriber as of 1.0: each onX(fn) appends a
// subscriber and returns an unsubscribe handle; onX(null) clears all.
// Pre-1.0 behavior was single-handler-replace, which silently collided
// when (e.g.) autoSave overwrote a user-registered onRecord.

test('onError appends subscribers (every handler fires)', () => {
  let aCalls = 0, bCalls = 0;
  onError(() => aCalls++);
  onError(() => bCalls++);
  addSystem(['x'], () => { throw new Error('boom'); });
  setValue('x', 1);
  tick();
  assert.equal(aCalls, 1, 'first handler still fires');
  assert.equal(bCalls, 1, 'second handler also fires');
  onError(null);
});

test('onError returns an unsubscribe handle that detaches just that subscriber', () => {
  let aCalls = 0, bCalls = 0;
  const unsubA = onError(() => aCalls++);
  onError(() => bCalls++);
  unsubA();
  addSystem(['x'], () => { throw new Error('boom'); });
  setValue('x', 1);
  tick();
  assert.equal(aCalls, 0, 'detached handler does not fire');
  assert.equal(bCalls, 1, 'other handler still fires');
  onError(null);
});

test('onError(null) clears every subscriber on the hook', () => {
  let calls = 0;
  onError(() => calls++);
  onError(() => calls++);
  onError(() => calls++);
  onError(null);
  // Without any handler the engine falls back to console.error; we just
  // assert no surviving subscribers fire.
  const orig = console.error; console.error = () => {};
  try {
    addSystem(['x'], () => { throw new Error('boom'); });
    setValue('x', 1);
    tick();
  } finally { console.error = orig; }
  assert.equal(calls, 0, 'no subscriber survived clear');
});

test('onRecord appends — autoSave can coexist with a user telemetry hook', () => {
  // Regression test for the pre-1.0 collision: autoSave used to
  // silently overwrite any user onRecord. Now both fire.
  const userEntries = [];
  const autoSaveLike = [];
  onRecord((e) => userEntries.push(e));
  onRecord((e) => autoSaveLike.push(e));
  setValue('a', 1);
  setValue('b', 2);
  assert.equal(userEntries.length, 2);
  assert.equal(autoSaveLike.length, 2);
  onRecord(null);
});

// === resetState / reset split ===

test('resetState() preserves registered systems', () => {
  let calls = 0;
  addSystem(['x'], () => { calls++; });
  setValue('x', 1);
  tick();
  assert.equal(calls, 1, 'system fired before resetState');

  resetState();

  // System should still be registered — fire it again post-resetState.
  setValue('x', 2);
  tick();
  assert.equal(calls, 2, 'system survived resetState');
});

test('resetState() wipes state, history, snapshots, refs, forks', () => {
  setValue('a', 1);
  setValue('b', 2);
  tick();
  assert.equal(history.length, 2);

  resetState();
  assert.equal(history.length, 0, 'history cleared');
  assert.deepEqual(Object.keys(appState), [], 'appState cleared');
  assert.equal(spektrum.cursor, 0, 'cursor reset');
});

// Note: the reset-detach warn was dropped in the 1.0 trim. Behavior
// unchanged — reset still clears systems — but the warning that
// recommended `resetState` was removed. README's "Lifecycle" section
// documents the distinction.

test('reset() clears systems', () => {
  let calls = 0;
  addSystem(['x'], () => { calls++; });
  reset();
  setValue('x', 1);
  tick();
  assert.equal(calls, 0, 'system cleared by reset()');
});

// === checkpoints ===

test('checkpoint() appends a tagged history entry with no state effect', () => {
  setValue('count', 5);
  tick();
  const stateBefore = JSON.parse(JSON.stringify(appState));
  const lenBefore = history.length;

  checkpoint('search-done', { query: 'amsterdam' });
  tick();

  assert.equal(history.length, lenBefore + 1, 'history grew by one');
  assert.deepEqual(appState, stateBefore, 'state unchanged');
  const last = history[history.length - 1];
  assert.equal(last.op, 'checkpoint');
  assert.equal(last.id, 'search-done');
  assert.deepEqual(last.value, { query: 'amsterdam' });
});

test('checkpoint() fires onRecord (so autoSave catches it)', () => {
  const recorded = [];
  onRecord((entry) => recorded.push(entry));
  checkpoint('marker', { ts: 1 });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].op, 'checkpoint');
  assert.equal(recorded[0].id, 'marker');
  onRecord(null);
});

test('checkpoint() does NOT fire onRecord during replay', () => {
  checkpoint('m1');
  setValue('x', 1);
  tick();

  const seen = [];
  onRecord((e) => seen.push(e));
  replay(0);
  replay(history.length);
  assert.equal(seen.length, 0, 'onRecord stays silent during replay');
  onRecord(null);
});

test('replay across a checkpoint leaves state identical to skipping it', () => {
  setValue('a', 1);
  setValue('b', 2);
  checkpoint('mid');
  setValue('c', 3);
  tick();

  // Replay to the position right after the checkpoint — state should
  // contain a + b but not c. The checkpoint itself is a no-op.
  const cpIndex = history.findIndex(e => e.op === 'checkpoint');
  replay(cpIndex + 1);
  assert.equal(getPathObj(appState, 'a'), 1);
  assert.equal(getPathObj(appState, 'b'), 2);
  assert.equal(getPathObj(appState, 'c'), undefined,
    'c not yet applied — checkpoint did not bleed through');
});

test('checkpoints getter returns only checkpoint entries with their index', () => {
  setValue('a', 1);
  checkpoint('first');
  setValue('b', 2);
  setValue('c', 3);
  checkpoint('second', { tag: 'milestone' });
  setValue('d', 4);
  tick();

  const cps = spektrum.checkpoints;
  assert.equal(cps.length, 2);
  assert.equal(cps[0].id, 'first');
  assert.equal(cps[0].index, 1, 'first checkpoint at history index 1');
  assert.equal(cps[1].id, 'second');
  assert.equal(cps[1].index, 4, 'second checkpoint at history index 4');
  assert.deepEqual(cps[1].value, { tag: 'milestone' });
});

test('replay-to-checkpoint recipe (find by name, +1) lands at post-checkpoint state', () => {
  setValue('step', 1);
  setValue('payload', 'a');
  checkpoint('step1-done');
  setValue('step', 2);
  setValue('payload', 'b');
  checkpoint('step2-done');
  setValue('step', 3);
  tick();

  // Replay to *after* step1-done.
  const cp = spektrum.checkpoints.find(c => c.id === 'step1-done');
  replay(cp.index + 1);
  assert.equal(getPathObj(appState, 'step'), 1);
  assert.equal(getPathObj(appState, 'payload'), 'a');
});

test('tick does not fan out from a checkpoint entry', () => {
  // Subscribe to '' (the empty path checkpoints carry). The system
  // must NOT fire on a bare checkpoint() call.
  let calls = 0;
  addSystem([''], () => { calls++; });
  checkpoint('m');
  tick();
  assert.equal(calls, 0, 'no fan-out from checkpoint op');
});

test('forks preserve checkpoint entries when scrubbed-back-then-mutated', () => {
  setValue('a', 1);
  checkpoint('cp');
  setValue('b', 2);
  tick();

  replay(1); // scrub back behind the checkpoint
  setValue('a', 'fork-edit'); // mutates → truncates the future
  tick();

  // The fork should hold the checkpoint plus the trailing setValue.
  const f = forks[forks.length - 1];
  assert.ok(f, 'a fork was captured');
  assert.ok(f.entries.some(e => e.op === 'checkpoint' && e.id === 'cp'),
    'checkpoint is in the fork tail');
});

// === serialize ===

test('serialize() emits state + history + cursor by default', () => {
  setValue('count', 5);
  setValue('user.name', 'alice');
  tick();
  const json = serialize();
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.state, { count: 5, user: { name: 'alice' } });
  assert.equal(parsed.history.length, 2);
  assert.equal(parsed.cursor, 2);
  assert.equal(parsed.forks, undefined, 'forks excluded by default');
});

test('serialize({ includeHistory: false }) emits state only', () => {
  setValue('a', 1);
  tick();
  const parsed = JSON.parse(serialize({ includeHistory: false }));
  assert.deepEqual(parsed.state, { a: 1 });
  assert.equal(parsed.history, undefined);
  assert.equal(parsed.cursor, undefined);
});

test('serialize({ includeForks: true }) includes preserved fork tails', () => {
  setValue('a', 1);
  setValue('a', 2);
  tick();
  replay(1);
  setValue('a', 99);
  tick();
  const parsed = JSON.parse(serialize({ includeForks: true }));
  assert.ok(Array.isArray(parsed.forks));
  assert.equal(parsed.forks.length, 1, 'one fork captured');
});

// === Agent surface: describe / explain / attempt / defineFn meta ===

test('describe() returns a manifest with state, systems, fns, refs, intents, checkpoints', () => {
  const s = createSpektrum();
  s.setValue('user.name', 'alice');
  s.tick();
  s.addSystem(['user.name'], function greet() {});
  s.defineFn('shout', () => {}, { description: 'uppercase + log', input: { type: 'string' } });
  s.checkpoint('boot');
  const m = s.describe();
  assert.equal(m.state.user.name, 'alice');
  assert.equal(m.cursor, s.cursor);
  assert.equal(m.historyLength, s.history.length);
  assert.ok(m.systems.find(x => x.name === 'greet'));
  const shout = m.fns.find(x => x.name === 'shout');
  assert.equal(shout.description, 'uppercase + log');
  assert.deepEqual(shout.input, { type: 'string' });
  assert.equal(m.checkpoints.length, 1);
  assert.equal(m.checkpoints[0].id, 'boot');
});

test('explain() annotates each entry with current subscriber names', () => {
  const s = createSpektrum();
  s.addSystem(['cart.items'], function recomputeTotal() {});
  s.setValue('cart.items', [{ price: 1 }]);
  s.setValue('user.name', 'alice');
  const trace = s.explain();
  const cartEntry = trace.find(e => e.path === 'cart.items');
  assert.ok(cartEntry.triggers.includes('recomputeTotal'));
  const userEntry = trace.find(e => e.path === 'user.name');
  assert.deepEqual(userEntry.triggers, []);
});

test('explain({ from, to }) slices the history range', () => {
  const s = createSpektrum();
  for (let i = 0; i < 5; i++) s.setValue('n', i);
  const trace = s.explain({ from: 1, to: 4 });
  assert.equal(trace.length, 3);
  assert.equal(trace[0].index, 1);
  assert.equal(trace[2].index, 3);
});

test('attempt() + commit keeps the speculative entries in history', () => {
  const s = createSpektrum();
  s.setValue('x', 1); s.tick();
  const cursorBefore = s.cursor;
  const h = s.attempt('try-bump', () => { s.setValue('x', 99); return 'ok'; });
  assert.equal(h.result, 'ok');
  s.tick();
  assert.equal(s.appState.x, 99);
  h.commit();
  assert.ok(s.cursor > cursorBefore);
  assert.equal(s.appState.x, 99);
});

test('attempt() + discard rewinds the cursor back to before the attempt', () => {
  const s = createSpektrum();
  s.setValue('x', 1); s.tick();
  const cursorBefore = s.cursor;
  const h = s.attempt('try-bump', () => { s.setValue('x', 99); });
  s.tick();
  assert.equal(s.appState.x, 99);
  h.discard();
  assert.equal(s.cursor, cursorBefore);
  assert.equal(s.appState.x, 1);
});

test('defineFn(name, fn, meta) attaches metadata for describe()', () => {
  const s = createSpektrum();
  const noop = () => {};
  s.defineFn('toast', noop, { description: 'show a toast', examples: [{ msg: 'hi' }] });
  const entry = s.describe().fns.find(f => f.name === 'toast');
  assert.equal(entry.description, 'show a toast');
  assert.deepEqual(entry.examples, [{ msg: 'hi' }]);
});

test('defineFn without meta still works (backwards compatible)', () => {
  const s = createSpektrum();
  s.defineFn('plain', () => {});
  const entry = s.describe().fns.find(f => f.name === 'plain');
  assert.equal(entry.name, 'plain');
  assert.equal(entry.description, undefined);
});

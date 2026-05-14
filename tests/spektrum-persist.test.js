/*
  Persistence-helper tests. Cover saveHistory, loadHistory, and autoSave
  with a fake { getItem, setItem } backend so we don't need happy-dom
  here — the engine is DOM-free and the persist module only touches
  Storage-shaped backends.

  Each test gets a fresh instance via createSpektrum() — no shared
  singleton state, no `reset()` plumbing between tests, no warns to
  silence. Matches the style used by spektrum-inspect.test.js and
  spektrum-dock.test.js.
*/

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { getPathObj, createSpektrum } from '../spektrum.js';
import { saveHistory, loadHistory, autoSave } from '../companions/spektrum-persist.js';

let s;
beforeEach(() => { s = createSpektrum(); });

const fakeStorage = () => {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, v); },
    _data: data,
  };
};

// === saveHistory ===

test('saveHistory writes the current history JSON to storage', () => {
  s.setValue('count', 5);
  s.trigger('inc', 'count', 1);
  s.tick();
  const storage = fakeStorage();
  assert.equal(saveHistory(s, { storage }), true);
  const persisted = JSON.parse(storage.getItem('spektrum:history'));
  assert.deepEqual(persisted, s.history);
});

test('saveHistory honours opts.key', () => {
  s.setValue('x', 1);
  s.tick();
  const storage = fakeStorage();
  saveHistory(s, { storage, key: 'custom-key' });
  assert.equal(storage._data.has('custom-key'), true);
  assert.equal(storage._data.has('spektrum:history'), false);
});

test('saveHistory returns false when storage.setItem throws (quota / readonly)', () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  s.setValue('x', 1);
  s.tick();
  assert.equal(saveHistory(s, { storage }), false);
});

test('saveHistory returns false when no storage is available', () => {
  // Vanilla Node has no globalThis.localStorage. Guard in case some
  // future runtime adds one — explicit save/restore.
  const orig = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    assert.equal(saveHistory(s, {}), false);
  } finally {
    if (orig !== undefined) globalThis.localStorage = orig;
  }
});

// === loadHistory ===

test('loadHistory replays a saved history (round-trip)', () => {
  // Seed in instance A, save, load into instance B — the round-trip
  // path used in real apps (save in one session, load in the next).
  s.setValue('count', 5);
  s.trigger('inc', 'count', 1);
  s.tick();
  const storage = fakeStorage();
  saveHistory(s, { storage });

  const fresh = createSpektrum();
  loadHistory(fresh, { storage });
  assert.equal(getPathObj(fresh.appState, 'count'), 6);
  assert.equal(fresh.history.length, 2);
});

test('loadHistory preserves systems registered before the load (regression)', () => {
  // Hourly-weather hit this: addSystem before loadHistory, the system
  // silently detached on every reload because loadHistory called
  // reset() which clears systems. Now loadHistory uses resetState().
  let calls = 0;
  s.addSystem(['watched'], () => { calls++; });

  // Seed storage with something to load.
  s.setValue('watched', 'before-save');
  s.tick();
  const storage = fakeStorage();
  saveHistory(s, { storage });

  // The user's pre-load system should still fire after loadHistory
  // replays its entries — that's the whole point of the fix.
  const beforeLoad = calls;
  loadHistory(s, { storage });
  assert.ok(calls > beforeLoad, 'system fired during loadHistory replay');

  // And it should keep firing on subsequent mutations.
  const afterLoad = calls;
  s.setValue('watched', 'post-load');
  s.tick();
  assert.ok(calls > afterLoad, 'system survived loadHistory and still fires');
});

test('loadHistory returns false when storage is empty / missing', () => {
  const empty = fakeStorage();
  assert.equal(loadHistory(s, { storage: empty }), false);

  // Garbage JSON.
  const broken = { getItem: () => '{not-json', setItem() {} };
  assert.equal(loadHistory(s, { storage: broken }), false);

  // Wrong shape (object instead of array).
  const wrongShape = { getItem: () => '{"a":1}', setItem() {} };
  assert.equal(loadHistory(s, { storage: wrongShape }), false);

  // Empty array.
  const emptyArray = { getItem: () => '[]', setItem() {} };
  assert.equal(loadHistory(s, { storage: emptyArray }), false);
});

test('loadHistory ignores entries with non-string path', () => {
  const storage = {
    getItem: () => JSON.stringify([
      { op: 'set', path: 'good', value: 1, id: 'a' },
      { op: 'set', path: 42,   value: 'bad', id: 'b' },
      { op: 'set', path: null, value: 'bad', id: 'c' },
    ]),
    setItem() {},
  };
  loadHistory(s, { storage });
  assert.equal(getPathObj(s.appState, 'good'), 1);
  assert.equal(s.history.length, 1, 'only the well-formed entry replays');
});

test('loadHistory rejects non-numeric value on additive trigger op', () => {
  const storage = {
    getItem: () => JSON.stringify([
      { op: 'set', path: 'count', value: 5, id: 'seed' },
      { op: 'add', path: 'count', value: 'NaN-string', id: 'bad' },
      { op: 'add', path: 'count', value: 3, id: 'good' },
    ]),
    setItem() {},
  };
  loadHistory(s, { storage });
  assert.equal(getPathObj(s.appState, 'count'), 8,
    'string value silently skipped, numeric still applies');
});

test('loadHistory rejects Infinity on additive trigger op', () => {
  // `JSON.parse('1e1000')` overflows to Infinity. An earlier
  // `typeof === 'number'` check let it through; once Infinity lands in
  // an additive sequence it sticks (Infinity + N = Infinity).
  const raw = '['
    + '{"op":"set","path":"count","value":0,"id":"seed"},'
    + '{"op":"add","path":"count","value":1e1000,"id":"bad-overflow"},'
    + '{"op":"add","path":"count","value":7,"id":"good"}'
    + ']';
  const storage = { getItem: () => raw, setItem() {} };
  loadHistory(s, { storage });
  assert.equal(getPathObj(s.appState, 'count'), 7,
    'overflow-to-Infinity rejected; finite add still applies');
  assert.ok(Number.isFinite(getPathObj(s.appState, 'count')),
    'count must remain finite after replay');
});

test('loadHistory caps replay at opts.maxEntries', () => {
  const big = Array.from({ length: 50 }, (_, i) => ({
    op: 'set', path: 'n', value: i, id: `e${i}`,
  }));
  const storage = { getItem: () => JSON.stringify(big), setItem() {} };
  loadHistory(s, { storage, maxEntries: 10 });
  assert.equal(s.history.length, 10, 'replay capped at maxEntries');
  assert.equal(getPathObj(s.appState, 'n'), 9, 'last replayed entry is index 9');
});

// === autoSave ===

test('autoSave fires on every recorded mutation (no debounce)', () => {
  const storage = fakeStorage();
  let saves = 0;
  const wrapped = {
    getItem: storage.getItem,
    setItem: (k, v) => { saves++; storage.setItem(k, v); },
  };
  const stop = autoSave(s, { storage: wrapped });
  s.setValue('x', 1);
  s.trigger('inc', 'x', 1);
  s.tick();
  assert.equal(saves, 2, 'one save per recorded entry without debounce');
  const persisted = JSON.parse(storage.getItem('spektrum:history'));
  assert.equal(persisted.length, 2);
  stop();
});

test('autoSave with debounce coalesces rapid mutations into one save', async () => {
  const storage = fakeStorage();
  let saves = 0;
  const wrapped = {
    getItem: storage.getItem,
    setItem: (k, v) => { saves++; storage.setItem(k, v); },
  };
  const stop = autoSave(s, { storage: wrapped, debounce: 30 });
  s.setValue('a', 1);
  s.setValue('b', 2);
  s.setValue('c', 3);
  s.tick();
  assert.equal(saves, 0, 'no save fires before the debounce window elapses');

  await delay(60);
  assert.equal(saves, 1, 'exactly one save after the window settles');
  const persisted = JSON.parse(storage.getItem('spektrum:history'));
  assert.equal(persisted.length, 3, 'all three entries are in the saved blob');
  stop();
});

test('autoSave stop() detaches the onRecord hook', () => {
  const storage = fakeStorage();
  const stop = autoSave(s, { storage });
  s.setValue('x', 1);
  s.tick();
  const beforeStop = storage.getItem('spektrum:history');
  assert.ok(beforeStop, 'something was saved before stop()');

  stop();
  s.setValue('y', 99);
  s.tick();
  // No save fires after stop, so storage is unchanged.
  assert.equal(storage.getItem('spektrum:history'), beforeStop);
});

test('autoSave stop() also clears a pending debounced flush', async () => {
  const storage = fakeStorage();
  let saves = 0;
  const wrapped = {
    getItem: storage.getItem,
    setItem: (k, v) => { saves++; storage.setItem(k, v); },
  };
  const stop = autoSave(s, { storage: wrapped, debounce: 100 });
  s.setValue('x', 1);
  s.tick();
  // Mutation queued; flush scheduled for +100ms.
  stop();
  await delay(150);
  assert.equal(saves, 0, 'pending flush was cleared by stop()');
});

// === checkpoints ===

test('loadHistory restores checkpoints from storage', () => {
  s.setValue('a', 1);
  s.checkpoint('cp', { tag: 'middle' });
  s.setValue('b', 2);
  s.tick();
  const storage = fakeStorage();
  saveHistory(s, { storage });

  // Load into a fresh instance to confirm the restore path.
  const fresh = createSpektrum();
  loadHistory(fresh, { storage });
  assert.equal(fresh.history.length, 3, 'all three entries restored');
  assert.equal(fresh.checkpoints.length, 1);
  assert.equal(fresh.checkpoints[0].id, 'cp');
  assert.deepEqual(fresh.checkpoints[0].value, { tag: 'middle' });
});

test('loadHistory rejects malformed checkpoint entries', () => {
  const storage = fakeStorage();
  // Mix of malformed (no id, non-string id) and one valid entry.
  storage.setItem('spektrum:history', JSON.stringify([
    { op: 'checkpoint' },                          // no id → skip
    { op: 'checkpoint', id: 42 },                  // non-string id → skip
    { op: 'set', path: 'real', value: 7, id: 's' },
    { op: 'checkpoint', id: 'good' },              // OK
  ]));

  loadHistory(s, { storage });
  assert.equal(getPathObj(s.appState, 'real'), 7);
  assert.equal(s.checkpoints.length, 1);
  assert.equal(s.checkpoints[0].id, 'good');
});

// === Branch coverage ===

test('loadHistory falls back to globalThis.localStorage when no opts.storage', () => {
  // L58 — exercises the `opts.storage || globalThis.localStorage` OR.
  // Stub globalThis.localStorage temporarily (vanilla Node has none).
  const store = {};
  const fake = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  fake.setItem('spektrum:history', JSON.stringify([
    { op: 'set', path: 'fromLs', value: 42, id: 'x' },
  ]));
  const orig = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake });
  try {
    loadHistory(s);                            // no opts → falls back to globalThis.localStorage
    assert.equal(getPathObj(s.appState, 'fromLs'), 42);
  } finally {
    if (orig === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: orig });
  }
});

test('loadHistory returns false when no storage is available at all', () => {
  // L59 — `if (!storage) return false;`. No globalThis.localStorage and no opts.storage.
  const orig = globalThis.localStorage;
  if (orig !== undefined) delete globalThis.localStorage;
  try {
    assert.equal(loadHistory(s), false);
  } finally {
    if (orig !== undefined) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: orig });
  }
});

test('loadHistory skips null/falsy entries in the parsed history', () => {
  // L72 — `if (!e) continue;` in the per-entry validation loop.
  // Tampered storage where some array slots are nulls.
  const storage = { _v: null, getItem() { return this._v; }, setItem(_, v) { this._v = v; } };
  storage.setItem('spektrum:history', JSON.stringify([
    null,
    { op: 'set', path: 'kept', value: 'yes', id: 'k' },
    null,
  ]));
  loadHistory(s, { storage });
  assert.equal(getPathObj(s.appState, 'kept'), 'yes');
});

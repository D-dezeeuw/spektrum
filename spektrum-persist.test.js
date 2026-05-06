/*
  Persistence-helper tests. Cover saveHistory, loadHistory, and autoSave
  with a fake { getItem, setItem } backend so we don't need happy-dom
  here — the engine is DOM-free and the persist module only touches
  Storage-shaped backends.
*/

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import spektrum, {
  appState, history,
  setValue, trigger, checkpoint, tick, reset,
  getPathObj,
} from './spektrum.js';
import { saveHistory, loadHistory, autoSave } from './spektrum-persist.js';

beforeEach(() => {
  // Silence the "reset() detached N system(s)" warn during cleanup.
  const orig = console.warn;
  console.warn = () => {};
  try { reset(); } finally { console.warn = orig; }
});

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
  setValue('count', 5);
  trigger('inc', 'count', 1);
  tick();
  const storage = fakeStorage();
  assert.equal(saveHistory(spektrum, { storage }), true);
  const persisted = JSON.parse(storage.getItem('spektrum:history'));
  assert.deepEqual(persisted, spektrum.history);
});

test('saveHistory honours opts.key', () => {
  setValue('x', 1);
  tick();
  const storage = fakeStorage();
  saveHistory(spektrum, { storage, key: 'custom-key' });
  assert.equal(storage._data.has('custom-key'), true);
  assert.equal(storage._data.has('spektrum:history'), false);
});

test('saveHistory returns false when storage.setItem throws (quota / readonly)', () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  setValue('x', 1);
  tick();
  assert.equal(saveHistory(spektrum, { storage }), false);
});

test('saveHistory returns false when no storage is available', () => {
  // Vanilla Node has no globalThis.localStorage. Guard in case some
  // future runtime adds one — explicit save/restore.
  const orig = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    assert.equal(saveHistory(spektrum, {}), false);
  } finally {
    if (orig !== undefined) globalThis.localStorage = orig;
  }
});

// === loadHistory ===

test('loadHistory replays a saved history (round-trip)', () => {
  // Seed, save, reset, load — the round-trip path used in real apps.
  setValue('count', 5);
  trigger('inc', 'count', 1);
  tick();
  const storage = fakeStorage();
  saveHistory(spektrum, { storage });

  // Silence the expected reset-warn here since this test pre-dates
  // the warn and a non-test caller wouldn't see it.
  const orig = console.warn;
  console.warn = () => {};
  try { reset(); } finally { console.warn = orig; }
  assert.equal(history.length, 0);

  loadHistory(spektrum, { storage });
  assert.equal(getPathObj(appState, 'count'), 6);
  assert.equal(history.length, 2);
});

test('loadHistory preserves systems registered before the load (regression)', () => {
  // Hourly-weather hit this: addSystem before loadHistory, the system
  // silently detached on every reload because loadHistory called
  // reset() which clears systems. Now loadHistory uses resetState().
  let calls = 0;
  spektrum.addSystem(['watched'], () => { calls++; });

  // Seed storage with something to load.
  setValue('watched', 'before-save');
  tick();
  const storage = fakeStorage();
  saveHistory(spektrum, { storage });

  // The user's pre-load system should still fire after loadHistory
  // replays its entries — that's the whole point of the fix.
  const beforeLoad = calls;
  loadHistory(spektrum, { storage });
  assert.ok(calls > beforeLoad, 'system fired during loadHistory replay');

  // And it should keep firing on subsequent mutations.
  const afterLoad = calls;
  setValue('watched', 'post-load');
  tick();
  assert.ok(calls > afterLoad, 'system survived loadHistory and still fires');
});

test('loadHistory returns false when storage is empty / missing', () => {
  const empty = fakeStorage();
  assert.equal(loadHistory(spektrum, { storage: empty }), false);

  // Garbage JSON.
  const broken = { getItem: () => '{not-json', setItem() {} };
  assert.equal(loadHistory(spektrum, { storage: broken }), false);

  // Wrong shape (object instead of array).
  const wrongShape = { getItem: () => '{"a":1}', setItem() {} };
  assert.equal(loadHistory(spektrum, { storage: wrongShape }), false);

  // Empty array.
  const emptyArray = { getItem: () => '[]', setItem() {} };
  assert.equal(loadHistory(spektrum, { storage: emptyArray }), false);
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
  loadHistory(spektrum, { storage });
  assert.equal(getPathObj(appState, 'good'), 1);
  assert.equal(history.length, 1, 'only the well-formed entry replays');
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
  loadHistory(spektrum, { storage });
  assert.equal(getPathObj(appState, 'count'), 8,
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
  loadHistory(spektrum, { storage });
  assert.equal(getPathObj(appState, 'count'), 7,
    'overflow-to-Infinity rejected; finite add still applies');
  assert.ok(Number.isFinite(getPathObj(appState, 'count')),
    'count must remain finite after replay');
});

test('loadHistory caps replay at opts.maxEntries', () => {
  const big = Array.from({ length: 50 }, (_, i) => ({
    op: 'set', path: 'n', value: i, id: `e${i}`,
  }));
  const storage = { getItem: () => JSON.stringify(big), setItem() {} };
  loadHistory(spektrum, { storage, maxEntries: 10 });
  assert.equal(history.length, 10, 'replay capped at maxEntries');
  assert.equal(getPathObj(appState, 'n'), 9, 'last replayed entry is index 9');
});

// === autoSave ===

test('autoSave fires on every recorded mutation (no debounce)', () => {
  const storage = fakeStorage();
  let saves = 0;
  const wrapped = {
    getItem: storage.getItem,
    setItem: (k, v) => { saves++; storage.setItem(k, v); },
  };
  const stop = autoSave(spektrum, { storage: wrapped });
  setValue('x', 1);
  trigger('inc', 'x', 1);
  tick();
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
  const stop = autoSave(spektrum, { storage: wrapped, debounce: 30 });
  setValue('a', 1);
  setValue('b', 2);
  setValue('c', 3);
  tick();
  assert.equal(saves, 0, 'no save fires before the debounce window elapses');

  await delay(60);
  assert.equal(saves, 1, 'exactly one save after the window settles');
  const persisted = JSON.parse(storage.getItem('spektrum:history'));
  assert.equal(persisted.length, 3, 'all three entries are in the saved blob');
  stop();
});

test('autoSave stop() detaches the onRecord hook', () => {
  const storage = fakeStorage();
  const stop = autoSave(spektrum, { storage });
  setValue('x', 1);
  tick();
  const beforeStop = storage.getItem('spektrum:history');
  assert.ok(beforeStop, 'something was saved before stop()');

  stop();
  setValue('y', 99);
  tick();
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
  const stop = autoSave(spektrum, { storage: wrapped, debounce: 100 });
  setValue('x', 1);
  tick();
  // Mutation queued; flush scheduled for +100ms.
  stop();
  await delay(150);
  assert.equal(saves, 0, 'pending flush was cleared by stop()');
});

// === checkpoints ===

test('loadHistory restores checkpoints from storage', () => {
  setValue('a', 1);
  checkpoint('cp', { tag: 'middle' });
  setValue('b', 2);
  tick();
  const storage = fakeStorage();
  saveHistory(spektrum, { storage });

  // Wipe and restore.
  const orig = console.warn;
  console.warn = () => {};
  try { reset(); } finally { console.warn = orig; }

  loadHistory(spektrum, { storage });
  assert.equal(history.length, 3, 'all three entries restored');
  assert.equal(spektrum.checkpoints.length, 1);
  assert.equal(spektrum.checkpoints[0].id, 'cp');
  assert.deepEqual(spektrum.checkpoints[0].value, { tag: 'middle' });
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

  loadHistory(spektrum, { storage });
  assert.equal(getPathObj(appState, 'real'), 7);
  assert.equal(spektrum.checkpoints.length, 1);
  assert.equal(spektrum.checkpoints[0].id, 'good');
});

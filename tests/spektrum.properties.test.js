/*
  Property-based tests over the engine's core invariants.

  The rest of the suite asserts specific behaviors on hand-written
  inputs. This file asserts the *properties* those behaviors exist to
  provide, over randomly generated mutation sequences — the cases nobody
  thought to write down.

  Zero dependencies, in keeping with the project's rules: the generator
  below is ~30 lines of seeded PRNG. Seeded matters twice over. It keeps
  CI deterministic (a green run means the same thing tomorrow), and it
  makes a failure reproducible — every assertion reports the seed that
  produced it, so a counterexample can be replayed with
  SPEKTRUM_SEED=<n> npm test.

  Iteration counts are deliberately modest so this stays inside the
  normal test gate rather than becoming a slow lane nobody runs. Raise
  RUNS locally when hunting something specific.
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpektrum, getPathObj } from '../spektrum.js';

// mulberry32 — small, fast, well-distributed enough for input shaping.
const makeRng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const BASE_SEED = Number(process.env.SPEKTRUM_SEED ?? 20260802);
const RUNS = Number(process.env.SPEKTRUM_RUNS ?? 60);

const PATHS = [
  'count', 'user.name', 'user.email', 'items.0.label', 'items.1.label',
  'nested.a.b.c', 'flag', 'list',
];

/**
 * Generate a random-but-reproducible mutation program.
 *
 * Values are **type-stable per path**: a given path always receives the
 * same value shape, and object values always carry the same key set.
 * That is not incidental — it steers around a real, separately-pinned
 * engine limitation (see the "known divergence" test at the bottom of
 * this file): because `deepMerge` merges a plain-object source into
 * whatever is already at the path, writing an object OVER a value of a
 * different shape produces a result that depends on how the writes were
 * batched into ticks. Leaving that in the generator would make every
 * replay property fail for one known reason and mask any new one.
 */
const genValue = (rng, path) => {
  const kind = PATHS.indexOf(path) % 5;
  return kind === 0 ? Math.floor(rng() * 1000)
    : kind === 1 ? `s${Math.floor(rng() * 100)}`
    : kind === 2 ? (rng() < 0.5)
    : kind === 3 ? [Math.floor(rng() * 10), Math.floor(rng() * 10)]
    : { k: Math.floor(rng() * 10) };
};

const genProgram = (rng, length) => {
  const ops = [];
  for (let i = 0; i < length; i++) {
    const roll = rng();
    const path = PATHS[Math.floor(rng() * PATHS.length)];
    if (roll < 0.55) {
      ops.push({ op: 'set', path, value: genValue(rng, path) });
    } else if (roll < 0.85) {
      ops.push({ op: 'add', path: 'count', value: Math.floor(rng() * 20) - 10 });
    } else {
      ops.push({ op: 'checkpoint', name: `cp${i}` });
    }
  }
  return ops;
};

const runProgram = (s, ops) => {
  for (const o of ops) {
    if (o.op === 'set') s.setValue(o.path, o.value);
    else if (o.op === 'add') s.addValue(o.path, o.value);
    else s.checkpoint(o.name);
  }
  s.tick();
};

// === replay determinism ===

test('property: replay(history.length) reproduces the same state, every time', () => {
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + run;
    const rng = makeRng(seed);
    const s = createSpektrum();
    const ops = genProgram(rng, 1 + Math.floor(rng() * 25));
    runProgram(s, ops);

    // deepEqual, not JSON string comparison: replay rebuilds state by
    // applying one entry per tick, whereas the original run merged a
    // whole batch in a single tick, so KEY INSERTION ORDER can differ
    // for identical state. That is not a divergence the engine promises
    // anything about (and deepEqual rightly ignores it) — but it does
    // mean serialize() output is not guaranteed byte-identical across a
    // replay. Values are what must match.
    const before = structuredClone(s.appState);
    s.replay(s.history.length);
    s.tick();
    assert.deepEqual(s.appState, before, `full replay diverged (seed ${seed})`);

    // And again — replay must be idempotent, not merely correct once.
    s.replay(s.history.length);
    s.tick();
    assert.deepEqual(s.appState, before, `second replay diverged (seed ${seed})`);
  }
});

test('property: replaying to an index is independent of how you got there', () => {
  // Scrubbing back to N must land on the same state as running the first
  // N entries into a fresh instance. This is the property time-travel UI
  // depends on, and the one snapshots could quietly break.
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + 1000 + run;
    const rng = makeRng(seed);
    const ops = genProgram(rng, 5 + Math.floor(rng() * 20));

    const scrubbed = createSpektrum();
    runProgram(scrubbed, ops);
    const n = Math.floor(rng() * (scrubbed.history.length + 1));
    scrubbed.replay(n);
    scrubbed.tick();

    const direct = createSpektrum();
    runProgram(direct, ops);
    const prefix = direct.history.slice(0, n).map(e => ({ ...e }));
    const rebuilt = createSpektrum();
    for (const e of prefix) {
      if (e.op === 'checkpoint') rebuilt.checkpoint(e.id, e.value);
      else if (e.op === 'set') rebuilt.setValue(e.path, e.value, e.id);
      else rebuilt.addValue(e.path, e.value, e.id);
    }
    rebuilt.tick();

    assert.deepEqual(scrubbed.appState, rebuilt.appState,
      `scrub-to-${n} != rebuild-first-${n} (seed ${seed})`);
  }
});

test('property: snapshotEvery does not change what replay produces', () => {
  // Snapshots are an optimization. Any divergence between a snapshotted
  // instance and a plain one is a correctness bug, and this is exactly
  // where an aliasing mistake would surface.
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + 2000 + run;
    const rng = makeRng(seed);
    const ops = genProgram(rng, 5 + Math.floor(rng() * 25));

    const plain = createSpektrum();
    const snapped = createSpektrum({ snapshotEvery: 1 + Math.floor(rng() * 4) });
    runProgram(plain, ops);
    runProgram(snapped, ops);

    const n = Math.floor(rng() * (plain.history.length + 1));
    plain.replay(n); plain.tick();
    snapped.replay(n); snapped.tick();

    assert.deepEqual(snapped.appState, plain.appState,
      `snapshotEvery changed replay output at n=${n} (seed ${seed})`);
  }
});

// === delta / state invariant ===

test('property: the delta is empty once tick() returns', () => {
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + 3000 + run;
    const rng = makeRng(seed);
    const s = createSpektrum();
    runProgram(s, genProgram(rng, 1 + Math.floor(rng() * 30)));
    assert.equal(Object.keys(s.appStateDelta).length, 0,
      `delta not drained (seed ${seed})`);
  }
});

test('property: every recorded set is readable at its path after tick', () => {
  // The last `set` to a given path wins, and the value that lands is the
  // value that was written — no coercion, no loss.
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + 4000 + run;
    const rng = makeRng(seed);
    const s = createSpektrum();
    const ops = genProgram(rng, 5 + Math.floor(rng() * 25))
      .filter(o => o.op === 'set');
    if (!ops.length) continue;
    runProgram(s, ops);

    const expected = new Map();
    for (const o of ops) expected.set(o.path, o.value);
    for (const [path, value] of expected) {
      // Skip paths shadowed by a later write to an ancestor/descendant —
      // object-vs-leaf collisions are a documented authoring hazard, not
      // an engine invariant.
      const collides = [...expected.keys()].some(other =>
        other !== path && (other.startsWith(path + '.') || path.startsWith(other + '.')));
      if (collides) continue;
      assert.deepEqual(getPathObj(s.appState, path), value,
        `path ${path} did not round-trip (seed ${seed})`);
    }
  }
});

// === prototype-pollution safety ===

test('property: no generated path can reach Object.prototype', () => {
  const NASTY = ['__proto__', 'prototype', 'constructor'];
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + 5000 + run;
    const rng = makeRng(seed);
    const s = createSpektrum();

    // Build paths that splice a prototype-reaching segment into an
    // otherwise ordinary dotted path, at a random position.
    for (let i = 0; i < 8; i++) {
      const segs = ['a', 'b', 'c'].slice(0, 1 + Math.floor(rng() * 3));
      segs.splice(Math.floor(rng() * (segs.length + 1)), 0,
        NASTY[Math.floor(rng() * NASTY.length)]);
      s.setValue(segs.join('.'), `polluted-${seed}-${i}`);
    }
    s.tick();

    assert.equal({}.polluted, undefined, `seed ${seed}`);
    assert.equal(Object.prototype.polluted, undefined, `seed ${seed}`);
    assert.equal(({}).b, undefined, `prototype slot leaked (seed ${seed})`);
    // The engine must survive the attempt, not just refuse it.
    s.setValue('healthy', 1);
    s.tick();
    assert.equal(s.appState.healthy, 1, `engine still usable (seed ${seed})`);
  }
});

// === history integrity ===

test('property: cursor stays within history and matches length after normal writes', () => {
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + 6000 + run;
    const rng = makeRng(seed);
    const s = createSpektrum();
    const ops = genProgram(rng, 1 + Math.floor(rng() * 25));
    runProgram(s, ops);
    assert.equal(s.cursor, s.history.length, `cursor drifted (seed ${seed})`);
    assert.ok(s.cursor >= 0 && s.cursor <= s.history.length, `cursor out of range (seed ${seed})`);
    assert.equal(s.history.length, ops.length, `history length != ops issued (seed ${seed})`);
  }
});

test('property: mutating while scrubbed back preserves the dropped tail on forks', () => {
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + 7000 + run;
    const rng = makeRng(seed);
    const s = createSpektrum();
    runProgram(s, genProgram(rng, 6 + Math.floor(rng() * 20)));

    const total = s.history.length;
    const n = Math.floor(rng() * total);
    s.replay(n);
    s.tick();
    s.setValue('after.scrub', 1);
    s.tick();

    const preserved = s.forks.reduce((sum, f) => sum + f.entries.length, 0);
    assert.equal(preserved, total - n,
      `dropped tail not fully preserved on forks (seed ${seed})`);
    assert.equal(s.history.length, n + 1, `history not truncated to cursor (seed ${seed})`);
  }
});

// === Known divergence: object writes merge, so batching is observable ===
//
// Found by the replay-determinism property above, which is exactly the
// kind of case nobody writes by hand. These tests PIN CURRENT BEHAVIOR
// so the gap is tracked rather than forgotten — they are not an
// endorsement of it. If a future change makes `setValue` replace plain
// objects, these tests SHOULD fail; update them then, and delete the
// type-stability workaround in genValue above.
//
// Root cause: `deepMerge` recurses into a plain-object source
// (`target[k]` is merged, not replaced) so that sub-path writes like
// `setValue('user.name', x)` don't wipe `user.email`. The delta cannot
// distinguish "this object is scaffolding for a sub-path write" from
// "this object is a whole value the caller passed", so both merge.
//
// Two consequences follow, and the second is the serious one.

test('known: setValue with a plain object MERGES rather than replaces', () => {
  const s = createSpektrum();
  s.setValue('user', { name: 'alice' });
  s.tick();
  s.setValue('user', { email: 'e@example.com' });
  s.tick();

  assert.deepEqual(s.appState.user, { name: 'alice', email: 'e@example.com' },
    'stale `name` survives what the docs call an absolute write');

  // An array value DOES replace — the asymmetry is the surprising part.
  s.setValue('list', [1, 2, 3]);
  s.tick();
  s.setValue('list', [9]);
  s.tick();
  assert.deepEqual(s.appState.list, [9], 'array sources overwrite wholesale');
});

test('known: tick batching changes the result, so replay can diverge', () => {
  // The same two writes produce different state depending only on
  // whether a tick ran between them. Since `history` records entries but
  // not tick boundaries, replay() (one entry per tick) cannot always
  // reproduce a run that batched — which is a gap in the determinism
  // guarantee, not merely a surprising merge rule.
  const separate = createSpektrum();
  separate.setValue('user', { name: 'alice' });
  separate.tick();
  separate.setValue('user', { email: 'e@example.com' });
  separate.tick();

  const batched = createSpektrum();
  batched.setValue('user', { name: 'alice' });
  batched.setValue('user', { email: 'e@example.com' });
  batched.tick();

  assert.deepEqual(separate.appState.user, { name: 'alice', email: 'e@example.com' });
  assert.deepEqual(batched.appState.user, { email: 'e@example.com' },
    'the delta collapses repeated writes before merging, so the first is lost');

  // And therefore: replaying the batched run does not reproduce it.
  const before = structuredClone(batched.appState);
  batched.replay(batched.history.length);
  batched.tick();
  assert.notDeepEqual(batched.appState, before,
    'PINNED: replay of a batched object-overwrite diverges from the original run');
  assert.deepEqual(batched.appState.user, { name: 'alice', email: 'e@example.com' },
    'replay produces the unbatched (merged) result');
});

test('known: the divergence does not affect type-stable writes', () => {
  // Scope of the gap: writing the same shape with the same keys replays
  // faithfully, which is why the properties above hold. Primitives and
  // arrays are unaffected entirely.
  const s = createSpektrum();
  s.setValue('cfg', { k: 1 });
  s.setValue('cfg', { k: 2 });
  s.setValue('n', 1);
  s.setValue('n', 2);
  s.tick();
  const before = structuredClone(s.appState);
  s.replay(s.history.length);
  s.tick();
  assert.deepEqual(s.appState, before, 'same-shape overwrites replay faithfully');
});

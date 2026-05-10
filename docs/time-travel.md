# Time-travel

Spektrum's distinguishing feature: every state mutation is a recorded entry in `history`. `replay(n)` reconstructs any past state. Scrub it, undo it, fork it, persist it across reloads — for free.

## How it works

Every `setValue` and `trigger` is recorded into `history`. `replay(n)` reconstructs the state after the first `n` entries. With `snapshotEvery`, replay finds the latest snapshot at-or-before `n` and walks forward only the remainder — turning O(n) replay into O(K) for long histories.

```js
const app = createSpektrum({
  historyLimit: 1000,    // cap recorded mutations; oldest drop on overflow
  snapshotEvery: 50,     // capture appState every 50 entries → O(K) replay
  forkLimit: 50,         // cap preserved fork tails; oldest drop on overflow
});
```

## Devtools scrubber

Drop in the optional devtools panel for a scrubber UI:

```js
import { mount } from 'spektrum/devtools';
const unmount = mount(spektrum);   // top-right by default
```

See [modules → devtools](modules.md#spektrumdevtools) for the full options.

## Persisting across reloads

```js
import { autoSave, loadHistory } from 'spektrum/persist';
loadHistory(spektrum);                       // restore on boot
autoSave(spektrum, { debounce: 200 });       // save on every mutation
```

See [modules → persist](modules.md#spektrumpersist) for the full storage surface (custom `key`, alternative backends, validation caps).

## Checkpoints

A logically atomic event ("a search completed", "a form submitted", "wizard step 3 finished") is a *span* of `setValue` calls in Spektrum, not a single one. Replaying to the *end* of one of those spans used to require an app-side sentinel pattern (`setValue('_marker', …)` placed carefully as the last write). `checkpoint(name, metadata?)` is the first-class form:

```js
spektrum.checkpoint('search-done', { query: 'amsterdam' });
```

A checkpoint records a tagged history entry (`op: 'checkpoint'`) that has **no state effect** — `replay()` walks past it unchanged. It fires `onRecord` so `autoSave` catches it. The companion getter `spektrum.checkpoints` returns each checkpoint entry plus its position in `history`:

```js
// Replay to right after a named checkpoint:
const cp = spektrum.checkpoints.find(c => c.id === 'search-done');
spektrum.replay(cp.index + 1);
```

The `+1` lands at the position *after* the checkpoint — the checkpoint itself contributes no state, so `cp.index` and `cp.index + 1` represent the same state, but the +1 form is convention so the cursor sits past the marker.

Persisted via `spektrum/persist` (`loadHistory` recognises `op: 'checkpoint'` and re-applies via the same `checkpoint()` API). The devtools panel renders checkpoint entries with a `◆` accent so they're scannable in the scrubber log.

## Forking history

Mutating while scrubbed back overwrites the future entries with the new edit. The dropped tail isn't lost — it's preserved on `spektrum.forks` and the optional `onFork` hook fires:

```js
spektrum.onFork((fork) => {
  // fork = { entries, forkedAt, ts }
  console.warn(`discarded ${fork.entries.length} future edits at cursor ${fork.forkedAt}`);
});
```

Each fork is a plain `HistoryEntry[]` (no new types), tagged with the cursor it forked from and a wall-clock timestamp. Restore by re-applying:

```js
const restore = (fork) => {
  for (const e of fork.entries) {
    if (e.op === 'set') spektrum.setValue(e.path, e.value, e.id);
    else spektrum.trigger(e.id, e.path, e.value);
  }
};

restore(spektrum.forks.at(-1));   // re-apply the most recently dropped tail
```

Hook is descriptive: by the time it fires, the truncate has happened. To get a confirm-before-discard UX, run the prompt in your `data-fn` handler before calling the mutator. The fork array is capped by `forkLimit` (default `50`); set `forkLimit: 0` to discard forks immediately, `Infinity` to keep all of them.

## Speculative execution via `attempt()`

Time-travel + a checkpoint is enough to express "try a change, evaluate, commit or discard." The `attempt()` helper bundles that pattern:

```js
const h = spektrum.attempt('try-bump', () => {
  spektrum.setValue('count', 99);
  return validate(spektrum.appState);
});
if (await h.result) h.commit(); else h.discard();
```

See the [AGENTS.md → speculative execution](../AGENTS.md#workflow) section for the full workflow.

## Performance notes

- `replay` without `snapshotEvery` is O(n) per scrub; with snapshots, O(n mod K).
- `historyLimit` caps memory at the cost of unbounded scrubback — replay below the surviving window is undefined.
- `history.splice(0, n)` on overflow is O(n); see [trade-offs](trade-offs.md#historysplice0-n-on-historylimit-overflow-is-on).

## Related

- [Public API](api.md) — `replay`, `checkpoint`, `attempt`, hooks
- [Modules → devtools](modules.md#spektrumdevtools) — scrubber panel
- [Modules → persist](modules.md#spektrumpersist) — localStorage round-trip
- [AGENTS.md](../AGENTS.md) — agents using time-travel as speculative execution

/**
 * Spektrum — tiny reactive engine with declarative HTML bindings,
 * fan-out, and time-travel replay.
 */

export type State = Record<string, any>;

export interface HistoryEntry {
  id: string;
  path: string;
  value: any;
  op: 'add' | 'set' | 'checkpoint';
}

/** A checkpoint entry as surfaced by `Spektrum.checkpoints` —
 *  a `HistoryEntry` augmented with its position in `history`. */
export interface CheckpointView extends HistoryEntry {
  op: 'checkpoint';
  /** Index in `history` where this checkpoint sits. */
  index: number;
}

export interface Snapshot {
  /** History index after which this snapshot was captured. */
  index: number;
  /** Frozen copy of `appState` at that point. */
  state: State;
}

export interface ForkRecord {
  /** The dropped tail of history entries, in original order. */
  entries: HistoryEntry[];
  /** Cursor position the fork branched from. */
  forkedAt: number;
  /** Wall-clock timestamp (ms) when the fork was captured. */
  ts: number;
}

export type SystemFn = (state: State, delta: State) => void;

/**
 * Closed enum of engine-attached error codes. User-thrown errors
 * from system functions pass through unchanged (no `code`). Engine-
 * originated errors carry one of these:
 *
 *  - `E_TICK_OVERFLOW`: tick fan-out exceeded 1024 iterations and
 *    the delta was discarded. Indicates a runaway feedback cycle
 *    between systems.
 */
export type EngineErrorCode = 'E_TICK_OVERFLOW';

/**
 * Errors received by `onError`. Engine-originated errors carry a
 * `code` discriminator; system-thrown errors are passed through
 * with their original identity (no `code`).
 */
export type ErrorHandler = (
  err: Error & { code?: EngineErrorCode },
  system: SystemFn | null,
) => void;

export type RecordHandler = (entry: HistoryEntry) => void;

export type ForkHandler = (fork: ForkRecord) => void;

export type BoundFn = (
  el: HTMLElement,
  state: State,
  delta: State,
  value: any,
  /**
   * The DOM event that triggered the handler, when applicable.
   * Available for `data-action="event[.modifier]*"` bindings;
   * `undefined` for `data-action="cycle"` (subscription-driven, no event).
   */
  event?: Event
) => void;

export interface SpektrumOptions {
  /**
   * Cap `history.length`. When exceeded, oldest entries are dropped
   * (FIFO). With a limit set, replay() to indices below the surviving
   * window is undefined — don't set this if you need unlimited
   * scrubback.
   */
  historyLimit?: number;
  /**
   * Capture an `appState` snapshot every K recorded entries so
   * replay() costs O(K) instead of O(n). Snapshots are dropped
   * alongside the entries they cover when `historyLimit` trims.
   */
  snapshotEvery?: number;
  /**
   * Cap the number of preserved fork tails on `forks`. Defaults
   * to 50; oldest are evicted on overflow. Set `Infinity` to
   * disable trimming. Set `0` to discard forks immediately (the
   * `onFork` hook still fires, but `forks` stays empty).
   */
  forkLimit?: number;
}

export interface Spektrum {
  /** Committed state. Direct mutation persists; setValue/trigger go through the delta. */
  readonly appState: State;
  /** Pending writes for the next tick. Cleared at the start of each pass. */
  readonly appStateDelta: State;
  /** Append-only log of recorded mutations. */
  readonly history: HistoryEntry[];
  /** Replay-acceleration snapshots. Populated only when `snapshotEvery` is set. */
  readonly snapshots: Snapshot[];
  /**
   * Tails of history dropped by mutate-while-scrubbed-back, oldest
   * first. Each entry is a plain `HistoryEntry[]` plus the cursor
   * it forked from and a timestamp; restore by re-applying via
   * `setValue` / `trigger`. Capped by `forkLimit`.
   */
  readonly forks: ForkRecord[];
  /** DOM handles registered via `data-ref="name"`. Keyed by the ref name. */
  readonly refs: Record<string, Element>;
  /** Index of the next history slot. Equals history.length unless scrubbed back via replay. */
  readonly cursor: number;
  /** True while replay() is in flight. */
  readonly replaying: boolean;
  /**
   * Filtered view of `history`: every checkpoint entry with its
   * history index appended. Allocates on read; for hot paths walk
   * `history` directly and filter inline.
   */
  readonly checkpoints: CheckpointView[];

  /** Record an additive numeric change. Multiple triggers in one tick accumulate. */
  trigger(id: string, path: string, value: number): void;
  /** Record an absolute set. `id` defaults to `set:${path}`. */
  setValue(path: string, value: any, id?: string): void;
  /**
   * Record a tagged checkpoint into history. Pure marker — replay
   * walks past it without state effect. Use to mark logically atomic
   * boundaries (search complete, form submitted, wizard step done).
   * Fires `onRecord`. Replay-to-checkpoint:
   *   spektrum.replay(spektrum.checkpoints.find(c => c.id === name).index + 1)
   */
  checkpoint(name: string, metadata?: any): void;
  /**
   * First-class derived value. Primes synchronously from current state
   * on registration (so registering after deps are populated still
   * lands the initial value), then re-computes when any `deps` path
   * changes. Writes to both state and delta so mid-tick reads see
   * fresh values.
   */
  computed(path: string, deps: string[], fn: (state: State) => any): () => void;
  /**
   * Async resource. Sets `${path}.loading` / `${path}.error` /
   * `${path}.data` as the promise progresses. Each phase records
   * through setValue (so the round-trip lands in history; replay
   * re-applies the values without re-issuing the fetch). Returns the
   * run function for refetching.
   */
  addAsync<T = any>(path: string, fn: () => Promise<T>): () => Promise<void>;

  /** Subscribe a system to one or more paths. Returns an unsubscribe function. */
  addSystem(paths: string[], fn: SystemFn): () => void;
  /** Conventional alias for `addSystem`. Same signature. */
  watch(deps: string[], fn: SystemFn): () => void;
  /** Detach the first system registered with `fn`. Returns true if removed. */
  removeSystem(fn: SystemFn): boolean;
  /** Register a named handler callable from `data-fn` attributes. */
  defineFn(name: string, fn: BoundFn): void;
  /**
   * Install an error handler. Called as `(err, systemFn)` whenever a
   * subscribed system throws inside tick(). One handler per instance
   * — later calls replace earlier. Pass `null` to clear; without a
   * handler, errors fall through to console.error.
   */
  onError(fn: ErrorHandler | null): void;
  /**
   * Install a post-record hook. Called synchronously with every
   * recorded `HistoryEntry` after it's been applied, snapshotted,
   * and trimmed. Does not fire during `replay()` (replay re-applies
   * without re-recording). One handler per instance.
   */
  onRecord(fn: RecordHandler | null): void;
  /**
   * Install a fork hook. Fires when a `record()` truncates history
   * (mutate-while-scrubbed-back), receiving the captured `ForkRecord`.
   * Descriptive: the truncate has already happened by the time the
   * hook runs; the dropped entries are accessible on `forks` and via
   * the hook argument. One handler per instance.
   */
  onFork(fn: ForkHandler | null): void;

  /**
   * Scan a DOM subtree for declarative bindings: {{expr}}, :attr="expr",
   * data-if, data-each, data-key, data-model, data-ref, and data-action.
   * Returns a destroy function that undoes every binding it set up.
   */
  bindDOM(root?: Element | Document): () => void;
  /** rAF-driven tick pump. Reschedules itself every animation frame. */
  run(): void;
  /** Run one simulation step, draining the delta to quiescence. */
  tick(): void;

  /** Reset state and re-apply the first `n` recorded entries. O(K) when snapshotEvery is set. */
  replay(n: number): void;
  /**
   * Wipe runtime state, refs, history, snapshots, forks. **Preserves**
   * registered systems, defineFn entries, and hooks (onError, onRecord,
   * onFork). Use this from library code that wants to clear state
   * without nuking the host app's subscriptions.
   */
  resetState(): void;
  /**
   * Same as `resetState()`, but also clears systems registered via
   * `addSystem`. Built-in fns and hook registrations survive. Warns
   * when active systems are present at call time — silent detachment
   * has bitten users; call `resetState()` instead when you only want
   * to wipe state.
   */
  reset(): void;

  /**
   * Serialize a portable snapshot of the instance. By default
   * includes `state`, `history`, and `cursor` so a fresh instance
   * can `loadHistory` it back to the same point. Pass
   * `{ includeHistory: false }` for a state-only snapshot;
   * `{ includeForks: true }` to also include preserved fork tails
   * (debug-only; forks aren't replay-restored by `loadHistory`).
   */
  serialize(opts?: { includeHistory?: boolean; includeForks?: boolean }): string;
}

/** Walk a dotted path into `obj` and return the leaf value, or undefined. */
export function getPathObj<T = any>(obj: object, path: string): T | undefined;

/** Walk `path` (creating missing parents) and assign `value` at the leaf. */
export function setPathValue(obj: object, path: string, value: any): void;

/**
 * Register a precompiled expression function. Build-time tooling
 * (see `spektrum-compile.js`) emits one call per unique template
 * expression, letting Spektrum run under strict CSP — the runtime
 * never reaches the `new Function` fallback when the cache hits.
 */
export function precompile(source: string, fn: (state: State) => any): void;

/** Create an isolated Spektrum instance. */
export function createSpektrum(opts?: SpektrumOptions): Spektrum;

declare const _default: Spektrum;
export default _default;

// Named exports of the default singleton's methods/state. Live bindings
// for `appState`, `appStateDelta`, `history`, `snapshots`, and `refs`
// (same object refs as the singleton's). For `cursor` and `replaying`
// use the default import or `createSpektrum()` and read the property.
export const appState: State;
export const appStateDelta: State;
export const history: HistoryEntry[];
export const snapshots: Snapshot[];
export const forks: ForkRecord[];
export const refs: Record<string, Element>;
export const trigger: Spektrum['trigger'];
export const setValue: Spektrum['setValue'];
export const checkpoint: Spektrum['checkpoint'];
export const computed: Spektrum['computed'];
export const addAsync: Spektrum['addAsync'];
export const addSystem: Spektrum['addSystem'];
export const watch: Spektrum['watch'];
export const removeSystem: Spektrum['removeSystem'];
export const defineFn: Spektrum['defineFn'];
export const onError: Spektrum['onError'];
export const onRecord: Spektrum['onRecord'];
export const onFork: Spektrum['onFork'];
export const bindDOM: Spektrum['bindDOM'];
export const run: Spektrum['run'];
export const tick: Spektrum['tick'];
export const replay: Spektrum['replay'];
export const reset: Spektrum['reset'];
export const resetState: Spektrum['resetState'];
export const serialize: Spektrum['serialize'];

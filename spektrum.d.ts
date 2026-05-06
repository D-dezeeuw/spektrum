/**
 * Spektrum — tiny reactive engine with declarative HTML bindings,
 * fan-out, and time-travel replay.
 */

export type State = Record<string, any>;

export interface HistoryEntry {
  id: string;
  path: string;
  value: any;
  op: 'add' | 'set';
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

export type ErrorHandler = (err: unknown, system: SystemFn) => void;

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

  /** Record an additive numeric change. Multiple triggers in one tick accumulate. */
  trigger(id: string, path: string, value: number): void;
  /** Record an absolute set. `id` defaults to `set:${path}`. */
  setValue(path: string, value: any, id?: string): void;
  /** First-class derived value: re-computed when any `deps` path changes. */
  computed(path: string, deps: string[], fn: (state: State) => any): () => void;

  /** Subscribe a system to one or more paths. Returns an unsubscribe function. */
  addSystem(paths: string[], fn: SystemFn): () => void;
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
export const computed: Spektrum['computed'];
export const addSystem: Spektrum['addSystem'];
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

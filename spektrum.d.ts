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

export type SystemFn = (state: State, delta: State) => void;

export type BoundFn = (
  el: HTMLElement,
  state: State,
  delta: State,
  value: any
) => void;

export interface Spektrum {
  /** Committed state. Direct mutation persists; setValue/trigger go through the delta. */
  readonly appState: State;
  /** Pending writes for the next tick. Cleared at the start of each pass. */
  readonly appStateDelta: State;
  /** Append-only log of recorded mutations. */
  readonly history: HistoryEntry[];
  /** Index of the next history slot. Equals history.length unless scrubbed back via replay. */
  readonly cursor: number;
  /** True while replay() is in flight. */
  readonly replaying: boolean;

  /** Record an additive numeric change. Multiple triggers in one tick accumulate. */
  trigger(id: string, path: string, value: number): void;
  /** Record an absolute set. `id` defaults to `set:${path}`. */
  setValue(path: string, value: any, id?: string): void;

  /** Subscribe a system to one or more paths. Returns an unsubscribe function. */
  addSystem(paths: string[], fn: SystemFn): () => void;
  /** Detach the first system registered with `fn`. Returns true if removed. */
  removeSystem(fn: SystemFn): boolean;
  /** Register a named handler callable from `data-fn` attributes. */
  defineFn(name: string, fn: BoundFn): void;

  /**
   * Scan a DOM subtree for declarative bindings: {{path}}, :attr="path",
   * data-if, data-each, and data-action. Returns a destroy function that
   * undoes every binding it set up.
   */
  bindDOM(root?: Element | Document): () => void;
  /** rAF-driven tick pump. Reschedules itself every animation frame. */
  run(): void;
  /** Run one simulation step, draining the delta to quiescence. */
  tick(): void;

  /** Reset state and re-apply the first `n` recorded entries. O(n). */
  replay(n: number): void;
  /** Wipe runtime state. Built-in fns survive (set up at instance creation). */
  reset(): void;
}

/** Walk a dotted path into `obj` and return the leaf value, or undefined. */
export function getPathObj<T = any>(obj: object, path: string): T | undefined;

/** Walk `path` (creating missing parents) and assign `value` at the leaf. */
export function setPathValue(obj: object, path: string, value: any): void;

/** Create an isolated Spektrum instance. */
export function createSpektrum(): Spektrum;

declare const _default: Spektrum;
export default _default;

// Named exports of the default singleton's methods/state. Live bindings
// for `appState`, `appStateDelta`, and `history` (same object refs as
// the singleton's). For `cursor` and `replaying` use the default import
// or `createSpektrum()` and read the property.
export const appState: State;
export const appStateDelta: State;
export const history: HistoryEntry[];
export const trigger: Spektrum['trigger'];
export const setValue: Spektrum['setValue'];
export const addSystem: Spektrum['addSystem'];
export const removeSystem: Spektrum['removeSystem'];
export const defineFn: Spektrum['defineFn'];
export const bindDOM: Spektrum['bindDOM'];
export const run: Spektrum['run'];
export const tick: Spektrum['tick'];
export const replay: Spektrum['replay'];
export const reset: Spektrum['reset'];

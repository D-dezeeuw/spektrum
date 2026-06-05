/**
 * Type declarations for `spektrum/persist` — Web Storage helpers that
 * round-trip `spektrum.history` so time-travel survives reloads.
 *
 * Source of truth: `companions/spektrum-persist.js`. When the runtime
 * shape changes, update this file in the same commit.
 */

import type { Spektrum } from '../spektrum.js';

/** Minimal Web Storage shape — `localStorage`, `sessionStorage`, or
 *  any custom `{ getItem, setItem }` pair. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Options shared by the persistence helpers. */
export interface PersistOptions {
  /** Storage key. Defaults to `'spektrum:history'`. */
  key?: string;
  /** Storage backend. Defaults to `globalThis.localStorage`. */
  storage?: StorageLike;
}

/** Options for {@link loadHistory}. */
export interface LoadOptions extends PersistOptions {
  /** Cap on replayed entries (defends against an oversized stored
   *  array). Defaults to `100_000`. */
  maxEntries?: number;
}

/** Options for {@link autoSave}. */
export interface AutoSaveOptions extends PersistOptions {
  /** Coalesce writes within this many milliseconds. Omit to save
   *  synchronously on every recorded mutation. */
  debounce?: number;
}

/**
 * Serialize `spektrum.history` into storage, overwriting any prior
 * value at the same key. Returns `false` on failure (quota, private
 * mode, no storage) — never throws.
 */
export function saveHistory(spektrum: Spektrum, opts?: PersistOptions): boolean;

/**
 * Restore history into `spektrum`. Calls `resetState()` first
 * (preserving systems, `defineFn` registrations, and hooks), then
 * replays each validated entry through the public mutators so the
 * cursor and subscribed systems behave as if re-typed. Returns `true`
 * if anything was loaded.
 */
export function loadHistory(spektrum: Spektrum, opts?: LoadOptions): boolean;

/**
 * Save on every recorded mutation by subscribing to `onRecord`.
 * Returns a `stop()` that detaches only this autoSave hook — other
 * `onRecord` subscribers keep firing.
 */
export function autoSave(spektrum: Spektrum, opts?: AutoSaveOptions): () => void;

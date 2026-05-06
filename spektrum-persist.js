/*
  Spektrum — persistence helpers.

  Time-travel only matters across reloads if you can save the
  history. These two helpers shove `history` into and out of any
  Web Storage-shaped backend (localStorage, sessionStorage, or any
  custom { getItem, setItem } pair).

  Standalone module, zero deps. Not bundled into spektrum.js — opt
  in only when you want persistence. Not every app should persist
  history; for those that do, the round-trip is a few lines.

  Usage:

    import { saveHistory, loadHistory, autoSave } from 'spektrum/persist';

    loadHistory(spektrum);              // restore on boot
    autoSave(spektrum);                 // save on every mutation
*/

const DEFAULT_KEY = 'spektrum:history';

/**
 * Serialize `spektrum.history` into storage. Overwrites any prior
 * value at the same key. Throws nothing on failure (storage quota,
 * private mode, etc.) — returns false instead.
 */
export const saveHistory = (spektrum, opts = {}) => {
  const key = opts.key || DEFAULT_KEY;
  const storage = opts.storage || globalThis.localStorage;
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(spektrum.history));
    return true;
  } catch {
    return false;
  }
};

/**
 * Restore history into `spektrum`. Resets the instance first, then
 * replays the loaded entries through the public mutators (so the
 * cursor and any subscribed systems behave as if the user had typed
 * them again). Returns true if anything was loaded, false otherwise.
 *
 * Belt-and-braces validation: storage is attacker-reachable (XSS,
 * malicious extension, third-party tooling). Each entry is checked
 * for shape before being replayed, and replay is capped at
 * `opts.maxEntries` (default 100_000) to bound work even if the
 * stored array is enormous. The engine's path walker also rejects
 * prototype-pollution segments (see SAFE_KEY in spektrum.js), so
 * even an unfiltered entry cannot reach a prototype slot.
 */
export const loadHistory = (spektrum, opts = {}) => {
  const key = opts.key || DEFAULT_KEY;
  const storage = opts.storage || globalThis.localStorage;
  if (!storage) return false;
  const raw = storage.getItem(key);
  if (!raw) return false;
  let entries;
  try { entries = JSON.parse(raw); } catch { return false; }
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const maxEntries = opts.maxEntries ?? 100_000;
  if (entries.length > maxEntries) entries = entries.slice(0, maxEntries);
  spektrum.reset();
  for (const e of entries) {
    if (!e || typeof e.path !== 'string') continue;
    if (e.op === 'set') spektrum.setValue(e.path, e.value, e.id);
    else if (e.op === 'add' && Number.isFinite(e.value)) spektrum.trigger(e.id, e.path, e.value);
  }
  spektrum.tick();
  return true;
};

/**
 * Auto-save on every recorded mutation. Hooks into the engine's
 * `onRecord` so internal writes (e.g. `data-model` two-way bindings)
 * trigger a save the same way explicit `setValue` calls do.
 * Returns a stop() that detaches the hook.
 *
 * Note: only one onRecord handler is active per instance — calling
 * autoSave replaces any prior handler. For high-frequency mutations
 * pass `{ debounce: 200 }` to coalesce writes.
 */
export const autoSave = (spektrum, opts = {}) => {
  let timer = null;
  const flush = () => { saveHistory(spektrum, opts); timer = null; };
  const schedule = opts.debounce
    ? () => { if (timer) clearTimeout(timer); timer = setTimeout(flush, opts.debounce); }
    : flush;

  spektrum.onRecord(() => schedule());

  return () => {
    if (timer) clearTimeout(timer);
    spektrum.onRecord(null);
  };
};

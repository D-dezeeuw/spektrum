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
 * Restore history into `spektrum`. Wipes runtime state first via
 * `resetState()` — preserves systems, defineFn registrations, and
 * hooks so the host app's subscriptions survive a reload. Then
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
  // Keep the NEWEST entries, matching the engine's own `historyLimit`
  // (which drops from the front on overflow). Slicing from the front
  // here instead kept the OLDEST, so an over-cap restore silently
  // booted the app into ancient state rather than where the user left
  // it — the opposite of what "cap the restore" implies, and the
  // opposite of what the engine does with the same word.
  if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
  // resetState() — not reset() — so app-level systems registered
  // before loadHistory() survive the load. reset() would silently
  // detach them and warn loudly; we want neither.
  spektrum.resetState();
  for (const e of entries) {
    if (!e) continue;
    // Checkpoints carry no path (op === 'checkpoint', path === ''),
    // so the path-shape check is op-conditional. Other ops still
    // require a non-empty string path.
    if (e.op === 'checkpoint' && typeof e.id === 'string') {
      spektrum.checkpoint(e.id, e.value);
      continue;
    }
    if (typeof e.path !== 'string') continue;
    if (e.op === 'set') spektrum.setValue(e.path, e.value, e.id);
    else if (e.op === 'add' && Number.isFinite(e.value)) spektrum.trigger(e.id, e.path, e.value);
  }
  spektrum.tick();
  return true;
};

/**
 * Auto-save on every recorded mutation. Hooks into the engine's
 * `onRecord` so internal writes (e.g. `data-model` two-way bindings)
 * trigger a save the same way explicit `setValue` calls do. Returns a
 * stop() that detaches just the autoSave hook — other onRecord
 * subscribers (telemetry, supervisor mirrors, etc.) keep firing.
 *
 * For high-frequency mutations pass `{ debounce: 200 }` to coalesce writes.
 *
 * With `debounce` set, a pending save is flushed when the page is
 * hidden or unloaded, so the last debounce-window of edits isn't lost
 * on close. Pass `{ flushOnHide: false }` to opt out (e.g. in a test
 * harness, or when the storage backend is remote and you'd rather drop
 * the tail than issue a write during teardown).
 */
export const autoSave = (spektrum, opts = {}) => {
  let timer = null;
  const flush = () => { saveHistory(spektrum, opts); timer = null; };
  const schedule = opts.debounce
    ? () => { if (timer) clearTimeout(timer); timer = setTimeout(flush, opts.debounce); }
    : flush;

  const unsub = spektrum.onRecord(() => schedule());

  // `pagehide` rather than `beforeunload`: mobile Safari and Chrome
  // routinely discard a backgrounded page without ever firing
  // beforeunload, which is exactly the case that loses data. The
  // visibilitychange arm covers tab-switch-then-kill. Both write
  // synchronously — no await, small payload — because the page may not
  // survive to a later task.
  const onHide = () => { if (timer) { clearTimeout(timer); flush(); } };
  const onVisibility = () => {
    if (globalThis.document?.visibilityState === 'hidden') onHide();
  };
  const hookHide = opts.flushOnHide !== false && !!opts.debounce
    && typeof globalThis.addEventListener === 'function';
  if (hookHide) {
    globalThis.addEventListener('pagehide', onHide);
    globalThis.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    if (timer) clearTimeout(timer);
    if (hookHide) {
      globalThis.removeEventListener('pagehide', onHide);
      globalThis.removeEventListener('visibilitychange', onVisibility);
    }
    unsub();
  };
};

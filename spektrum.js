/*
  Spektrum — tiny reactive engine.

  Mutations write into a per-instance delta. Each tick drains the delta
  to quiescence, merging into `appState` and firing subscribed systems.
  Every mutation is logged to `history` so `replay(n)` rebuilds any
  past point. `createSpektrum()` makes an isolated instance; the
  default singleton serves the single-instance case.
*/

// === Module-level constants and pure utilities ===
// Instance-independent; live outside the factory.

const MUSTACHE = /\{\{\s*([^}]+?)\s*\}\}/g;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Namespaced console.warn — every internal warning prefixes
 *  `[spektrum]`, factoring it out shaves bytes after minification. */
const warn = (msg) => console.warn('[spektrum] ' + msg);

/**
 * Reject path segments and JSON keys that would touch a prototype slot.
 * Applied at every path-walk and merge site so attacker-controlled
 * strings (paths from persisted state, JSON-parsed payloads) cannot
 * mutate `Object.prototype`.
 */
const SAFE_KEY = (k) => k !== '__proto__' && k !== 'prototype' && k !== 'constructor';

/**
 * Property-write attributes that take a URL. When their bound
 * expression evaluates to a string starting with `javascript:`, we
 * rewrite to `#` so a stale path or attacker-influenced value can't
 * smuggle script execution through `<a :href="…">` and friends.
 *
 * `srcdoc` is deliberately NOT included — its value is parsed as HTML,
 * not a URL, so a `javascript:` scheme check would give false
 * confidence. README documents that `:srcdoc` with untrusted input is
 * unsafe (same trust caveat as templates).
 *
 * `xlink:href` is also out of scope: the engine writes via property
 * (`el[prop] = v`), not `setAttribute`, and SVG navigation exposes no
 * `xlink:href` JS property — the binding is effectively dead-letter.
 */
const URL_PROPS = /^(href|src|action|formaction|background|cite|poster|data)$/;
const JS_SCHEME = /^\s*javascript:/i;

/** Recognised data-action modifiers. `data-action="click.preventdefault"`
 *  was a frequent typo that silently fell off the modifier path; we now
 *  warn at bind time. Regex is ~15 B cheaper than `new Set([…]).has()`. */
const KNOWN_MODIFIERS = /^(prevent|stop|once)$/;

/** Walk a dotted path into `obj`. Returns the leaf value or undefined. */
export const getPathObj = (obj, path) =>
  path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);

/** True if every segment of `path` resolves on `obj`. */
const isPath = (obj, path) =>
  path.split('.').every(k => SAFE_KEY(k) && (obj = obj == null ? undefined : obj[k]) !== undefined);

/**
 * Materialise *intermediate* segments of `path` as `{}` on `obj`. The
 * leaf is left absent — earlier versions materialised it too, which
 * polluted appState with `{}` placeholders that bindings read back
 * pre-tick, producing `"[object Object]"` on `<input>.value`.
 *
 * Bails on any unsafe segment (`__proto__`, `prototype`, `constructor`)
 * so a malicious path cannot reach a prototype slot.
 */
const createNestedObjects = (obj, path) => {
  const keys = path.split('.');
  if (!keys.every(SAFE_KEY)) return obj;
  keys.pop();
  keys.reduce((acc, k) => (acc[k] = acc[k] || {}), obj);
  return obj;
};

/** Walk `path` (creating missing parents) and assign `value` at the leaf. */
export const setPathValue = (obj, path, value) => {
  const keys = path.split('.');
  if (!keys.every(SAFE_KEY)) return;
  const last = keys.pop();
  const target = keys.reduce((acc, k) => (acc[k] = acc[k] || {}), obj);
  target[last] = value;
};

const deepMerge = (target, source) => {
  /*
    Recursive in-place merge: plain values overwrite, nested objects
    descend.

    Sub-path edits on arrays produce a source like `{items: {0: {note:
    'x'}}}` — the path walker creates plain-object intermediates, even
    when the target slot is an array. We must merge into the existing
    array (writing index 0's properties) rather than replacing it.
    Arrays accept numeric-string property writes the same way objects
    do, so the recursion is safe; we only reset the slot when the
    target is a non-object that can't be descended into (primitive or
    null), which would otherwise throw on property write.

    Whole-array replacement still happens via the else branch when
    `source[k]` is itself an Array — `setValue('items', newArr)` lays
    the array directly into the delta and wins over the existing slot.
  */
  for (const k of Object.keys(source)) {
    if (!SAFE_KEY(k)) continue;
    const v = source[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (target[k] == null || typeof target[k] !== 'object') {
        target[k] = {};
      }
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
};

const clearObject = (obj) => {
  /* Drop every own key on `obj` in place. */
  for (const k of Object.keys(obj)) delete obj[k];
};

const parseValue = (s) => {
  /* Coerce a `data-value` string: ""→undefined, bool literals, numeric, else string. */
  if (s === undefined || s === '') return undefined;
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  return Number.isNaN(n) ? s : n;
};

const callAll = (fns) => fns.forEach(f => f && f());

// Built-in `data-fn` helpers. History id falls back to "<fn>@<id>"
// so unnamed actions still get a stable label; value falls back to
// the element's own value so form inputs work without an explicit
// data-value. Pure functions of the element + arg, hoisted out of
// the factory so multiple instances don't each carry a copy.
const histId = (el) => el.dataset.name || `${el.dataset.fn}@${el.dataset.id}`;
const fnVal  = (el, v) => v ?? parseValue(el.value);

// === Expression engine ===
// Compile-on-first-use, cached by source string. Templates are
// author-written, so `new Function` is acceptable (same caveat as
// Vue and Alpine — don't accept untrusted templates). For CSP
// deployments that disable `unsafe-eval`, pre-register every
// expression via `precompile()` from a build step — `new Function`
// then never runs (the cache hits first).

const EVAL_CACHE_LIMIT = 500;
const evalCache = new Map();

const cacheSet = (k, v) => {
  // FIFO eviction — Map preserves insertion order. Bounds memory for
  // long-running pages that mint many distinct expressions (e.g.
  // dynamic per-row strings inside a frequently rebuilt data-each).
  if (evalCache.size >= EVAL_CACHE_LIMIT) {
    evalCache.delete(evalCache.keys().next().value);
  }
  evalCache.set(k, v);
};

const evalExpr = (expr) => {
  let fn = evalCache.get(expr);
  if (fn) return fn;
  try {
    // Dotted-numeric segments (e.g. `users.0.name`, the form bindEach
    // produces) → bracket notation (`users[0].name`) so JS can parse.
    const normalized = expr.replace(/([a-zA-Z_$][\w$]*)\.(\d+)/g, '$1[$2]');
    const compiled = new Function('state', `with (state) { return (${normalized}); }`);
    // Runtime try/catch so references to paths not yet in state (e.g.
    // before the first tick) render as undefined instead of throwing.
    fn = (state) => { try { return compiled(state); } catch { return undefined; } };
  } catch (err) {
    // CSP that disables `unsafe-eval` lands here. Without a precompiled
    // entry, the binding renders as undefined.
    warn('invalid expression: "' + expr + '" ' + err);
    fn = () => undefined;
  }
  cacheSet(expr, fn);
  return fn;
};

/**
 * Register a precompiled expression function. Build-time tooling
 * walks templates, emits one `precompile(source, fn)` call per unique
 * expression, and ships those calls in a sibling module loaded
 * before `bindDOM`. With every expression precompiled, the runtime
 * never reaches the `new Function` fallback — safe under strict CSP.
 */
export const precompile = (source, fn) => cacheSet(source, fn);

// Lookbehind excludes identifiers preceded by `.` or `\w` so
// `user.name.toUpperCase` matches as one path, not three.
const IDENT = /(?<![\w$.])([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/g;
// Identifier-heads that are JS globals or keywords, not state paths.
// Templates referencing anything dropped from this list still work
// (with(state) falls through to globals) — they just over-subscribe to
// a path that never fires. Trim is therefore behavior-neutral; entries
// kept are the ones common in real templates. URI helpers, parseInt /
// isNaN / isFinite, RegExp / Map / Set / Symbol / Error were dropped
// in 0.3.6 to free byte budget.
const RESERVED = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'this',
  'Math', 'JSON', 'Date', 'Number', 'String', 'Array', 'Object', 'Boolean',
]);

/** Pull subscription paths out of an expression. Reserved-word heads
 *  (Math, JSON, true, ...) are filtered. False positives from string
 *  literals or bracket access are harmless (subscriptions to
 *  non-existent paths just never fire). */
const extractPaths = (expr) => {
  const paths = new Set();
  for (const m of expr.matchAll(IDENT)) {
    const id = m[1];
    if (RESERVED.has(id.split('.')[0])) continue;
    paths.add(id);
  }
  return [...paths];
};

/** Set element classes. Accepts a string (overwrites), an array
 *  (filtered + joined, overwrites), or an object (`{name: bool}` —
 *  toggles named classes individually, preserves siblings). */
const applyClass = (el, v) => {
  if (typeof v === 'string') el.className = v;
  else if (Array.isArray(v)) el.className = v.filter(Boolean).join(' ');
  else if (v && typeof v === 'object') {
    for (const [name, on] of Object.entries(v)) el.classList.toggle(name, !!on);
  }
};

// Hand-written walker — happy-dom's TreeWalker silently returns no
// nodes for SHOW_TEXT filters even when text descendants exist.
const walkTextNodes = (root, visit) => {
  if (root.nodeType === 3) {
    visit(root);
    return;
  }
  for (const child of root.childNodes) walkTextNodes(child, visit);
};

// === Factory ===

/**
 * Create an isolated Spektrum instance. Each call returns its own
 * state, delta, history, systems, fns, and refs — fully separate
 * from other instances.
 *
 * Options:
 *   historyLimit  Cap `history.length`. Oldest entries drop on overflow.
 *                 With a cap, replay() to indices below the surviving
 *                 window is undefined; don't set this if you need
 *                 unlimited scrubback.
 *   snapshotEvery Capture an `appState` snapshot every K recorded
 *                 entries so replay() costs O(K) instead of O(n).
 *                 Snapshots are dropped alongside the entries they
 *                 cover when historyLimit trims.
 *   forkLimit     Cap the number of preserved fork tails (entries
 *                 dropped when you mutate while scrubbed back).
 *                 Defaults to 50. Set Infinity to disable trimming;
 *                 set 0 to discard forks immediately.
 */
export const createSpektrum = (opts = {}) => {

  const { historyLimit, snapshotEvery } = opts;
  const forkLimit = opts.forkLimit ?? 50;
  const appState = {};
  const appStateDelta = {};
  const history = [];
  const snapshots = []; // [{ index, state }] — index = history.length when captured
  const forks = [];     // tails dropped by mutate-while-scrubbed-back
  const systems = [];
  const fns = {};
  const refs = {}; // DOM handles registered via data-ref="name"
  let cursor = 0;
  let replaying = false;
  let errorHandler = null;
  let recordHandler = null;
  let forkHandler = null;
  let boundRoots = new WeakSet(); // tracks bindDOM roots for idempotency
  // All cleanup fns registered by bindDOM (DOM listeners, system unsubs).
  // reset() drains this so listeners don't leak across reset+rebind.
  const allCleanups = new Set();

  // --- Engine helpers (state-bound) ---

  /** Fire a nullable hook with namespaced error logging. Centralises
   *  the `if (h) try { h(...) } catch { console.error('[spektrum]
   *  ${name} threw', err) }` pattern shared by every hook. */
  const safeFire = (fn, name, ...args) => {
    if (!fn) return;
    try { fn(...args); }
    catch (err) { console.error(`[spektrum] ${name} threw`, err); }
  };

  /** Snapshot of `appState` overlaid with the pending `appStateDelta`
   *  — the values systems will see after the *next* tick drains.
   *  Used by `bindReactive`'s initial render and by snapshotEvery
   *  capture so both see post-tick values. */
  const stateSnapshot = () => {
    const s = {};
    deepMerge(s, appState);
    deepMerge(s, appStateDelta);
    return s;
  };

  /** Ensure both delta and state have parents materialised for `path`. */
  const checkPath = (path) => {
    if (!isPath(appStateDelta, path)) createNestedObjects(appStateDelta, path);
    if (!isPath(appState, path)) createNestedObjects(appState, path);
  };

  /** Dispatch a recorded entry into the delta. Checkpoints are
   *  pure markers — no state effect, no fan-out — so replay walks
   *  past them unchanged. */
  const applyEntry = (e) => {
    if (e.op === 'checkpoint') return;
    checkPath(e.path);
    if (e.op === 'set') {
      setPathValue(appStateDelta, e.path, e.value);
    } else {
      const dC = getPathObj(appStateDelta, e.path);
      const sC = getPathObj(appState, e.path);
      const base = typeof dC === 'number' ? dC : (typeof sC === 'number' ? sC : 0);
      setPathValue(appStateDelta, e.path, base + e.value);
    }
  };

  /** Apply an entry, push to history, advance cursor. Truncates the
   *  future first if scrubbed back, preserving the dropped tail on
   *  `forks` so apps can warn or restore. */
  const record = (entry) => {
    if (cursor < history.length) {
      // Capture the about-to-be-discarded tail before mutating
      // history. Each fork is a plain HistoryEntry[] (no new types),
      // tagged with the cursor it forked from and a wall-clock ts so
      // a UI can show "X future edits discarded N seconds ago".
      const dropped = history.slice(cursor);
      history.length = cursor;
      // Snapshots ahead of cursor are now invalid (their state was
      // post-truncated entries that no longer exist).
      while (snapshots.length && snapshots[snapshots.length - 1].index > cursor) {
        snapshots.pop();
      }
      if (dropped.length && forkLimit !== 0) {
        const fork = { entries: dropped, forkedAt: cursor, ts: Date.now() };
        forks.push(fork);
        if (forks.length > forkLimit) forks.splice(0, forks.length - forkLimit);
        safeFire(forkHandler, 'onFork', fork);
      }
    }
    applyEntry(entry);
    history.push(entry);
    cursor = history.length;
    if (snapshotEvery && history.length % snapshotEvery === 0) {
      // Snapshot AFTER tick would be cleaner but record() is pre-tick;
      // capture state ⊕ delta so the snapshot reflects what replay()
      // will land on at this index.
      snapshots.push({ index: history.length, state: stateSnapshot() });
    }
    if (historyLimit && history.length > historyLimit) {
      const drop = history.length - historyLimit;
      history.splice(0, drop);
      cursor = Math.max(0, cursor - drop);
      while (snapshots.length && snapshots[0].index <= drop) snapshots.shift();
      for (const s of snapshots) s.index -= drop;
    }
    // After-record hook for cross-cutting concerns (persistence,
    // telemetry, devtools). Fires synchronously, after trim, with the
    // full entry. Does NOT fire during replay() — replay re-applies
    // entries without re-recording them.
    safeFire(recordHandler, 'onRecord', entry);
  };

  /** Setters warn when replacing an existing non-null handler — prior
   *  versions overwrote silently, which let `autoSave` steal `onRecord`
   *  from the host app. Pass `null` first to clear without warning. */
  const onError = (fn) => {
    if (fn != null && errorHandler) warn('onError overwritten');
    errorHandler = fn;
  };
  const onRecord = (fn) => {
    if (fn != null && recordHandler) warn('onRecord overwritten');
    recordHandler = fn;
  };
  const onFork = (fn) => {
    if (fn != null && forkHandler) warn('onFork overwritten');
    forkHandler = fn;
  };

  /** Run one system, routing exceptions through the error handler. */
  const runSystem = (sys) => {
    try { sys.fn(appState, appStateDelta); }
    catch (err) {
      if (errorHandler) safeFire(errorHandler, 'onError', err, sys.fn);
      else console.error('[spektrum] system threw', err);
    }
  };

  // --- Public mutators ---

  /** Record an additive numeric change. Multiple in one tick accumulate. */
  const trigger = (id, path, value) => {
    record({ id, path, value, op: 'add' });
  };

  /** Record an absolute set. `id` defaults to `set:<path>` when omitted. */
  const setValue = (path, value, id) => {
    record({ id: id || `set:${path}`, path, value, op: 'set' });
  };

  /** Record a tagged checkpoint into history. Pure marker — replay
   *  walks past it without touching state. Use to mark "logically
   *  atomic" boundaries (a search completes, a form submits, a
   *  multi-step wizard finishes a step) so the app can replay to
   *  the *end* of that span without inventing a sentinel pattern.
   *
   *  `name` becomes the entry's `id`; `metadata` becomes its `value`.
   *  Fires `onRecord` (so `autoSave` catches it). The companion
   *  `checkpoints` getter returns each checkpoint entry augmented
   *  with its `index` in history, so replay-to-checkpoint is one line:
   *    spektrum.replay(spektrum.checkpoints.find(c => c.id === name).index + 1)
   *  (the +1 lands at the position *after* the checkpoint). */
  const checkpoint = (name, metadata) => {
    record({ id: name, path: '', value: metadata, op: 'checkpoint' });
  };

  /** Filtered view: every checkpoint entry plus its history index.
   *  Allocates on read — fine at typical checkpoint counts (tens to
   *  hundreds). For hot paths, walk `history` directly. */
  const checkpointsOf = () => {
    const out = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].op === 'checkpoint') out.push({ ...history[i], index: i });
    }
    return out;
  };

  // --- Subscriptions ---

  /** Subscribe `fn` to one or more paths. Returns an unsubscribe.
   *  topKeys is precomputed so tick() can pre-filter systems whose
   *  subscriptions don't intersect the delta's top-level keys. */
  const addSystem = (paths, fn) => {
    const entry = { paths, fn, topKeys: paths.map(p => p.split('.')[0]) };
    systems.push(entry);
    return () => {
      const i = systems.indexOf(entry);
      if (i !== -1) systems.splice(i, 1);
    };
  };

  /** Detach the first system registered with `fn`. Returns true if removed. */
  const removeSystem = (fn) => {
    const i = systems.findIndex(s => s.fn === fn);
    if (i === -1) return false;
    systems.splice(i, 1);
    return true;
  };

  /** Register a named handler callable from `data-fn` attributes. */
  const defineFn = (name, fn) => {
    if (fns[name]) warn('defineFn ' + name + ' overwritten');
    fns[name] = fn;
  };

  // --- Tick / lifecycle ---

  /**
   * Drain the delta to quiescence. Each pass: snapshot matching
   * systems, merge the delta into state, clear the delta, run the
   * systems. Writes during a system's run are picked up by the next
   * pass — that's how fan-out propagates within a single tick.
   * Capped at 1024 iterations to catch feedback loops.
   *
   * The `delta` arg systems receive is empty (cleared before they
   * run); use the subscription path to know what triggered you, or
   * read state directly.
   */
  const tick = () => {
    let iterations = 0;
    while (Object.keys(appStateDelta).length > 0) {
      if (iterations++ > 1024) {
        const err = new Error('tick: max iterations exceeded');
        err.code = 'E_TICK_OVERFLOW';
        if (errorHandler) safeFire(errorHandler, 'onError', err, null);
        else warn('tick: max iterations exceeded');
        clearObject(appStateDelta);
        return;
      }
      const deltaKeys = new Set(Object.keys(appStateDelta));
      const toRun = systems.filter(s =>
        s.topKeys.some(k => deltaKeys.has(k))
        && s.paths.some(p => isPath(appStateDelta, p))
      );
      deepMerge(appState, appStateDelta);
      clearObject(appStateDelta);
      for (const sys of toRun) runSystem(sys);
    }
  };

  /** rAF-driven tick pump. */
  const run = () => {
    tick();
    requestAnimationFrame(run);
  };

  /** Wipe runtime state, refs, history, snapshots, forks, and the
   *  bindDOM idempotency tracker. **Preserves** registered systems,
   *  defineFn entries, and hook registrations (onError, onRecord,
   *  onFork) — those are configuration, not state. Use this from
   *  library code (e.g. spektrum/persist) that wants to load a fresh
   *  history without nuking the host app's subscriptions.
   *
   *  Cleanups (DOM listeners, system unsubs registered by bindDOM)
   *  are still drained — they're tied to the DOM that's now gone. */
  const resetState = () => {
    // Tear down DOM listeners and other registered cleanups first, so a
    // subsequent bindDOM(sameRoot) doesn't stack listeners on top of
    // the prior bind. Cleanups are idempotent (removeEventListener is
    // a no-op for an already-removed handler), so even if a caller has
    // already invoked destroy() the second pass is harmless.
    for (const c of allCleanups) c();
    allCleanups.clear();
    clearObject(appState);
    clearObject(appStateDelta);
    clearObject(refs);
    history.length = 0;
    snapshots.length = 0;
    forks.length = 0;
    boundRoots = new WeakSet();
    cursor = 0;
    replaying = false;
  };

  /** Same as `resetState()`, but also clears app-level systems
   *  registered via `addSystem`. Built-in fns survive. Hook
   *  registrations (onError, onRecord, onFork) survive — clear them
   *  explicitly with onError(null) / onRecord(null) / onFork(null).
   *
   *  Warns if active systems are present at call time — silently
   *  detaching subscriptions has bitten users who assumed reset()
   *  was state-only. Call `resetState()` instead when you only want
   *  to wipe state. */
  const reset = () => {
    if (systems.length) warn(`reset() dropped ${systems.length} system(s); see resetState`);
    resetState();
    systems.length = 0;
  };

  /**
   * Reset state and re-apply the first `n` recorded entries. O(n).
   * History is preserved — scrub forward and back at will. A new
   * trigger while scrubbed truncates the future.
   *
   * For step-back undo, drive from `cursor` (the live playback
   * position), NOT `history.length`. history doesn't shrink on
   * replay, so `replay(history.length - 1)` lands at the same spot
   * every time. Correct pattern:
   *
   *     defineFn('undo', () => replay(Math.max(seedCount, cursor - 1)));
   */
  const replay = (n) => {
    n = Math.max(0, Math.min(n, history.length));
    replaying = true;
    cursor = 0;
    clearObject(appState);
    clearObject(appStateDelta);

    // Skip ahead to the latest snapshot ≤ n, if any. Snapshots are
    // captured every `snapshotEvery` entries, so this turns O(n)
    // replay into O(n mod K) for long histories.
    let startIdx = 0;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].index <= n) {
        deepMerge(appState, snapshots[i].state);
        startIdx = snapshots[i].index;
        cursor = startIdx;
        break;
      }
    }

    for (let i = startIdx; i < n; i++) {
      applyEntry(history[i]);
      cursor = i + 1;
      tick();
    }

    // Replay-completion refresh: re-fire every system once against
    // the final state. Without this, a path that *was* in state
    // before the scrub but is *absent* afterward (because no replayed
    // entry touches it) leaves its bound systems stuck rendering
    // stale data — most visibly, scrubbing back past a `data-each`
    // populate leaves the rendered rows in the DOM, with their
    // `data-model` listeners still wired. Force-firing here puts
    // every binding in sync with the new state. The `replaying` flag
    // stays true so user systems can opt out of replay-time side
    // effects (e.g. analytics, network calls).
    for (const sys of systems) runSystem(sys);

    replaying = false;
  };

  // === Binding helpers ===
  // Each returns an unsubscribe (or undefined). bindDOM collects them
  // and returns a destroy function for the whole tree.

  /** Register a system + fire one initial render against a snapshot of
   *  appState ⊕ appStateDelta, so bindings see post-first-tick values
   *  immediately (no flicker between bind time and the first tick). */
  const bindReactive = (paths, render) => {
    const unsub = addSystem(paths, render);
    render(stateSnapshot(), appStateDelta);
    return unsub;
  };

  /** {{expression}} in a text node. Each placeholder is JS evaluated
   *  against state; bare paths are the simplest case. Re-runs when any
   *  referenced path appears in the delta. */
  const bindText = (node) => {
    const template = node.textContent;
    if (!template.includes('{{')) return;
    const paths = new Set();
    for (const m of template.matchAll(MUSTACHE)) {
      for (const p of extractPaths(m[1].trim())) paths.add(p);
    }
    return bindReactive([...paths], (state) => {
      node.textContent = template.replace(MUSTACHE, (_, e) => {
        const v = evalExpr(e.trim())(state);
        return v == null ? '' : String(v);
      });
    });
  };

  /** :attr="expression". Property write (not setAttribute), so `:value`
   *  updates form state and `:disabled` toggles the boolean prop.
   *  `:class` / `:className` route through applyClass() — accepts
   *  string, array, or `{name: bool}` object. */
  const bindAttrs = (el) => {
    const unsubs = [];
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith(':')) continue;
      const prop = attr.name.slice(1);
      const expr = attr.value;
      if (!expr) continue;
      const isClass = prop === 'class' || prop === 'className';
      const isUrl = URL_PROPS.test(prop);
      unsubs.push(bindReactive(extractPaths(expr), (state) => {
        let v = evalExpr(expr)(state);
        if (isClass) { applyClass(el, v); return; }
        if (isUrl && typeof v === 'string' && JS_SCHEME.test(v)) v = '#';
        el[prop] = v;
      }));
    }
    return unsubs.length ? () => callAll(unsubs) : undefined;
  };

  /** data-if="expression". Truthy → shown; falsy → display: none.
   *  Children stay bound (Vue v-show semantics, not v-if). */
  const bindIf = (el) => {
    const expr = el.dataset.if;
    if (!expr) return;
    return bindReactive(extractPaths(expr), (state) => {
      el.style.display = evalExpr(expr)(state) ? '' : 'none';
    });
  };

  /** data-model="path" — two-way input binding. Detects checkboxes
   *  (uses `change` + el.checked); everything else uses `input` +
   *  el.value. Writes go through setValue → history.
   *
   *  `.lazy` suffix (`data-model="path.lazy"`) commits on `change`
   *  instead of `input` — useful for search boxes / time-travel apps
   *  where per-keystroke writes flood history and fork it on every
   *  edit. The suffix is reserved; if your state genuinely has a
   *  `.lazy` leaf, route through `data-action="input"` + `setValue`
   *  directly. */
  const bindModel = (el) => {
    const raw = el.dataset.model;
    if (!raw) return;
    const lazy = raw.endsWith('.lazy');
    const path = lazy ? raw.slice(0, -5) : raw;
    const isCheckbox = el.type === 'checkbox';
    const eventName = (lazy || isCheckbox) ? 'change' : 'input';
    const writeEl = (v) => {
      if (isCheckbox) el.checked = !!v;
      else el.value = v == null ? '' : v;
    };
    const readEl = () => isCheckbox ? el.checked : parseValue(el.value);

    const unsubs = [];
    unsubs.push(bindReactive([path], (state) => writeEl(getPathObj(state, path))));
    const listener = () => setValue(path, readEl(), `model:${path}`);
    el.addEventListener(eventName, listener);
    unsubs.push(() => el.removeEventListener(eventName, listener));
    return () => callAll(unsubs);
  };

  /** data-ref="name" exposes the element on instance.refs. Framework-
   *  level handle — not domain state, doesn't replay. */
  const bindRef = (el) => {
    const name = el.dataset.ref;
    if (!name) return;
    refs[name] = el;
    return () => { delete refs[name]; };
  };

  /** Derived state. Re-computes when any `deps` path changes; writes
   *  result into delta.path so subscribers fire next pass.
   *  Equivalent to addSystem(deps, (s, d) => setPathValue(d, path, fn(s))). */
  const computed = (path, deps, fn) => {
    return addSystem(deps, (state, delta) => {
      setPathValue(delta, path, fn(state));
    });
  };

  /** Replace whole-word occurrences of `varName` with `prefix` in every
   *  text node and attribute value under `root`. Used by bindEach to
   *  convert per-item template paths (`user.name` → `users.3.name`). */
  const rewriteScope = (root, varName, prefix) => {
    const re = new RegExp(`\\b${escapeRegex(varName)}\\b`, 'g');
    walkTextNodes(root, (n) => {
      if (n.textContent.includes(varName)) {
        n.textContent = n.textContent.replace(re, prefix);
      }
    });
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const attr of Array.from(el.attributes)) {
        if (attr.value.includes(varName)) {
          attr.value = attr.value.replace(re, prefix);
        }
      }
    }
  };

  /**
   * data-each="arrayPath" data-as="varName" [data-key="expr"]
   *                                         [data-stable-key].
   *
   * First child is captured as a template and detached. On change:
   *
   *   - Without data-key: full rebuild (every clone is destroyed and
   *     re-bound). Backward-compatible, fine for ~100 read-only items.
   *
   *   - With data-key: keyed reconciliation. The key expression is
   *     evaluated per item with `varName` in scope (e.g.
   *     data-key="item.id"). Items whose key + index are unchanged
   *     are left in place — their bindings, listeners, focus, and
   *     selection survive. Items at a new index re-bind by default
   *     (paths inside the clone were baked at clone time and need
   *     re-baking for the new index). Removed keys are cleaned up.
   *
   *   - With data-key + data-stable-key (presence-flag): skip path
   *     rewriting on the cloned subtree, and reuse the *same* clone
   *     across reorder via insertBefore. Author opts in by promising
   *     the row's bindings don't reference `varName.*` paths — e.g.
   *     they read outer-scope state, or render pure presentation.
   *     Bind-time scan warns if the template *does* reference the
   *     loop variable (the foot-gun case). When the promise holds,
   *     reorder is genuinely free of UX cost (focus, scroll, input
   *     value, selection survive moves).
   *
   * Each clone gets `contain: layout style` for perf isolation.
   */
  const bindEach = (el) => {
    const arrayPath = el.dataset.each;
    if (!arrayPath) return;
    const varName = el.dataset.as || 'item';
    const keyExpr = el.dataset.key;
    const stableKey = el.hasAttribute('data-stable-key');
    const templateChild = el.firstElementChild;
    if (!templateChild) return;
    const template = templateChild.cloneNode(true);
    templateChild.remove();

    // Bind-time foot-gun warn: data-stable-key is unsafe when the
    // template references the loop variable, because we won't rewrite
    // those paths to the new index. outerHTML covers text content +
    // attribute values in one string — sufficient since varName is
    // an identifier (it won't appear in tag/attribute *names*).
    if (stableKey && new RegExp(`\\b${escapeRegex(varName)}\\b`).test(template.outerHTML)) {
      warn(`data-stable-key but template references "${varName}"`);
    }

    // Keyed cache: key -> { clone, cleanup, index }. Unkeyed mode keeps
    // a flat cleanups[] and rebuilds on every change.
    const cache = new Map();
    let cleanups = [];

    const buildClone = (i) => {
      const clone = template.cloneNode(true);
      if (clone.style && !clone.style.contain) clone.style.contain = 'layout style';
      if (!stableKey) rewriteScope(clone, varName, `${arrayPath}.${i}`);
      return { clone, cleanup: bindDOM(clone) };
    };

    const wipeAll = () => {
      for (const e of cache.values()) e.cleanup();
      cache.clear();
      callAll(cleanups);
      cleanups = [];
      el.replaceChildren();
    };

    // RFC §1 Option C: for the no-key path, track prior items so
    // push/pop appends/removes only the tail. Identity match (===)
    // over the shared prefix; interior change still rebuilds. Shared
    // prefix is the 90% case (chat logs, append-only feeds).
    let prev = [];
    const appendFrom = (from, to) => {
      for (let i = from; i < to; i++) {
        const c = buildClone(i);
        cleanups.push(c.cleanup);
        el.appendChild(c.clone);
      }
    };

    return bindReactive([arrayPath], (state) => {
      const items = getPathObj(state, arrayPath);
      if (!Array.isArray(items)) { wipeAll(); prev = []; return; }

      if (!keyExpr) {
        const oldN = prev.length, newN = items.length;
        let pre = 0;
        while (pre < oldN && pre < newN && prev[pre] === items[pre]) pre++;
        if (pre === oldN && newN > oldN) appendFrom(oldN, newN);
        else if (pre === newN && newN < oldN) {
          while (cleanups.length > newN) {
            cleanups.pop()();
            el.lastElementChild && el.lastElementChild.remove();
          }
        } else {
          wipeAll();
          appendFrom(0, newN);
        }
        prev = items.slice();
        return;
      }

      // Keyed path. Evaluate the key expression with the item bound
      // under `varName` so authors can write data-key="item.id".
      const keyFn = evalExpr(keyExpr);
      const newKeys = items.map(item => keyFn({ [varName]: item }));
      const seen = new Set();

      for (let i = 0; i < items.length; i++) {
        const key = newKeys[i];
        seen.add(key);
        let entry = cache.get(key);
        // Default keyed mode bakes paths at clone time, so a moved
        // index needs a fresh clone. data-stable-key promises the
        // bindings don't depend on the index — the same clone is
        // reused. Unmoved items always pay zero.
        if (entry && !stableKey && entry.index !== i) {
          entry.cleanup();
          entry.clone.remove();
          entry = null;
        }
        if (!entry) {
          entry = buildClone(i);
          cache.set(key, entry);
        }
        entry.index = i;
        if (el.children[i] !== entry.clone) {
          el.insertBefore(entry.clone, el.children[i] || null);
        }
      }

      for (const [key, entry] of cache) {
        if (!seen.has(key)) {
          entry.cleanup();
          entry.clone.remove();
          cache.delete(key);
        }
      }
    });
  };

  // --- bindDOM: top-level scan ---

  /**
   * Scan `root` for declarative bindings and wire them up. Returns a
   * destroy() that undoes everything. Idempotent at the root level —
   * calling bindDOM(sameRoot) twice is a no-op until destroy() runs.
   *
   * Pass order:
   *   1. [data-each]   — must be first, to detach per-item templates
   *                      before other scans walk into them
   *   2. {{expr}}      text nodes
   *   3. :attr="expr"
   *   4. [data-if]
   *   5. [data-model]
   *   6. [data-ref]
   *   7. [data-action] (cycle systems + DOM event listeners)
   */
  const bindDOM = (root) => {
    root = root || document;
    if (boundRoots.has(root)) return () => {};
    boundRoots.add(root);
    const unsubs = [];
    // Every cleanup goes into both the local list (for this destroy())
    // and the instance-level allCleanups (for reset()'s drain).
    const collect = (u) => { if (u) { unsubs.push(u); allCleanups.add(u); } };

    // contains() guard: skip data-each elements that were detached by
    // an outer bindEach earlier in this same loop iteration.
    for (const el of root.querySelectorAll('[data-each]')) {
      if (!root.contains(el)) continue;
      collect(bindEach(el));
    }

    walkTextNodes(root, (n) => collect(bindText(n)));

    for (const el of root.querySelectorAll('*')) collect(bindAttrs(el));
    for (const el of root.querySelectorAll('[data-if]')) collect(bindIf(el));
    for (const el of root.querySelectorAll('[data-model]')) collect(bindModel(el));
    for (const el of root.querySelectorAll('[data-ref]')) collect(bindRef(el));

    for (const el of root.querySelectorAll('[data-action]')) {
      const action = el.dataset.action;
      const handler = fns[el.dataset.fn];
      if (!handler) {
        console.warn(`[spektrum] unknown data-fn "${el.dataset.fn}"`, el);
        continue;
      }
      const value = parseValue(el.dataset.value);
      if (action === 'cycle') {
        collect(addSystem([el.dataset.id], (state, delta) => handler(el, state, delta, value)));
      } else {
        // Modifier syntax: data-action="click.prevent.stop.once".
        // First segment is the event name; rest are flags. Mirrors
        // Vue's v-on modifiers — covers the common footguns
        // (preventing form submits, stopping propagation, fire-once)
        // without forcing every author to write a custom data-fn.
        const [eventName, ...modifiers] = action.split('.');
        for (const m of modifiers) {
          if (!KNOWN_MODIFIERS.test(m)) warn('unknown data-action modifier .' + m);
        }
        const mods = new Set(modifiers);
        const listener = (ev) => {
          if (mods.has('prevent')) ev.preventDefault();
          if (mods.has('stop')) ev.stopPropagation();
          handler(el, appState, appStateDelta, value, ev);
          if (mods.has('once')) el.removeEventListener(eventName, listener);
        };
        el.addEventListener(eventName, listener);
        collect(() => el.removeEventListener(eventName, listener));
      }
    }

    return () => {
      boundRoots.delete(root);
      callAll(unsubs);
      // Drop fired cleanups from the instance set so reset() doesn't
      // call them a second time.
      for (const u of unsubs) allCleanups.delete(u);
    };
  };

  /** Serialize a portable snapshot of the instance for SSR injection,
   *  hydration, debug captures, or off-engine inspection. By default
   *  includes `state`, `history`, and `cursor` so a fresh instance
   *  can `loadHistory` it back to the same point. Pass
   *  `{ includeHistory: false }` for a state-only snapshot;
   *  `{ includeForks: true }` to also include preserved fork tails
   *  (debug only — forks aren't replay-restored by loadHistory). */
  const serialize = (opts = {}) => {
    const out = { state: appState };
    if (opts.includeHistory !== false) { out.history = history; out.cursor = cursor; }
    if (opts.includeForks) out.forks = forks;
    return JSON.stringify(out);
  };

  // --- Built-in fns (registered per instance) ---

  defineFn('trigger',  (el, _s, _d, v) => trigger (histId(el), el.dataset.id, fnVal(el, v)));
  defineFn('setValue', (el, _s, _d, v) => setValue(el.dataset.id, fnVal(el, v), histId(el)));

  defineFn('setText', (el, state) => {
    el.textContent = getPathObj(state, el.dataset.id);
  });

  defineFn('setStyle', (el, state) => {
    const v = getPathObj(state, el.dataset.id);
    el.style[el.dataset.prop] = `${v}${el.dataset.suffix || ''}`;
  });

  defineFn('toggle', (el) => {
    const target = document.querySelector(el.dataset.target);
    if (target) target.classList.toggle(el.dataset.class);
  });

  // --- Public API of the instance ---

  return {
    appState, appStateDelta, history, snapshots, forks, refs,
    get cursor() { return cursor; },
    get replaying() { return replaying; },
    get checkpoints() { return checkpointsOf(); },
    trigger, setValue, checkpoint, computed,
    addSystem, removeSystem, defineFn, onError, onRecord, onFork,
    bindDOM, run, tick, replay, reset, resetState, serialize,
  };
};

// === Default singleton ===
// Most apps want one engine per page; this is it. Named exports below
// pull off the same instance so existing import-style code keeps working.

const _default = createSpektrum();
export default _default;
export const {
  appState, appStateDelta, history, snapshots, forks, refs,
  trigger, setValue, checkpoint, computed,
  addSystem, removeSystem, defineFn, onError, onRecord, onFork,
  bindDOM, run, tick, replay, reset, resetState, serialize,
} = _default;

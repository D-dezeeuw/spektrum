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
    console.warn(`[spektrum] invalid expression: "${expr}"`, err);
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
const RESERVED = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'this',
  'Math', 'JSON', 'Date', 'Number', 'String', 'Array', 'Object',
  'Boolean', 'RegExp', 'Error', 'Map', 'Set', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
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

  /** Dispatch a recorded entry into the delta. */
  const applyEntry = (e) => {
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

  /** Install an error handler. Receives (err, systemFn) when a
   *  subscribed system throws inside tick(). One handler per instance;
   *  later calls replace earlier. Pass `null` to clear. */
  const onError = (fn) => { errorHandler = fn; };

  /** Install a post-record hook. Called as `(entry)` after every
   *  recorded mutation has been applied, snapshotted, and trimmed.
   *  One handler per instance. Pass `null` to clear. */
  const onRecord = (fn) => { recordHandler = fn; };

  /** Install a fork hook. Fires when a record() truncates entries
   *  (mutate-while-scrubbed-back). Receives the just-saved fork
   *  record `{ entries, forkedAt, ts }`. Descriptive — the truncate
   *  has already happened by the time this fires; throwing here
   *  cannot roll it back. One handler per instance. */
  const onFork = (fn) => { forkHandler = fn; };

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
  const defineFn = (name, fn) => { fns[name] = fn; };

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
        console.warn('[spektrum] tick: max iterations exceeded, possible feedback cycle');
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

  /** Wipe runtime state. Built-in fns survive. Also resets refs,
   *  snapshots, forks, and the bindDOM idempotency tracker. Hook
   *  registrations (onError, onRecord, onFork) survive — they're
   *  configuration, not state; clear them explicitly with
   *  onError(null) / onRecord(null) / onFork(null) if desired. */
  const reset = () => {
    clearObject(appState);
    clearObject(appStateDelta);
    clearObject(refs);
    history.length = 0;
    snapshots.length = 0;
    forks.length = 0;
    systems.length = 0;
    boundRoots = new WeakSet();
    cursor = 0;
    replaying = false;
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
   *  el.value. Writes go through setValue → history. */
  const bindModel = (el) => {
    const path = el.dataset.model;
    if (!path) return;
    const isCheckbox = el.type === 'checkbox';
    const eventName = isCheckbox ? 'change' : 'input';
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
   * data-each="arrayPath" data-as="varName" [data-key="expr"].
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
   *     selection survive. Items at a new index re-bind (paths must
   *     be rewritten to the new absolute index). Removed keys are
   *     cleaned up.
   *
   * Each clone gets `contain: layout style` for perf isolation.
   */
  const bindEach = (el) => {
    const arrayPath = el.dataset.each;
    if (!arrayPath) return;
    const varName = el.dataset.as || 'item';
    const keyExpr = el.dataset.key;
    const templateChild = el.firstElementChild;
    if (!templateChild) return;
    const template = templateChild.cloneNode(true);
    templateChild.remove();

    // Keyed cache: key -> { clone, cleanup, index }. Unkeyed mode keeps
    // a flat cleanups[] and rebuilds on every change.
    const cache = new Map();
    let cleanups = [];

    const buildClone = (i) => {
      const clone = template.cloneNode(true);
      if (clone.style && !clone.style.contain) clone.style.contain = 'layout style';
      rewriteScope(clone, varName, `${arrayPath}.${i}`);
      return { clone, cleanup: bindDOM(clone) };
    };

    const wipeAll = () => {
      for (const e of cache.values()) e.cleanup();
      cache.clear();
      callAll(cleanups);
      cleanups = [];
      el.replaceChildren();
    };

    return bindReactive([arrayPath], (state) => {
      const items = getPathObj(state, arrayPath);
      if (!Array.isArray(items)) { wipeAll(); return; }

      if (!keyExpr) {
        wipeAll();
        items.forEach((_, i) => {
          const { clone, cleanup } = buildClone(i);
          cleanups.push(cleanup);
          el.appendChild(clone);
        });
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
        if (!entry || entry.index !== i) {
          // Index changed (or first time): re-bind. Paths inside the
          // template were baked at clone time, so a new index needs a
          // fresh clone. This is the cost of static path rewriting —
          // the win is that *unmoved* items pay zero.
          if (entry) {
            entry.cleanup();
            entry.clone.remove(); // drop the stale DOM node before its cache slot is overwritten
          }
          entry = buildClone(i);
          entry.index = i;
          cache.set(key, entry);
        }
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
    const collect = (u) => { if (u) unsubs.push(u); };

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
        const mods = new Set(modifiers);
        const listener = (ev) => {
          if (mods.has('prevent')) ev.preventDefault();
          if (mods.has('stop')) ev.stopPropagation();
          handler(el, appState, appStateDelta, value);
          if (mods.has('once')) el.removeEventListener(eventName, listener);
        };
        el.addEventListener(eventName, listener);
        unsubs.push(() => el.removeEventListener(eventName, listener));
      }
    }

    return () => {
      boundRoots.delete(root);
      callAll(unsubs);
    };
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
    trigger, setValue, computed,
    addSystem, removeSystem, defineFn, onError, onRecord, onFork,
    bindDOM, run, tick, replay, reset,
  };
};

// === Default singleton ===
// Most apps want one engine per page; this is it. Named exports below
// pull off the same instance so existing import-style code keeps working.

const _default = createSpektrum();
export default _default;
export const {
  appState, appStateDelta, history, snapshots, forks, refs,
  trigger, setValue, computed,
  addSystem, removeSystem, defineFn, onError, onRecord, onFork,
  bindDOM, run, tick, replay, reset,
} = _default;

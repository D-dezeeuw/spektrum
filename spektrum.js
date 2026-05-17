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
 * `javascript:`-scheme guard for URL-bearing property writes. When a
 * bound `:href` / `:src` / `:action` / `:formaction` / `:background` /
 * `:cite` / `:poster` / `:data` evaluates to a string starting with
 * `javascript:`, bindAttrs rewrites it to `#` so a stale path or
 * attacker-influenced value can't smuggle script execution through
 * `<a :href="…">` and friends. The URL-prop set is inlined at the
 * single call site (bindAttrs).
 *
 * `srcdoc` is deliberately NOT in the set — its value is parsed as
 * HTML, not a URL, so a scheme check would give false confidence.
 * `xlink:href` is also out of scope: we write via property, not
 * `setAttribute`, and SVG navigation exposes no `xlink:href` JS
 * property — the binding is effectively dead-letter.
 */
const JS_SCHEME = /^\s*javascript:/i;

/** Key gates for data-action: values prefixed with `:` are ev.key
 *  matches; everything else is a property on ev (truthy check). */
const KEY_GATE = { enter: ':Enter', esc: ':Escape', tab: ':Tab', shift: 'shiftKey', cmd: 'metaKey' };

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

// Recursive in-place merge. Sub-path edits on arrays produce sources
// like `{items: {1: {…}}}`; we merge into the existing array rather
// than replacing it. Whole-array sources hit the else branch and
// overwrite. Returns target so calls can chain.
const deepMerge = (target, source) => {
  for (const k of Object.keys(source)) {
    if (!SAFE_KEY(k)) continue;
    const v = source[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (target[k] == null || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], v);
    } else target[k] = v;
  }
  return target;
};

const clearObject = (obj) => {
  /* Drop every own key on `obj` in place. */
  for (const k of Object.keys(obj)) delete obj[k];
};

// Coerce a data-value string: ""→undefined, bool literals, numeric, else string.
const parseValue = (s) => {
  if (s == null || s === '') return undefined;
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = +s;
  return n === n ? n : s; // n!==n iff NaN
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
// Compile-on-first-use, cached by source string. Templates are author-
// written (same trust model as Vue/Alpine). For strict CSP, register
// every expression via `precompile()` at build time — `new Function`
// is then never reached.

const EVAL_CACHE_LIMIT = 500;
const evalCache = new Map();

// FIFO eviction (Map preserves insertion order) bounds memory for
// long-running pages that mint many distinct expressions.
const cacheSet = (k, v) => {
  if (evalCache.size >= EVAL_CACHE_LIMIT) {
    evalCache.delete(evalCache.keys().next().value);
  }
  evalCache.set(k, v);
};

// Scope object carries per-iteration values (item, index, $path, …)
// passed through the binders by bindEach. Path translation for
// subscription extraction lives on a Symbol-keyed slot so user
// expressions can't see or shadow it through `with`.
const SCOPE_PATHS = Symbol();
// Marker stamped on a data-each host (container element in container
// form, parent element in <template> form). bindDOM's element + text
// walks skip elements whose closest marked ancestor strictly between
// them and the current root has this stamp — that way the outer walk
// doesn't re-enter clones owned by an inner bindEach, while the inner
// bindDOM call on the clone itself still binds its own subtree.
const EACH_HOST = Symbol();

const evalExpr = (expr) => {
  let fn = evalCache.get(expr);
  if (fn) return fn;
  try {
    // Dotted-numeric segments (`users.0.name` from bindEach) → bracket
    // notation so JS can parse. Inner try/catch so paths not yet in
    // state render as undefined instead of throwing.
    const normalized = expr.replace(/([a-zA-Z_$][\w$]*)\.(\d+)/g, '$1[$2]');
    // `with (state) with (scope||{})` — scope is the INNER with so its
    // identifiers shadow state on collision (e.g. data-as="user" inside
    // a loop where state.user also exists — the loop variable wins).
    // `||{}` covers binders invoked outside a data-each (no scope).
    const compiled = new Function('state', 'scope', `with (state) with (scope||{}) { return (${normalized}); }`);
    fn = (state, scope) => { try { return compiled(state, scope); } catch { return undefined; } };
  } catch (err) {
    // Strict CSP without a precompiled entry, or malformed expression.
    warn('invalid expression: "' + expr + '" ' + err);
    fn = () => undefined;
  }
  cacheSet(expr, fn);
  return fn;
};

/** Register a precompiled expression function. Build-time tooling
 *  emits one call per unique expression so the runtime cache hits
 *  before `new Function` runs (CSP-friendly). */
export const precompile = (source, fn) => cacheSet(source, fn);

// Lookbehind excludes identifiers preceded by `.` or `\w` so
// `user.name.toUpperCase` matches as one path, not three.
const IDENT = /(?<![\w$.])([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/g;
// Identifier-heads that are JS globals/literals, not state paths.
// Over-subscribing to a never-firing path is benign (audit F-12), so
// the list is conservative. Regex form is ~30 B tighter than Set.
const RESERVED = /^(true|false|null|undefined|NaN|Infinity|Math|JSON|Date|Number|String|Array|Object|Boolean)$/;

/** Pull subscription paths out of an expression. Reserved-word heads
 *  (Math, JSON, true, ...) are filtered. String literals are stripped
 *  before scanning so identifiers inside quotes (e.g. `kind === 'foo'`)
 *  don't leak into the path set as spurious subscriptions. The strip
 *  regex honours backslash escapes — `"foo \"bar\" baz"` collapses
 *  cleanly without leaking `bar` as a subscription path.
 *
 *  When called inside a data-each iteration, `scope` carries a path
 *  map under `SCOPE_PATHS` mapping aliases (`item`) to state paths
 *  (`users.3`). Identifiers whose head matches an alias are rewritten
 *  to the state path; scope-only heads (numeric `index`, boolean
 *  `$first`, etc.) carry no path and are skipped — bindEach drives
 *  their re-renders explicitly on reorder. */
const extractPaths = (expr, scope) => {
  const paths = new Set();
  const map = scope?.[SCOPE_PATHS];
  const stripped = expr.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
  for (const m of stripped.matchAll(IDENT)) {
    const id = m[1];
    const head = id.split('.')[0];
    if (RESERVED.test(head)) continue;
    if (scope && head in scope) {
      // Aliased to a state path → translate. Scope-only value (no
      // path) → no subscription; bindEach owns the re-render.
      const aliased = map?.[head];
      if (aliased) paths.add(aliased + id.slice(head.length));
      continue;
    }
    paths.add(id);
  }
  return [...paths];
};

/** Set element classes. Accepts a string (overwrites), an array
 *  (filtered + joined, overwrites), or an object (toggle per key). */
const applyClass = (el, v) => {
  if (typeof v === 'string') el.className = v;
  else if (Array.isArray(v)) el.className = v.filter(Boolean).join(' ');
  else if (v && typeof v === 'object')
    for (const k in v) el.classList.toggle(k, !!v[k]);
};

// Hand-written walker — happy-dom's TreeWalker silently returns no
// nodes for SHOW_TEXT filters even when text descendants exist.
// Iterative (explicit stack) so pathological depths can't blow the
// JS engine call stack. Push in reverse so visit() order matches the
// recursive form (left-to-right depth-first).
const walkTextNodes = (root, visit) => {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.nodeType === 3) visit(n);
    else for (let i = n.childNodes.length; i--;) stack.push(n.childNodes[i]);
  }
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
  const intents = {}; // semantic element registry: data-intent="verb.noun" → [el, …]
  let cursor = 0;
  let replaying = false;
  // Hooks are multi-subscriber: each onX(fn) appends and returns an
  // unsubscribe handle; onX(null) clears all. Pre-1.0 behavior was
  // single-handler-replace, which silently collided when (e.g.)
  // autoSave overwrote a user-registered onRecord.
  const errorHandlers  = new Set();
  const recordHandlers = new Set();
  const forkHandlers   = new Set();
  let boundRoots = new WeakSet(); // tracks bindDOM roots for idempotency
  // All cleanup fns registered by bindDOM (DOM listeners, system unsubs).
  // reset() drains this so listeners don't leak across reset+rebind.
  const allCleanups = new Set();

  // --- Engine helpers (state-bound) ---

  /** Fire every subscriber on a hook set, isolating each from the next
   *  with namespaced error logging so one bad listener can't take the
   *  others down. Iterating a Set during mutation is safe per spec —
   *  added handlers fire, removed ones don't. */
  const safeFire = (handlers, name, ...args) => {
    for (const fn of handlers) {
      try { fn(...args); }
      catch (err) { console.error(`[spektrum] ${name} threw`, err); }
    }
  };

  /** Snapshot of `appState` overlaid with the pending `appStateDelta`
   *  — the values systems will see after the *next* tick drains.
   *  Used by `bindReactive`'s initial render and by snapshotEvery
   *  capture so both see post-tick values. */
  const stateSnapshot = () => deepMerge(deepMerge({}, appState), appStateDelta);

  /** Ensure both delta and state have parents materialised for `path`. */
  const checkPath = (path) => {
    if (!isPath(appStateDelta, path)) createNestedObjects(appStateDelta, path);
    if (!isPath(appState, path)) createNestedObjects(appState, path);
  };

  /** Dispatch a recorded entry into the delta. Checkpoints are pure
   *  markers — no state effect, no fan-out — so replay walks past
   *  them unchanged. Add-ops accumulate on top of the most-recent
   *  numeric value (delta first, then state, else 0). */
  const applyEntry = (e) => {
    if (e.op === 'checkpoint') return;
    checkPath(e.path);
    if (e.op === 'set') return setPathValue(appStateDelta, e.path, e.value);
    const cur = getPathObj(appStateDelta, e.path) ?? getPathObj(appState, e.path);
    setPathValue(appStateDelta, e.path, (typeof cur === 'number' ? cur : 0) + e.value);
  };

  /** Apply an entry, push to history, advance cursor. Truncates the
   *  future first if scrubbed back, preserving the dropped tail on
   *  `forks` so apps can warn or restore. */
  const record = (entry) => {
    if (cursor < history.length) {
      // Mutate-while-scrubbed-back: capture the dropped tail on `forks`
      // so apps can warn or restore. Snapshots ahead of cursor are
      // invalid (state was derived from entries we just truncated).
      const dropped = history.slice(cursor);
      history.length = cursor;
      while (snapshots.at(-1)?.index > cursor) snapshots.pop();
      if (dropped.length && forkLimit !== 0) {
        const fork = { entries: dropped, forkedAt: cursor, ts: Date.now() };
        forks.push(fork);
        if (forks.length > forkLimit) forks.splice(0, forks.length - forkLimit);
        safeFire(forkHandlers, 'onFork', fork);
      }
    }
    applyEntry(entry);
    history.push(entry);
    cursor = history.length;
    if (snapshotEvery && history.length % snapshotEvery === 0) {
      // record() is pre-tick; capture state ⊕ delta so the snapshot
      // reflects what replay() will land on at this index.
      snapshots.push({ index: history.length, state: stateSnapshot() });
    }
    if (historyLimit && history.length > historyLimit) {
      // Amortize splice cost: drop chunk = max(1, limit/16) at a time,
      // so length oscillates within a chunk-sized window. Caps ≤16 keep
      // chunk = 1 (trim to exact limit; pre-F-13 behavior).
      const chunk = (historyLimit >>> 4) || 1;
      const drop = history.length - historyLimit + chunk - 1;
      history.splice(0, drop);
      cursor = Math.max(0, cursor - drop);
      while (snapshots[0]?.index <= drop) snapshots.shift();
      for (const s of snapshots) s.index -= drop;
    }
    // Does NOT fire during replay() — replay re-applies without re-recording.
    safeFire(recordHandlers, 'onRecord', entry);
  };

  /** Hook setters. Each call appends a new subscriber and returns an
   *  unsubscribe handle. Pass `null` to clear every subscriber on that
   *  hook (the way `autoSave(stop)` and tests do teardown). */
  const sub = (set) => (fn) => {
    if (fn === null) return set.clear();
    set.add(fn);
    return () => set.delete(fn);
  };
  const onError  = sub(errorHandlers);
  const onRecord = sub(recordHandlers);
  const onFork   = sub(forkHandlers);

  /** Route an exception through the registered onError handlers, or
   *  fall back to a namespaced console.error. Shared by runSystem (one
   *  call) and callFn (two — sync and async-rejection paths) so the
   *  "[spektrum] " prefix and handler-fan-out check live in one place. */
  const routeErr = (err, fn, msg) => {
    if (errorHandlers.size) safeFire(errorHandlers, 'onError', err, fn);
    else console.error('[spektrum] ' + msg, err);
  };

  /** Run one system, routing exceptions through the error handlers. */
  const runSystem = (sys) => {
    try { sys.fn(appState, appStateDelta); }
    catch (err) { routeErr(err, sys.fn, 'system threw'); }
  };

  /** Invoke a data-fn handler, routing sync throws AND async rejections
   *  through onError (or console.error fallback). Without this, async
   *  handler rejections land as unhandled-promise warnings and never
   *  reach the registered error path. */
  const callFn = (name, fn, ...args) => {
    try {
      const r = fn(...args);
      if (r?.then) r.catch(err => routeErr(err, fn, `async data-fn "${name}"`));
    } catch (err) { routeErr(err, fn, `sync data-fn "${name}"`); }
  };

  // --- Public mutators ---

  /** Record an additive numeric change. Multiple in one tick accumulate.
   *  Empty path is rejected — silently writing to appState[''] used to
   *  pollute state and bloat history with values no binding could read. */
  const trigger = (id, path, value) => {
    if (!path) return warn('trigger: empty path');
    record({ id, path, value, op: 'add' });
  };

  /** Record an absolute set. `id` defaults to `set:<path>` when omitted. */
  const setValue = (path, value, id) => {
    if (!path) return warn('setValue: empty path');
    record({ id: id || `set:${path}`, path, value, op: 'set' });
  };

  /** Tagged history marker. No state effect on replay; fires onRecord
   *  so autoSave catches it. See README "Checkpoints" for the replay
   *  recipe. */
  const checkpoint = (name, metadata) => {
    record({ id: name, path: '', value: metadata, op: 'checkpoint' });
  };

  /** Filtered view of `history`: checkpoints plus their index. */
  const checkpointsOf = () =>
    history.flatMap((e, index) => e.op === 'checkpoint' ? [{ ...e, index }] : []);

  // --- Subscriptions ---

  /** Subscribe `fn` to one or more paths. Returns an unsubscribe.
   *  topKeys is precomputed so tick() can pre-filter systems whose
   *  subscriptions don't intersect the delta's top-level keys. The
   *  `active` flag lets tick() skip systems that were unsubscribed
   *  mid-tick — bindEach's reorder path tears down and re-binds a
   *  clone's systems while a `toRun` snapshot is already in flight,
   *  and without this guard the stale systems would write old paths
   *  back over the freshly-bound element. */
  const addSystem = (paths, fn) => {
    const entry = { paths, fn, topKeys: paths.map(p => p.split('.')[0]), active: true };
    systems.push(entry);
    return () => {
      entry.active = false;
      const i = systems.indexOf(entry);
      ~i && systems.splice(i, 1);
    };
  };

  /** Alias for `addSystem` (conventional name; identical reference). */
  const watch = addSystem;

  /** Detach the first system registered with `fn`. Returns true if removed. */
  const removeSystem = (fn) => {
    const i = systems.findIndex(s => s.fn === fn);
    if (i === -1) return false;
    systems.splice(i, 1);
    return true;
  };

  /** Register a named handler callable from `data-fn` attributes.
   *  Silently replaces any prior registration with the same name.
   *  Optional `meta` ({ description, input, output, examples }) is
   *  attached to the function for `describe()` / MCP introspection. */
  const defineFn = (name, fn, meta) => { if (meta) fn.meta = meta; fns[name] = fn; };

  /** Async resource primitive. Sets `${path}.loading` / `${path}.error`
   *  / `${path}.data` as the promise progresses. Each phase records
   *  through setValue so replay re-applies values without re-issuing
   *  the fetch. Returns the run function for refetching; also indexed
   *  by `path` so `refresh(path)` works without holding the handle. */
  const asyncRunners = {};
  const addAsync = (path, fn) => {
    const id = `addAsync:${path}`;
    const set = (k, v) => setValue(`${path}.${k}`, v, id);
    const run = async () => {
      set('loading', true);
      try { set('data', await fn()); set('error', null); }
      catch (err) { set('error', err?.message || String(err)); }
      finally { set('loading', false); }
    };
    asyncRunners[path] = run;
    run();
    return run;
  };

  /** Re-run the loader previously registered via `addAsync(path, …)`.
   *  Returns the run Promise, or undefined when `path` was never
   *  registered. Lets callers refetch without retaining the handle. */
  const refresh = (path) => asyncRunners[path]?.();

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
        if (errorHandlers.size) safeFire(errorHandlers, 'onError', err, null);
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
      for (const sys of toRun) if (sys.active) runSystem(sys);
    }
  };

  /** rAF-driven tick pump. */
  const run = () => {
    tick();
    requestAnimationFrame(run);
  };

  /** Wipe runtime state, refs, history, snapshots, forks, and the
   *  bindDOM idempotency tracker. **Preserves** systems, defineFn
   *  entries, and hooks — those are configuration. Cleanups are
   *  drained first so re-binding the same root doesn't stack listeners. */
  const resetState = () => {
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

  /** Like `resetState()` but also clears systems. Hooks and built-in
   *  fns survive. Warns when active systems are present — silent
   *  detach has bitten users; call `resetState()` for state-only. */
  const reset = () => { resetState(); systems.length = 0; };

  /** Reset state and re-apply the first `n` recorded entries. O(n)
   *  without snapshots, O(n mod K) with `snapshotEvery: K`. For
   *  step-back undo, drive from `cursor` (live position), not
   *  `history.length` — replay doesn't shrink history. */
  const replay = (n) => {
    n = Math.max(0, Math.min(n, history.length));
    replaying = true;
    cursor = 0;
    clearObject(appState);
    clearObject(appStateDelta);

    // Skip ahead to the latest snapshot ≤ n.
    let startIdx = 0;
    const sn = snapshots.findLast(s => s.index <= n);
    if (sn) { deepMerge(appState, sn.state); cursor = startIdx = sn.index; }

    for (let i = startIdx; i < n; i++) {
      applyEntry(history[i]);
      cursor = i + 1;
      tick();
    }

    // Re-fire every system against the final state. Without this,
    // paths that left state during the scrub leave their bindings
    // rendering stale data (e.g. data-each rows lingering in the DOM
    // after replay back past a populate). `replaying` stays true so
    // user systems can opt out of replay-time side effects.
    for (const sys of systems) runSystem(sys);

    replaying = false;
  };

  // === Binding helpers ===
  // Each returns an unsubscribe (or undefined). bindDOM collects them
  // and returns a destroy function for the whole tree.

  /** Translate a state path through the iteration scope. `item.count`
   *  with scope `{ item: 'users.3' }` becomes `users.3.count`. Used by
   *  bindModel (model writes target real state) and the built-in
   *  trigger/setValue/setText/setStyle handlers so authors can write
   *  `data-id="item.count"` and have it resolve to the row's path. */
  const resolvePath = (path, scope) => {
    const map = scope?.[SCOPE_PATHS];
    if (!map) return path;
    const head = path.split('.')[0];
    const aliased = map[head];
    return aliased ? aliased + path.slice(head.length) : path;
  };

  /** Register a system + fire one initial render against a snapshot of
   *  appState ⊕ appStateDelta, so bindings see post-first-tick values
   *  immediately (no flicker between bind time and the first tick).
   *  `scope` (when present) is passed to render so expressions can
   *  read iteration variables (`item`, `index`, `$path`, …). */
  const bindReactive = (paths, render, scope) => {
    const wrapped = scope
      ? (state, delta) => render(state, delta, scope)
      : render;
    const unsub = addSystem(paths, wrapped);
    wrapped(stateSnapshot(), appStateDelta);
    return unsub;
  };

  /** {{expression}} in a text node. Each placeholder is JS evaluated
   *  against state; bare paths are the simplest case. Re-runs when any
   *  referenced path appears in the delta.
   *
   *  Remembers the original template on the node — first render rewrites
   *  textContent to the result, so without this a re-bind (data-each
   *  reorder) would read the prior result as the new template and bail.
   *  WeakMap keyed by the text node, scoped to this instance. */
  const textTemplates = new WeakMap();
  const bindText = (node, scope) => {
    let template = textTemplates.get(node);
    if (template === undefined) {
      template = node.textContent;
      textTemplates.set(node, template);
    }
    if (!template.includes('{{')) return;
    const paths = new Set();
    for (const m of template.matchAll(MUSTACHE)) {
      for (const p of extractPaths(m[1].trim(), scope)) paths.add(p);
    }
    return bindReactive([...paths], (state, _delta, sc) => {
      node.textContent = template.replace(MUSTACHE, (_, e) => {
        const v = evalExpr(e.trim())(state, sc);
        return v == null ? '' : String(v);
      });
    }, scope);
  };

  /** :attr="expression". Property write (not setAttribute). `:class` /
   *  `:className` route through applyClass(). URL-bearing attributes
   *  rewrite javascript:-scheme strings to '#'. */
  const bindAttrs = (el, scope) => {
    const unsubs = [];
    for (const a of [...el.attributes]) {
      if (a.name[0] !== ':') continue;
      const prop = a.name.slice(1), expr = a.value;
      if (!expr) continue;
      const isClass = prop === 'class' || prop === 'className';
      const isUrl = /^(href|src|action|formaction|background|cite|poster|data)$/.test(prop);
      unsubs.push(bindReactive(extractPaths(expr, scope), (state, _delta, sc) => {
        let v = evalExpr(expr)(state, sc);
        if (isClass) return applyClass(el, v);
        if (isUrl && typeof v === 'string' && JS_SCHEME.test(v)) v = '#';
        el[prop] = v;
      }, scope));
    }
    return unsubs.length && (() => callAll(unsubs));
  };

  /** data-if="expression". Truthy → shown; falsy → display: none.
   *  Children stay bound (Vue v-show semantics, not v-if). */
  const bindIf = (el, scope) => {
    const expr = el.dataset.if;
    if (!expr) return;
    return bindReactive(extractPaths(expr, scope), (state, _delta, sc) => {
      el.style.display = evalExpr(expr)(state, sc) ? '' : 'none';
    }, scope);
  };

  /** data-model="path" — two-way input binding. Detects checkboxes
   *  (uses `change` + el.checked); everything else uses `input` +
   *  el.value. Writes go through setValue → history.
   *
   *  Trailing dot-separated modifiers (Vue-style):
   *    .lazy    commit on `change` instead of `input`
   *    .number  coerce element value via parseFloat (NaN → string)
   *    .trim    trim whitespace before write
   *  Chainable: `data-model="query.trim.lazy"`. The modifier names are
   *  reserved suffixes — if your state has a leaf literally named
   *  `lazy`/`number`/`trim`, route through `data-action="input"` +
   *  `setValue` directly.
   *
   *  Inside a data-each, the path is resolved through scope so
   *  `data-model="item.value"` writes to the row's actual state path. */
  const bindModel = (el, scope) => {
    const raw = el.dataset.model;
    if (!raw) return;
    const parts = raw.split('.');
    const mods = new Set();
    while (/^(lazy|number|trim)$/.test(parts.at(-1))) {
      mods.add(parts.pop());
    }
    const path = resolvePath(parts.join('.'), scope);
    if (!path) return;
    const isCheckbox = el.type === 'checkbox';
    const eventName = (mods.has('lazy') || isCheckbox) ? 'change' : 'input';
    const writeEl = (v) => isCheckbox ? el.checked = !!v : el.value = v ?? '';
    const readEl = () => {
      if (isCheckbox) return el.checked;
      const v = mods.has('trim') ? el.value.trim() : el.value;
      if (!mods.has('number')) return parseValue(v);
      const n = parseFloat(v);
      return isNaN(n) ? v : n;
    };

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

  /** data-intent="verb.noun" — semantic locator for agentic tooling.
   *  Multiple elements can share an intent; intents[name] is an array.
   *  Looked up via `findByIntent(name)` and surfaced in `describe()`.
   *  Pure marker — no runtime behavior; siblings (data-action, data-model,
   *  data-fn) decide what the element does. */
  const bindIntent = (el) => {
    const name = el.dataset.intent;
    if (!name) return;
    (intents[name] ||= []).push(el);
    return () => {
      const a = intents[name];
      const i = a?.indexOf(el);
      if (i >= 0) a.splice(i, 1);
      if (!a?.length) delete intents[name];
    };
  };

  /** Derived state. Primes synchronously from current state on
   *  registration (so registering after deps are already populated —
   *  e.g. after loadHistory — lands the initial value on the next
   *  tick), then re-derives whenever any `deps` change. Writes the
   *  result to BOTH appState and the delta: the appState write makes
   *  mid-tick reads see fresh values (a sibling system reading
   *  `state.derived` in the same pass gets the just-computed value);
   *  the delta write keeps fan-out working so dependents in later
   *  passes still fire. The try/catch protects deps that aren't yet
   *  in state; the addSystem path takes over normally once a dep
   *  arrives. */
  const computed = (path, deps, fn) => {
    const derive = (s, d) => {
      const v = fn(s);
      setPathValue(d, path, v);
      setPathValue(appState, path, v);
    };
    try { derive(stateSnapshot(), appStateDelta); } catch {}
    return addSystem(deps, derive);
  };

  /** Construct the per-iteration scope object for a data-each clone.
   *  Carries:
   *   - the loop variable (`varName` → current item value), so
   *     `with(scope)` resolves bare references at eval time.
   *   - `index` / `$index` / `$first` / `$last` / `$path` — read-only
   *     iteration metadata. Re-render is driven by bindEach explicitly
   *     on reorder (these aren't state paths so they don't trigger the
   *     normal subscription system).
   *   - SCOPE_PATHS — symbol-keyed map from alias to state path
   *     (`{item: 'users.3'}`). extractPaths reads this to translate
   *     `item.name` into the subscription path `users.3.name`. The
   *     symbol keeps it invisible to user expressions through `with`.
   *  Outer scope (nested data-each) is merged so inner expressions
   *  can read outer aliases. Inner aliases shadow on collision. */
  const makeScope = (outer, varName, i, items, arrayPath) => {
    const path = arrayPath + '.' + i;
    const scope = outer ? { ...outer } : {};
    scope[varName] = items[i];
    scope.index = i;
    scope.$index = i;
    scope.$first = i === 0;
    scope.$last = i === items.length - 1;
    scope.$path = path;
    scope[SCOPE_PATHS] = { ...(outer?.[SCOPE_PATHS] || {}), [varName]: path };
    return scope;
  };

  /** data-each list rendering. Two authoring forms:
   *
   *    Container form (legacy):
   *      <ul data-each="rows"><li>{{row.name}}</li></ul>
   *      data-each is on the container; its first element child is the
   *      template. Clones replace the template inside the container.
   *
   *    <template> form (HTML5-spec-aligned):
   *      <table><thead>…</thead>
   *        <template data-each="rows"><tr><td>{{row.name}}</td></tr></template>
   *      </table>
   *      data-each is on a <template>; its content's first element
   *      child is the template. Clones go into the <template>'s parent,
   *      anchored before the <template> tag — works inside <table>,
   *      <select>, <thead>, etc. where the HTML parser would otherwise
   *      re-parent a stray container-form child. No pre-bind flicker
   *      (the browser never renders <template> content).
   *
   *  Reconciliation modes (no-key vs keyed) are documented in
   *  docs/bindings.md. Keyed mode now ALWAYS reuses the same DOM clone
   *  across reorder; on index change the clone's bindings are torn
   *  down and re-bound with a fresh scope (path subscriptions update
   *  to point at the new index, focus/scroll/input state survive).
   *  Per-clone `contain: layout style` is set for perf isolation.
   *  `data-stable-key` is accepted as a no-op for back-compat with
   *  pre-scope authoring; reuse-on-reorder is now the default. */
  const bindEach = (el, outerScope) => {
    const ds = el.dataset;
    const arrayPath = resolvePath(ds.each, outerScope);
    if (!arrayPath) return;
    const varName = ds.as || 'item';
    const keyExpr = ds.key;
    // <template> form: clones live in el.parentElement, anchored before
    // el. Container form: clones live inside el. The host/anchor pair
    // lets the rest of the function stay form-agnostic.
    const isTpl = el.tagName === 'TEMPLATE';
    const host = isTpl ? el.parentElement : el;
    if (!host) {
      warn(`data-each="${arrayPath}" <template> needs a parentElement`);
      return;
    }
    const templateChild = (isTpl ? el.content : el).firstElementChild;
    // data-each needs an element template — a bare loop body (text-only,
    // comment-only, whitespace) used to silent-no-op. Surface the misuse.
    if (!templateChild) {
      warn(`data-each="${arrayPath}" needs an element child to clone`);
      return;
    }
    const template = templateChild.cloneNode(true);
    // Container form: detach the inline template so it doesn't render
    // alongside clones. Template form: <template>.content is non-rendered
    // — nothing to detach, and el stays in the parent as a positional
    // anchor for clone insertion.
    if (!isTpl) templateChild.remove();

    // Mark the host so bindDOM's outer walks skip clone descendants
    // (they're bound by the per-clone bindDOM call below, not by the
    // enclosing scan). Inner walks pass scope; their own root is the
    // clone, so the marker on the host outside the clone doesn't
    // false-positive on the clone's own children.
    host[EACH_HOST] = true;

    // `insertAt(clone, ref)` inserts within our region: container form
    // appends/inserts inside host; template form inserts before the
    // <template> anchor (or before `ref` if it's one of our clones).
    const anchor = isTpl ? el : null;
    const insertAt = (clone, ref) => host.insertBefore(clone, ref || anchor);

    // Keyed cache: key -> { clone, cleanup, index }. Both forms also
    // track `live` — the ordered list of clones we own — so wipeAll /
    // pop / keyed-reorder target our region without touching sibling
    // content in the template-form host.
    const cache = new Map();
    let cleanups = [];
    let live = [];
    const liveDrop = (clone) => {
      const oi = live.indexOf(clone);
      if (oi >= 0) live.splice(oi, 1);
    };

    const buildClone = (i, items) => {
      const clone = template.cloneNode(true);
      if (clone.style && !clone.style.contain) clone.style.contain = 'layout style';
      const scope = makeScope(outerScope, varName, i, items, arrayPath);
      return { clone, cleanup: bindDOM(clone, scope) };
    };

    const wipeAll = () => {
      for (const e of cache.values()) { e.cleanup(); e.clone.remove(); }
      cache.clear();
      callAll(cleanups);
      for (const c of live) c.remove();
      cleanups = [];
      live = [];
    };

    // For the no-key path, track prior items so push/pop appends/removes
    // only the tail. Identity match (===) over the shared prefix;
    // interior change still rebuilds. Shared prefix is the 90% case
    // (chat logs, append-only feeds).
    let prev = [];
    const appendFrom = (from, to, items) => {
      for (let i = from; i < to; i++) {
        const c = buildClone(i, items);
        cleanups.push(c.cleanup);
        live.push(c.clone);
        insertAt(c.clone, null);
      }
    };

    return bindReactive([arrayPath], (state) => {
      const items = getPathObj(state, arrayPath);
      if (!Array.isArray(items)) {
        // Undefined is the normal "path not populated yet" case; stay
        // silent. Anything else (null, object, primitive) is a real
        // type mismatch worth surfacing — data-each takes a dotted path,
        // not an expression; use computed() for derived arrays.
        if (items !== undefined) warn(`data-each="${arrayPath}" resolved to ${items === null ? 'null' : typeof items}, expected Array`);
        wipeAll(); prev = []; return;
      }

      if (!keyExpr) {
        const oldN = prev.length, newN = items.length;
        let pre = 0;
        while (pre < oldN && pre < newN && prev[pre] === items[pre]) pre++;
        if (pre === oldN && newN > oldN) appendFrom(oldN, newN, items);
        else if (pre === newN && newN < oldN) {
          while (cleanups.length > newN) {
            cleanups.pop()();
            live.pop().remove();
          }
        } else {
          wipeAll();
          appendFrom(0, newN, items);
        }
        prev = items.slice();
        return;
      }

      // Keyed path. Evaluate the key expression with the item bound
      // under `varName` so authors can write data-key="item.id".
      const keyFn = evalExpr(keyExpr);
      const newKeys = items.map(item => keyFn(state, { [varName]: item }));
      const seen = new Set();

      for (let i = 0; i < items.length; i++) {
        const key = newKeys[i];
        seen.add(key);
        let entry = cache.get(key);
        if (!entry) {
          entry = buildClone(i, items);
          cache.set(key, entry);
        } else if (entry.index !== i) {
          // Same clone, new position: tear down old bindings (paths were
          // baked to the old index) and re-bind with a scope pointed at
          // the new index. DOM identity preserved, so focus/scroll/input
          // state survives the move. This is what data-stable-key used
          // to opt into; it's now the default.
          entry.cleanup();
          entry.cleanup = bindDOM(entry.clone, makeScope(outerScope, varName, i, items, arrayPath));
        }
        entry.index = i;
        if (live[i] !== entry.clone) {
          insertAt(entry.clone, live[i]);
          liveDrop(entry.clone);
          live.splice(i, 0, entry.clone);
        }
      }

      for (const [key, entry] of cache) {
        if (!seen.has(key)) {
          entry.cleanup();
          entry.clone.remove();
          liveDrop(entry.clone);
          cache.delete(key);
        }
      }
    });
  };

  /** data-action — `cycle` (subscription) or `event[.modifier]*`
   *  (DOM event listener). Extracted so bindDOM's main walk can
   *  treat it like every other per-element binder.
   *
   *  Inside a data-each, scope is passed to callFn as the trailing
   *  argument so built-ins (trigger, setValue, setText, setStyle) can
   *  resolve `data-id="item.X"` to the row's actual state path. */
  const bindAction = (el, scope) => {
    const ds = el.dataset;
    const action = ds.action;
    const fnName = ds.fn;
    const handler = fns[fnName];
    if (!handler) {
      console.warn(`[spektrum] unknown data-fn "${fnName}"`, el);
      return;
    }
    const value = parseValue(ds.value);
    if (action === 'cycle') {
      // Cycle subscribes to data-id as a path — without it, addSystem
      // would throw deep in topKeys computation. Fail at the bind site.
      if (!ds.id) return warn(`data-action="cycle" needs data-id`);
      const idPath = resolvePath(ds.id, scope);
      return addSystem([idPath], (state, delta) => callFn(fnName, handler, el, state, delta, value, undefined, scope));
    }
    // data-action="click.prevent.stop.once" — first segment is the
    // event name; rest are flags. Mirrors Vue's v-on modifiers.
    const [eventName, ...modifiers] = action.split('.');
    const mods = new Set(modifiers);
    const has = m => mods.has(m);
    // `rm` does double duty: the listener's own `.once` self-removal
    // and the bindDOM cleanup return. Closes over `listener` and `opts`
    // — both bound before any call site executes (event time / destroy
    // time), so TDZ is not in play.
    const rm = () => el.removeEventListener(eventName, listener, opts);
    const listener = (ev) => {
      for (const m of mods) {
        const g = KEY_GATE[m];
        if (g && (g[0] === ':' ? ev.key !== g.slice(1) : !ev[g])) return;
      }
      if (has('self') && ev.target !== el) return;
      if (has('prevent')) ev.preventDefault();
      if (has('stop')) ev.stopPropagation();
      callFn(fnName, handler, el, appState, appStateDelta, value, ev, scope);
      if (has('once')) rm();
    };
    const opts = { capture: has('capture'), passive: has('passive') };
    el.addEventListener(eventName, listener, opts);
    return rm;
  };

  // --- bindDOM: top-level scan ---

  /**
   * Scan `root` for declarative bindings and wire them up. Returns a
   * destroy() that undoes everything. Idempotent at the root level —
   * calling bindDOM(sameRoot) twice is a no-op until destroy() runs.
   *
   * Pass order:
   *   1. [data-each]    — first, to detach per-item templates before
   *                       other scans walk into them
   *   2. {{expr}}       — text nodes
   *   3. one walk over every element: :attr, data-if/model/ref/intent/
   *      action — each binder early-returns when its attribute is
   *      absent, so the cost of "ask every element" is just the
   *      hasAttribute check. data-cloak is stripped on the same pass.
   */
  const bindDOM = (root, scope) => {
    root = root || document;
    // Idempotency keys on root identity. For data-each clones, scope is
    // present and reorder re-binds the same clone with a new scope, so
    // the WeakSet check would falsely short-circuit — skip it on scoped
    // calls (bindEach's reorder path takes care of teardown explicitly).
    if (!scope) {
      if (boundRoots.has(root)) return () => {};
      boundRoots.add(root);
    }
    const unsubs = [];
    // Every cleanup goes into both the local list (for this destroy())
    // and the instance-level allCleanups (for reset()'s drain).
    const collect = (u) => { if (u) { unsubs.push(u); allCleanups.add(u); } };

    // True when `n` lives under a data-each host strictly between it
    // and the current walk root — i.e. owned by an inner bindEach,
    // which will (or has already) bound its clone subtree on its own.
    // Walking from parent (not n itself) so the host element itself
    // still gets its own :attrs / data-if / data-cloak processed.
    const ownedByEach = (n) => {
      let p = n.parentNode;
      while (p && p !== root) {
        if (p[EACH_HOST]) return true;
        p = p.parentNode;
      }
      return false;
    };

    // contains() guard: skip data-each elements that were detached by
    // an outer bindEach earlier in this same loop iteration. Nested
    // data-each: outer's scope passes through here so the inner binder
    // can resolve its arrayPath through the outer's path map.
    for (const el of root.querySelectorAll('[data-each]')) {
      if (!root.contains(el) || ownedByEach(el)) continue;
      collect(bindEach(el, scope));
    }

    walkTextNodes(root, (n) => {
      if (ownedByEach(n)) return;
      collect(bindText(n, scope));
    });

    // Single walk over every descendant. Replaces 5 separate
    // querySelectorAll calls (one per directive) plus the dedicated
    // data-cloak strip pass — same behavior, fewer tree traversals.
    for (const el of root.querySelectorAll('*')) {
      if (ownedByEach(el)) continue;
      collect(bindAttrs(el, scope));
      const ds = el.dataset;
      if (ds.if     !== undefined) collect(bindIf(el, scope));
      if (ds.model  !== undefined) collect(bindModel(el, scope));
      if (ds.ref    !== undefined) collect(bindRef(el));
      if (ds.intent !== undefined) collect(bindIntent(el));
      if (ds.action !== undefined) collect(bindAction(el, scope));
      el.removeAttribute('data-cloak');
    }
    // root itself wasn't in the walk above (querySelectorAll excludes
    // it); strip its data-cloak too. Optional chain for `document`.
    root.removeAttribute?.('data-cloak');

    return () => {
      boundRoots.delete(root);
      callAll(unsubs);
      // Drop fired cleanups from the instance set so reset() doesn't
      // call them a second time.
      for (const u of unsubs) allCleanups.delete(u);
    };
  };

  /** Portable JSON snapshot. Default: state + history + cursor (replay-
   *  able via loadHistory). See README "Serializing state" for opts. */
  const serialize = (opts = {}) => {
    const out = { state: appState };
    if (opts.includeHistory !== false) { out.history = history; out.cursor = cursor; }
    if (opts.includeForks) out.forks = forks;
    return JSON.stringify(out);
  };

  // === Agent surface ===
  // describe / explain / attempt / findByIntent — introspection and
  // speculative-execution affordances designed for AI agents (and
  // useful to humans). The engine is small enough to fit in any
  // model's context; these methods turn that into a complete
  // operational manifest the agent can read and reason over.

  /** Operational manifest of the running instance. Returns plain JSON
   *  so an agent (or supervisor / dashboard) can read everything in
   *  one call: current state, registered systems and their subscribed
   *  paths, fns and their declared schemas, named refs, registered
   *  semantic intents, checkpoints, and history shape. Cheap — no
   *  serialization of history entries themselves. Pair with serialize()
   *  when the agent needs the full mutation log. */
  const describe = () => ({
    state: appState,
    cursor,
    historyLength: history.length,
    forkCount: forks.length,
    snapshotCount: snapshots.length,
    options: { historyLimit, snapshotEvery, forkLimit },
    systems: systems.map(s => ({ paths: s.paths, name: s.fn.name || '' })),
    fns: Object.entries(fns).map(([n, f]) => ({ name: n, ...(f.meta || {}) })),
    refs: Object.keys(refs),
    intents: Object.fromEntries(Object.entries(intents).map(([k, v]) => [k, v.length])),
    checkpoints: checkpointsOf(),
  });

  /** Causal trace over a history range. Each entry is annotated with
   *  the systems whose subscriptions intersect its path — i.e. who
   *  *would* have fired in response. Useful for an agent reconstructing
   *  why state moved. Note: subscriber set is the CURRENT registry, not
   *  a historical record of who actually fired (engine doesn't preserve
   *  that). For most cases — agents reading their own recent edits —
   *  the two coincide. */
  const explain = (opts = {}) => {
    const from = Math.max(0, opts.from ?? 0);
    const to = Math.min(history.length, opts.to ?? history.length);
    return history.slice(from, to).map((e, i) => ({
      ...e,
      index: from + i,
      triggers: e.op === 'checkpoint' ? [] : systems
        .filter(s => s.paths.some(p =>
          p === e.path || e.path.startsWith(p + '.') || p.startsWith(e.path + '.')))
        .map(s => s.fn.name || ''),
    }));
  };

  /** Speculative execution. Drops a checkpoint, runs `fn`, returns a
   *  handle the caller uses to commit (mark in history) or discard
   *  (replay back to before the checkpoint, sending the speculative
   *  entries to `forks` on the next mutation). `fn` may return a value
   *  or a Promise — the caller awaits and decides.
   *
   *    const h = spektrum.attempt('apply-edit', () => editFn());
   *    if (await validate(h.result)) h.commit(); else h.discard();
   */
  const attempt = (name, fn) => {
    const start = cursor;
    checkpoint(`attempt:${name}`);
    const result = fn();
    return {
      result,
      commit:  () => checkpoint(`attempt:${name}:commit`),
      discard: () => replay(start),
    };
  };

  /** Locate elements by their declared `data-intent`. Returns a copy
   *  so the caller can iterate without racing the registry. Empty
   *  array when no element carries the intent. */
  const findByIntent = (name) => intents[name]?.slice() || [];

  // --- Built-in fns (registered per instance) ---
  // Signature: (el, state, delta, value, event?, scope?). The trailing
  // `scope` is set by bindAction inside a data-each so built-ins can
  // resolve `data-id="item.X"` through the iteration's path map.

  defineFn('trigger',  (el, _s, _d, v, _e, sc) => trigger (histId(el), resolvePath(el.dataset.id, sc), fnVal(el, v)));
  defineFn('setValue', (el, _s, _d, v, _e, sc) => setValue(resolvePath(el.dataset.id, sc), fnVal(el, v), histId(el)));

  defineFn('setText', (el, state, _d, _v, _e, sc) => {
    el.textContent = getPathObj(state, resolvePath(el.dataset.id, sc));
  });

  defineFn('setStyle', (el, state, _d, _v, _e, sc) => {
    const v = getPathObj(state, resolvePath(el.dataset.id, sc));
    el.style[el.dataset.prop] = `${v}${el.dataset.suffix || ''}`;
  });

  defineFn('toggle', (el) => {
    const target = document.querySelector(el.dataset.target);
    if (target) target.classList.toggle(el.dataset.class);
  });

  // --- Public API of the instance ---

  return {
    appState, appStateDelta, history, snapshots, forks, refs, intents,
    get cursor() { return cursor; },
    get replaying() { return replaying; },
    get checkpoints() { return checkpointsOf(); },
    trigger, setValue, checkpoint, computed, addAsync, refresh,
    addSystem, watch, removeSystem, defineFn, onError, onRecord, onFork,
    bindDOM, run, tick, replay, reset, resetState, serialize,
    describe, explain, attempt, findByIntent,
  };
};

// === Default singleton ===

const _default = createSpektrum();
export default _default;
export const {
  appState, appStateDelta, history, snapshots, forks, refs, intents,
  trigger, setValue, checkpoint, computed, addAsync, refresh,
  addSystem, watch, removeSystem, defineFn, onError, onRecord, onFork,
  bindDOM, run, tick, replay, reset, resetState, serialize,
  describe, explain, attempt, findByIntent,
} = _default;

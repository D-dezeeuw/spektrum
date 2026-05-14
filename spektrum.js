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

const evalExpr = (expr) => {
  let fn = evalCache.get(expr);
  if (fn) return fn;
  try {
    // Dotted-numeric segments (`users.0.name` from bindEach) → bracket
    // notation so JS can parse. Inner try/catch so paths not yet in
    // state render as undefined instead of throwing.
    const normalized = expr.replace(/([a-zA-Z_$][\w$]*)\.(\d+)/g, '$1[$2]');
    const compiled = new Function('state', `with (state) { return (${normalized}); }`);
    fn = (state) => { try { return compiled(state); } catch { return undefined; } };
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
 *  cleanly without leaking `bar` as a subscription path. */
const extractPaths = (expr) => {
  const paths = new Set();
  const stripped = expr.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
  for (const m of stripped.matchAll(IDENT)) {
    const id = m[1];
    if (RESERVED.test(id.split('.')[0])) continue;
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

  /** Run one system, routing exceptions through the error handlers. */
  const runSystem = (sys) => {
    try { sys.fn(appState, appStateDelta); }
    catch (err) {
      if (errorHandlers.size) safeFire(errorHandlers, 'onError', err, sys.fn);
      else console.error('[spektrum] system threw', err);
    }
  };

  /** Invoke a data-fn handler, routing sync throws AND async rejections
   *  through onError (or console.error fallback). Without this, async
   *  handler rejections land as unhandled-promise warnings and never
   *  reach the registered error path. */
  const callFn = (name, fn, ...args) => {
    const onErr = (err, tag) => {
      if (errorHandlers.size) safeFire(errorHandlers, 'onError', err, fn);
      else console.error(`[spektrum] ${tag} data-fn "${name}"`, err);
    };
    try {
      const r = fn(...args);
      if (r?.then) r.catch(err => onErr(err, 'async'));
    } catch (err) { onErr(err, 'sync'); }
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
   *  subscriptions don't intersect the delta's top-level keys. */
  const addSystem = (paths, fn) => {
    const entry = { paths, fn, topKeys: paths.map(p => p.split('.')[0]) };
    systems.push(entry);
    return () => {
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
      for (const sys of toRun) runSystem(sys);
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

  /** :attr="expression". Property write (not setAttribute). `:class` /
   *  `:className` route through applyClass(). URL-bearing attributes
   *  rewrite javascript:-scheme strings to '#'. */
  const bindAttrs = (el) => {
    const unsubs = [];
    for (const a of [...el.attributes]) {
      if (a.name[0] !== ':') continue;
      const prop = a.name.slice(1), expr = a.value;
      if (!expr) continue;
      const isClass = prop === 'class' || prop === 'className';
      const isUrl = /^(href|src|action|formaction|background|cite|poster|data)$/.test(prop);
      unsubs.push(bindReactive(extractPaths(expr), (state) => {
        let v = evalExpr(expr)(state);
        if (isClass) return applyClass(el, v);
        if (isUrl && typeof v === 'string' && JS_SCHEME.test(v)) v = '#';
        el[prop] = v;
      }));
    }
    return unsubs.length && (() => callAll(unsubs));
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
   *  Trailing dot-separated modifiers (Vue-style):
   *    .lazy    commit on `change` instead of `input`
   *    .number  coerce element value via parseFloat (NaN → string)
   *    .trim    trim whitespace before write
   *  Chainable: `data-model="query.trim.lazy"`. The modifier names are
   *  reserved suffixes — if your state has a leaf literally named
   *  `lazy`/`number`/`trim`, route through `data-action="input"` +
   *  `setValue` directly. */
  const bindModel = (el) => {
    const raw = el.dataset.model;
    if (!raw) return;
    const parts = raw.split('.');
    const mods = new Set();
    while (/^(lazy|number|trim)$/.test(parts.at(-1))) {
      mods.add(parts.pop());
    }
    const path = parts.join('.');
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

  /** Replace whole-word occurrences of `varName` with `prefix` in every
   *  text node and attribute value under `root`. Used by bindEach to
   *  convert per-item template paths (`user.name` → `users.3.name`). */
  const rewriteScope = (root, varName, prefix) => {
    const re = new RegExp(`\\b${varName}\\b`, 'g');
    const sub = (s) => s.includes(varName) ? s.replace(re, prefix) : s;
    walkTextNodes(root, (n) => { n.textContent = sub(n.textContent); });
    for (const el of [root, ...root.querySelectorAll('*')])
      for (const a of [...el.attributes]) a.value = sub(a.value);
  };

  /** data-each list rendering. Three modes (no-key / keyed / keyed +
   *  stable-key) are documented in the README directive table and the
   *  "Known trade-offs" section. Per-clone `contain: layout style` is
   *  set for perf isolation. */
  const bindEach = (el) => {
    const arrayPath = el.dataset.each;
    if (!arrayPath) return;
    const varName = el.dataset.as || 'item';
    const keyExpr = el.dataset.key;
    const stableKey = el.hasAttribute('data-stable-key');
    // data-stable-key is a no-op without data-key — its whole purpose is
    // to opt into a path within the keyed branch. Author probably wants
    // the reorder-free behavior; surface the missing prerequisite.
    if (stableKey && !keyExpr) warn(`data-stable-key on "${arrayPath}" needs data-key`);
    const templateChild = el.firstElementChild;
    // data-each marks the *container*; its first element child is the
    // template. A bare loop body (text-only, comment-only, whitespace)
    // used to silent-no-op — surface it so the misuse is visible.
    if (!templateChild) {
      warn(`data-each="${arrayPath}" needs an element child to clone`);
      return;
    }
    // data-as substitution is whole-word string replace (rewriteScope);
    // short or common names will rewrite unrelated text/attributes in
    // the template subtree. 'item' is the silent default; flag the rest.
    if (varName !== 'item' && (varName.length <= 2 || /^(index|key|value|name|el|fn|id|data)$/.test(varName))) {
      warn(`data-as="${varName}" is short/common — rewrites \\b${varName}\\b across template text/attrs`);
    }
    // Check the delta too — bindDOM commonly runs before the first
    // tick, so setValue('user', …) before bind leaves the key in
    // appStateDelta only. A merged check catches both cases.
    if (varName !== 'item' && (varName in appState || varName in appStateDelta)) {
      warn(`data-as="${varName}" shadows state.${varName}`);
    }
    const template = templateChild.cloneNode(true);
    templateChild.remove();

    // Keyed cache: key -> { clone, cleanup, index }. Unkeyed mode keeps
    // a flat cleanups[] and rebuilds on every change.
    const cache = new Map();
    let cleanups = [];

    const buildClone = (i) => {
      const clone = template.cloneNode(true);
      if (clone.style && !clone.style.contain) clone.style.contain = 'layout style';
      if (!stableKey) rewriteScope(clone, varName, arrayPath + '.' + i);
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
        if (pre === oldN && newN > oldN) appendFrom(oldN, newN);
        else if (pre === newN && newN < oldN) {
          while (cleanups.length > newN) {
            cleanups.pop()();
            el.lastElementChild?.remove();
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

  /** data-action — `cycle` (subscription) or `event[.modifier]*`
   *  (DOM event listener). Extracted so bindDOM's main walk can
   *  treat it like every other per-element binder. */
  const bindAction = (el) => {
    const action = el.dataset.action;
    const handler = fns[el.dataset.fn];
    if (!handler) {
      console.warn(`[spektrum] unknown data-fn "${el.dataset.fn}"`, el);
      return;
    }
    const value = parseValue(el.dataset.value);
    const fnName = el.dataset.fn;
    if (action === 'cycle') {
      // Cycle subscribes to data-id as a path — without it, addSystem
      // would throw deep in topKeys computation. Fail at the bind site.
      if (!el.dataset.id) return warn(`data-action="cycle" needs data-id`);
      return addSystem([el.dataset.id], (state, delta) => callFn(fnName, handler, el, state, delta, value));
    }
    // data-action="click.prevent.stop.once" — first segment is the
    // event name; rest are flags. Mirrors Vue's v-on modifiers.
    const [eventName, ...modifiers] = action.split('.');
    const mods = new Set(modifiers);
    const has = m => mods.has(m);
    const listener = (ev) => {
      for (const m of mods) {
        const g = KEY_GATE[m];
        if (g && (g[0] === ':' ? ev.key !== g.slice(1) : !ev[g])) return;
      }
      if (has('self') && ev.target !== el) return;
      if (has('prevent')) ev.preventDefault();
      if (has('stop')) ev.stopPropagation();
      callFn(fnName, handler, el, appState, appStateDelta, value, ev);
      if (has('once')) el.removeEventListener(eventName, listener, opts);
    };
    const opts = { capture: has('capture'), passive: has('passive') };
    el.addEventListener(eventName, listener, opts);
    return () => el.removeEventListener(eventName, listener, opts);
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

    // Single walk over every descendant. Replaces 5 separate
    // querySelectorAll calls (one per directive) plus the dedicated
    // data-cloak strip pass — same behavior, fewer tree traversals.
    for (const el of root.querySelectorAll('*')) {
      collect(bindAttrs(el));
      const ds = el.dataset;
      if (ds.if     !== undefined) collect(bindIf(el));
      if (ds.model  !== undefined) collect(bindModel(el));
      if (ds.ref    !== undefined) collect(bindRef(el));
      if (ds.intent !== undefined) collect(bindIntent(el));
      if (ds.action !== undefined) collect(bindAction(el));
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

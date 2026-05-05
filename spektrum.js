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

/** Walk a dotted path into `obj`. Returns the leaf value or undefined. */
export const getPathObj = (obj, path) =>
  path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);

/** True if every segment of `path` resolves on `obj`. */
const isPath = (obj, path) =>
  path.split('.').every(k => (obj = obj == null ? undefined : obj[k]) !== undefined);

/**
 * Materialise *intermediate* segments of `path` as `{}` on `obj`. The
 * leaf is left absent — earlier versions materialised it too, which
 * polluted appState with `{}` placeholders that bindings read back
 * pre-tick, producing `"[object Object]"` on `<input>.value`.
 */
const createNestedObjects = (obj, path) => {
  const keys = path.split('.');
  keys.pop();
  keys.reduce((acc, k) => (acc[k] = acc[k] || {}), obj);
  return obj;
};

/** Walk `path` (creating missing parents) and assign `value` at the leaf. */
export const setPathValue = (obj, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((acc, k) => (acc[k] = acc[k] || {}), obj);
  target[last] = value;
};

const deepMerge = (target, source) => {
  /* Recursive in-place merge: plain values overwrite, nested objects descend. */
  for (const k of Object.keys(source)) {
    const v = source[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Replace the slot with {} when target[k] is a primitive or array,
      // otherwise descending and writing properties on a primitive throws.
      if (target[k] == null || typeof target[k] !== 'object' || Array.isArray(target[k])) {
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

// === Expression engine ===
// Compile-on-first-use, cached by source string. Templates are
// author-written, so `new Function` is acceptable (same caveat as
// Vue and Alpine — don't accept untrusted templates).

const evalCache = new Map();

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
    console.warn(`[spektrum] invalid expression: "${expr}"`, err);
    fn = () => undefined;
  }
  evalCache.set(expr, fn);
  return fn;
};

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

/** Create an isolated Spektrum instance. Each call returns its own
 *  state, delta, history, systems, fns, and refs — fully separate from
 *  other instances. */
export const createSpektrum = () => {

  const appState = {};
  const appStateDelta = {};
  const history = [];
  const systems = [];
  const fns = {};
  const refs = {}; // DOM handles registered via data-ref="name"
  let cursor = 0;
  let replaying = false;
  let boundRoots = new WeakSet(); // tracks bindDOM roots for idempotency

  // --- Engine helpers (state-bound) ---

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
   *  future first if scrubbed back. */
  const record = (entry) => {
    if (cursor < history.length) history.length = cursor;
    applyEntry(entry);
    history.push(entry);
    cursor = history.length;
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
    for (let i = 0; i < systems.length; i++) {
      if (systems[i].fn === fn) {
        systems.splice(i, 1);
        return true;
      }
    }
    return false;
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
      for (const sys of toRun) {
        try { sys.fn(appState, appStateDelta); }
        catch (err) { console.error('[spektrum] system threw', err); }
      }
    }
  };

  /** rAF-driven tick pump. */
  const run = () => {
    tick();
    requestAnimationFrame(run);
  };

  /** Wipe runtime state. Built-in fns survive. Also resets refs and
   *  the bindDOM idempotency tracker. */
  const reset = () => {
    clearObject(appState);
    clearObject(appStateDelta);
    clearObject(refs);
    history.length = 0;
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
    for (let i = 0; i < n; i++) {
      applyEntry(history[i]);
      cursor = i + 1;
      tick();
    }
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
    const snapshot = {};
    deepMerge(snapshot, appState);
    deepMerge(snapshot, appStateDelta);
    render(snapshot, appStateDelta);
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
      unsubs.push(bindReactive(extractPaths(expr), (state) => {
        const v = evalExpr(expr)(state);
        if (isClass) applyClass(el, v);
        else el[prop] = v;
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

  /** data-each="arrayPath" data-as="varName". First child is captured
   *  as a template and detached. On any change to arrayPath: wipe,
   *  clone-and-bind per item with paths rewritten to absolute form.
   *  Each clone gets `contain: layout style` for perf isolation.
   *  Cost: O(n × bindings-per-item) per change. No keyed reconciliation. */
  const bindEach = (el) => {
    const arrayPath = el.dataset.each;
    if (!arrayPath) return;
    const varName = el.dataset.as || 'item';
    const templateChild = el.firstElementChild;
    if (!templateChild) return;
    const template = templateChild.cloneNode(true);
    templateChild.remove();

    let cleanups = [];
    return bindReactive([arrayPath], (state) => {
      callAll(cleanups);
      cleanups = [];
      el.replaceChildren();

      const items = getPathObj(state, arrayPath);
      if (!Array.isArray(items)) return;

      items.forEach((_, i) => {
        const clone = template.cloneNode(true);
        if (clone.style && !clone.style.contain) clone.style.contain = 'layout style';
        rewriteScope(clone, varName, `${arrayPath}.${i}`);
        cleanups.push(bindDOM(clone));
        el.appendChild(clone);
      });
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
        const listener = () => handler(el, appState, appStateDelta, value);
        el.addEventListener(action, listener);
        unsubs.push(() => el.removeEventListener(action, listener));
      }
    }

    return () => {
      boundRoots.delete(root);
      callAll(unsubs);
    };
  };

  // --- Built-in fns (registered per instance) ---

  defineFn('trigger', (el, _s, _d, value) => {
    const histId = el.dataset.name || `${el.dataset.fn}@${el.dataset.id}`;
    trigger(histId, el.dataset.id, value ?? parseValue(el.value));
  });

  defineFn('setValue', (el, _s, _d, value) => {
    const histId = el.dataset.name || `${el.dataset.fn}@${el.dataset.id}`;
    setValue(el.dataset.id, value ?? parseValue(el.value), histId);
  });

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
    appState, appStateDelta, history, refs,
    get cursor() { return cursor; },
    get replaying() { return replaying; },
    trigger, setValue, computed,
    addSystem, removeSystem, defineFn,
    bindDOM, run, tick, replay, reset,
  };
};

// === Default singleton ===
// Most apps want one engine per page; this is it. Named exports below
// pull off the same instance so existing import-style code keeps working.

const _default = createSpektrum();
export default _default;
export const {
  appState, appStateDelta, history, refs,
  trigger, setValue, computed,
  addSystem, removeSystem, defineFn,
  bindDOM, run, tick, replay, reset,
} = _default;

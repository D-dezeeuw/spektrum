/*
  Tiny reactive engine.

  - Mutations write into a per-instance delta (never directly into committed state).
  - Each tick: any system whose subscribed paths appear in the delta runs,
    the delta is merged into appState, then the delta is wiped.
  - Every mutation is logged to history so replay(n) can rebuild any past point.

  Public API: a default singleton (`export default`) plus named exports of its
  methods for the common single-instance case. For multiple isolated apps on
  one page, call createSpektrum() to get a fresh instance.
*/

// === Module-level constants and pure utilities ===
// These don't depend on instance state, so they live outside the factory.

const MUSTACHE = /\{\{\s*([^}]+?)\s*\}\}/g;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// type: (Dict[str, Any], str) -> Any
export const getPathObj = (obj, path) => {
  /*
  Walk a dotted path into `obj` and return the leaf value.

  Args:
      obj (Dict[str, Any]): root object to descend into.
      path (str): dotted path, e.g. "gas.value" or "users.0.name".

  Returns:
      Any: the value at `path`, or undefined if any segment is missing.
  */
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
};

const isPath = (obj, path) => {
  /* True if every segment of `path` resolves on `obj`. */
  return path.split('.').every(k => (obj = obj == null ? undefined : obj[k]) !== undefined);
};

const createNestedObjects = (obj, path) => {
  /* Materialise every segment of `path` (including the leaf) as `{}` on `obj`. */
  path.split('.').reduce((acc, k) => (acc[k] = acc[k] || {}), obj);
  return obj;
};

export const setPathValue = (obj, path, value) => {
  /*
  Walk `path` (creating missing parents) and assign `value` at the leaf.

  Useful for systems that want to fan out into the delta without going
  through history, e.g. mirroring engine-internal state into a path that
  declarative bindings can subscribe to.
  */
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
      target[k] = target[k] || {};
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

// Expression engine: compile-on-first-use, cached by source string.
// Templates are author-written, so `new Function` is acceptable here —
// the same caveat Vue and Alpine carry. Don't accept untrusted templates.
const evalCache = new Map();

const evalExpr = (expr) => {
  let fn = evalCache.get(expr);
  if (fn) return fn;
  try {
    // Normalize dotted-numeric segments (e.g. `users.0.name`, the form
    // bindEach produces after path rewriting) into bracket notation
    // (`users[0].name`) so JS can parse them. Templates can use either
    // form; both work on the engine side because path subscriptions
    // are still dotted.
    const normalized = expr.replace(/([a-zA-Z_$][\w$]*)\.(\d+)/g, '$1[$2]');
    const compiled = new Function('state', `with (state) { return (${normalized}); }`);
    // Wrap in a runtime try/catch so an expression touching a path
    // that isn't in state yet (common during the initial render before
    // the first tick) doesn't throw — just renders as undefined.
    fn = (state) => {
      try { return compiled(state); }
      catch { return undefined; }
    };
  } catch (err) {
    console.warn(`[spektrum] invalid expression: "${expr}"`, err);
    fn = () => undefined;
  }
  evalCache.set(expr, fn);
  return fn;
};

// Identifier extractor used to derive subscription paths from an
// expression. Lookbehind excludes identifiers preceded by a dot or word
// char so `user.name.toUpperCase` is captured once (not three times).
const IDENT = /(?<![\w$.])([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/g;
const RESERVED = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'this',
  'Math', 'JSON', 'Date', 'Number', 'String', 'Array', 'Object',
  'Boolean', 'RegExp', 'Error', 'Map', 'Set', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
]);

const extractPaths = (expr) => {
  /*
  Pull subscribable identifier paths out of an expression source string.

  Returns the list of dotted paths the expression depends on, with
  reserved-word heads (Math, JSON, true, ...) filtered out. Method
  calls on values (e.g. user.name.toUpperCase) end up as
  "user.name.toUpperCase"; isPath() handles the over-precise prefix
  match correctly because string/array methods are own properties.
  String literals and bracketed access can produce false-positive
  identifiers; those are harmless (subscriptions to non-existent
  paths simply never fire).
  */
  const paths = new Set();
  for (const m of expr.matchAll(IDENT)) {
    const id = m[1];
    if (RESERVED.has(id.split('.')[0])) continue;
    paths.add(id);
  }
  return [...paths];
};

const applyClass = (el, v) => {
  /*
  Set element classes from a value. Supports three forms:
    string:  el.className = v                       (overwrites all classes)
    array:   el.className = filter(Boolean).join    (overwrites)
    object:  classList.toggle(name, !!flag) per key (preserves siblings)
  */
  if (typeof v === 'string') {
    el.className = v;
  } else if (Array.isArray(v)) {
    el.className = v.filter(Boolean).join(' ');
  } else if (v && typeof v === 'object') {
    for (const [name, on] of Object.entries(v)) {
      el.classList.toggle(name, !!on);
    }
  }
};

const walkTextNodes = (root, visit) => {
  /*
  Visit every text-node descendant of `root`, including `root` itself
  if it's a text node. Hand-written walker rather than DOM TreeWalker
  because some DOM implementations (happy-dom in particular) return
  no nodes for SHOW_TEXT filters even when text descendants exist.
  */
  if (root.nodeType === 3) {
    visit(root);
    return;
  }
  for (const child of root.childNodes) walkTextNodes(child, visit);
};

// === Factory ===

// type: () -> Spektrum
export const createSpektrum = () => {
  /*
  Create an isolated Spektrum instance.

  Each instance owns its own state, delta, history, systems, and fns.
  Multiple instances on the same page do not interfere.

  Returns:
      An object with the engine's public API. See the named exports at
      module bottom for the same fields on the default instance.
  */

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

  const checkPath = (path) => {
    /* Ensure both delta and state have parents materialised for `path`. */
    if (!isPath(appStateDelta, path)) createNestedObjects(appStateDelta, path);
    if (!isPath(appState, path)) createNestedObjects(appState, path);
  };

  const applyEntry = (e) => {
    /* Dispatch a recorded entry into the delta. Used by record() and replay(). */
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

  const record = (entry) => {
    /*
    Apply an entry, append it to history, advance the cursor.
    Truncates the future first if the cursor is scrubbed back.
    */
    if (cursor < history.length) history.length = cursor;
    applyEntry(entry);
    history.push(entry);
    cursor = history.length;
  };

  // --- Public mutators ---

  const trigger = (id, path, value) => {
    /*
    Record an additive numeric change. Multiple triggers in one tick accumulate.
    */
    record({ id, path, value, op: 'add' });
  };

  const setValue = (path, value, id) => {
    /*
    Record an absolute set. Overwrites any pending value at `path`.

    If `id` is omitted, an autogenerated label `set:<path>` is used so
    history entries always carry a meaningful identifier (no magic
    placeholders leaking into logs). Pass an explicit id when the call
    site has a meaningful name — `setValue('gas.value', 100, 'seed')`.
    */
    record({ id: id || `set:${path}`, path, value, op: 'set' });
  };

  // --- Subscriptions ---

  const addSystem = (paths, fn) => {
    /*
    Register `fn` to run on ticks where the delta touches any of `paths`.

    The top-level key of each subscribed path is cached so the per-tick
    filter can skip systems whose subscriptions don't intersect the
    delta's top-level keys before doing the full isPath walk.

    Returns:
        An unsubscribe function. Call it to detach the system.
    */
    const entry = {
      paths,
      fn,
      topKeys: paths.map(p => p.split('.')[0]),
    };
    systems.push(entry);
    return () => {
      const i = systems.indexOf(entry);
      if (i !== -1) systems.splice(i, 1);
    };
  };

  const removeSystem = (fn) => {
    /*
    Detach the first system registered with `fn` as its handler.

    Returns:
        bool: true if a system was removed.
    */
    for (let i = 0; i < systems.length; i++) {
      if (systems[i].fn === fn) {
        systems.splice(i, 1);
        return true;
      }
    }
    return false;
  };

  const defineFn = (name, fn) => {
    /* Register a named handler callable from `data-fn` attributes. */
    fns[name] = fn;
  };

  // --- Tick / lifecycle ---

  const tick = () => {
    /*
    Run one simulation step, draining the delta to quiescence.

    Each pass: snapshot subscribed systems, merge delta into state,
    clear the delta, then run the systems. Systems that write to the
    delta during their run have those writes processed by another pass —
    fan-out (e.g. a system mirroring history into a state path that
    data-each subscribes to) propagates within a single tick.

    The snapshot via filter() is a defensive copy so systems can safely
    splice `systems` during their handlers (bindEach rebuilds rely on
    this). The 1024-iteration cap guards against runaway feedback
    loops; in practice fan-outs are 1–2 deep.

    Note: because the delta is cleared before systems run, the `delta`
    argument they receive starts empty. If a system needs to react to a
    specific change, derive it from state, or watch only the path that
    triggered it — the subscription already tells you that.
    */
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
        try {
          sys.fn(appState, appStateDelta);
        } catch (err) {
          console.error('[spektrum] system threw', err);
        }
      }
    }
  };

  const run = () => {
    /* rAF-driven tick pump. */
    tick();
    requestAnimationFrame(run);
  };

  const reset = () => {
    /*
    Wipe runtime state. Useful for tests and dev hot-reload.
    Built-in fns survive (they're set up at instance creation).
    Also resets the bindDOM idempotency tracker so a fresh bind works.
    */
    clearObject(appState);
    clearObject(appStateDelta);
    clearObject(refs);
    history.length = 0;
    systems.length = 0;
    boundRoots = new WeakSet();
    cursor = 0;
    replaying = false;
  };

  const replay = (n) => {
    /*
    Reset state and re-apply the first `n` recorded entries.

    O(n) per call. History is preserved — scrub back and forth at will.
    A new trigger while scrubbed truncates the future.

    For step-back undo, drive replay from `cursor` (the live playback
    position), NOT `history.length` — history doesn't shrink on replay,
    so successive `replay(history.length - 1)` calls land at the same
    spot every time. The correct pattern is:

        defineFn('undo', () => {
          replay(Math.max(seedCount, cursor - 1));
        });

    where `seedCount` is the number of setValue/seed entries you want
    to keep applied at the bottom (typically 1 — your initial state).
    */
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

  // --- Binding helpers ---
  // Each helper returns an unsubscribe (or undefined if it didn't bind).
  // bindDOM collects these and returns a destroy function for the whole tree.

  const bindReactive = (paths, render) => {
    /*
    Register a system AND fire it once against current state at bind time.
    Returns the system's unsubscribe.
    */
    const unsub = addSystem(paths, render);
    render(appState, appStateDelta);
    return unsub;
  };

  const bindText = (node) => {
    /*
    Bind `{{expression}}` placeholders in a text node.

    Each placeholder is a JavaScript expression evaluated against state.
    A bare path (`{{count}}`) is just the simplest expression; richer
    forms like `{{count + 1}}`, `{{user.name.toUpperCase()}}`, or
    `{{flag ? "yes" : "no"}}` work the same way. Subscription paths are
    extracted by identifier scan; the expression re-runs whenever any
    referenced path appears in the delta.

    Templates are author-written — authors are trusted not to write
    side-effecting expressions. Don't accept untrusted templates.
    */
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

  const bindAttrs = (el) => {
    /*
    Bind `:attr="expression"` shorthands to element properties.

    The attribute value is a JS expression (a bare path is the simplest
    case). Result is assigned via property write, not setAttribute, so
    `:value` updates form state and `:disabled` toggles the boolean prop.

    Special case: `:class` and `:className` route through applyClass()
    which accepts strings, arrays, or objects:
      :class="myStr"                 → overwrites className
      :class="['a', flag && 'b']"    → joins, overwrites
      :class="{active: x, err: y}"   → toggles named classes individually
    */
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

  const bindIf = (el) => {
    /*
    Bind `data-if="expression"` to display visibility.

    Expression form lets you write `data-if="!user.loggedIn"` or
    `data-if="count > 0"` without a derived state path. Truthy result →
    element shows; falsy → display: none. Children stay bound and keep
    receiving updates while hidden — matches Vue's v-show, not v-if.
    */
    const expr = el.dataset.if;
    if (!expr) return;
    return bindReactive(extractPaths(expr), (state) => {
      el.style.display = evalExpr(expr)(state) ? '' : 'none';
    });
  };

  const bindModel = (el) => {
    /*
    Bind `data-model="path"` for two-way binding.

    Shorthand for the verbose pair of `:value="path"` (state → element)
    plus `data-action="input" data-fn="setValue" data-id="path"` (element
    → state). Detects checkboxes by `el.type === 'checkbox'` and uses
    `el.checked` + the `change` event accordingly; everything else uses
    `el.value` + `input`. Writes go through setValue so they land in
    history with id `model:<path>`.
    */
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

  const bindRef = (el) => {
    /*
    Bind `data-ref="name"` to expose the element on instance.refs.

    Refs are framework-level handles, not domain state — they don't go
    through history or replay. Useful for imperative DOM access (focus,
    scroll, measure) from app code: `instance.refs.email.focus()`.
    */
    const name = el.dataset.ref;
    if (!name) return;
    refs[name] = el;
    return () => { delete refs[name]; };
  };

  const computed = (path, deps, fn) => {
    /*
    First-class derived state. Computes `state[path]` from `deps` whenever
    any of them change, writing the result into the delta so subscribers
    fire on the next tick pass.

    Equivalent to: `addSystem(deps, (state, delta) => setPathValue(delta,
    path, fn(state)))`. Returns the unsubscribe handle.

    Args:
        path (str): dotted path to write the computed value into.
        deps (List[str]): paths to watch — re-computes when any change.
        fn (Callable[[State], Any]): receives current state, returns the value.

    Returns:
        () -> None: unsubscribe handle.
    */
    return addSystem(deps, (state, delta) => {
      setPathValue(delta, path, fn(state));
    });
  };

  const rewriteScope = (root, varName, prefix) => {
    /*
    Replace whole-word occurrences of `varName` with `prefix` in every
    text node and attribute value of `root` and its descendants.

    Used by bindEach to convert per-item template paths (`user.name`)
    into absolute state paths (`users.3.name`).
    */
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

  const bindEach = (el) => {
    /*
    Bind `data-each="arrayPath" data-as="varName"` to render an array.

    The element's first child is captured as a per-item template (and
    detached from the live DOM). On every change to `arrayPath`, the
    container is wiped and the template is cloned + bound once per item;
    occurrences of `varName` inside each clone are rewritten to absolute
    paths (`arrayPath.<i>`) so cycle bindings resolve correctly.

    Each cloned item gets `contain: layout style` for free perf isolation.

    Cost: O(n × bindings-per-item) per array change. No keyed
    reconciliation — appropriate when items are short-lived or the array
    rarely changes after-the-fact. Pair with cleanup (unsub returned by
    bindDOM) so the previous render's systems are detached on rebuild.
    */
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

  const bindDOM = (root) => {
    /*
    Scan `root` for declarative bindings and wire them into the engine.

    Forms (all reactive, all returning unsubs collected here):
      data-each="path"            on any element        — render array (FIRST pass)
      {{expression}}              in any text node      — interpolated text
      :attr="expression"          on any element        — property write (object form for :class)
      data-if="expression"        on any element        — show/hide via display
      data-model="path"           on form controls      — two-way binding
      data-ref="name"             on any element        — expose el on instance.refs
      data-action="cycle"         + data-fn / data-id   — cycle system
      data-action="click|..."     + data-fn             — DOM event listener

    data-each runs first because it detaches its per-item template from
    the live tree; subsequent passes only see what's still attached, so
    the template's {{...}} placeholders aren't bound prematurely.

    Idempotent at the root level: calling bindDOM(sameRoot) twice is a
    safe no-op. Don't call with overlapping subtrees (e.g. the document
    and a child of it) — only the root reference is tracked, not every
    descendant. Calling the returned destroy() releases the root so it
    can be bound again.

    Returns:
        () -> None: call to detach every binding made by this scan.
    */
    root = root || document;
    if (boundRoots.has(root)) return () => {};
    boundRoots.add(root);
    const unsubs = [];

    const collect = (u) => { if (u) unsubs.push(u); };

    // Process data-each FIRST so per-item templates are detached before any
    // other pass walks into them — otherwise the text/attr scans would
    // eagerly bind {{event.x}} placeholders against the document scope and
    // overwrite them with '' (since `event` doesn't resolve there). The
    // contains() guard skips elements detached by an earlier outer bindEach.
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

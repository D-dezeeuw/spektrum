# `spektrum/inspect` — Design Doc

**Status.** **Phase 1 + 3.2 shipped** (Element Inspector, Mutation Tracer, Static Lint). Phase 2 (state diff + subscription map) and Phase 3.1 (loop registry) are deferred — see [Sequencing & milestones](#sequencing--milestones). For user-facing docs of what shipped, see [modules.md#spektruminspect](modules.md#spektruminspect).
**Author.** Drafted 2026-05-14, response to the 14-05 feedback batch.
**Companion to.** `spektrum/devtools` (time-travel scrubber) and `spektrum/dock` (shared container) — complementary, not overlapping.

---

## Why this exists

The 1.1 DX batch closed the loudest silent failures by adding inline `warn()` calls (data-each / data-as / cycle / empty-path / async). What remains is the next layer of debugging questions — the ones a `warn` line can't answer because they require *context*:

| Developer question | Today's answer | What `inspect` would give |
| --- | --- | --- |
| "What state does this element actually see?" | Read source, manually trace bindings, hand-evaluate `:href="user.profile.url"` against `spektrum.appState` | Hover the element → tooltip with every binding + its current value |
| "Why is this system running on every tick?" | Add `console.log` to the system; re-load; clear; repeat | Live mutation log filtered by path, annotated with which systems each entry fired |
| "What changed in state since I clicked that button?" | Snapshot manually, JSON-stringify, diff in your head | Pin a baseline, see a tree-diff updating in real time |
| "Is this `data-each` actually rendering? How many items?" | Open DevTools, look at children count | Loop registry: every `data-each` on the page, with resolved length and key-collision flags |
| "Who listens to `state.cart.total`?" | Read every `addSystem` / `computed` call in the source | Subscription map: path → system names, with write-only paths flagged |

These are the questions that consume hours of debugging time and don't get an answer from `console.warn`. They need a UI.

## What this is not

Each of these has a perfectly good existing solution. `spektrum/inspect` will *not*:

- **Replace `spektrum/devtools`.** Devtools owns the time-travel scrubber — replay slider, history log, fork detection. Inspect can *complement* it (e.g. diff between two cursor positions), but it doesn't duplicate the scrubber.
- **Profile performance.** Browser DevTools already does flame graphs, paint timings, GC. Don't reinvent.
- **Replace network DevTools.** `addAsync` fetches are visible in the Network tab; that's where they belong.
- **Mutate state for you.** That's the `agent` companion's job. Inspect is read-only — no buttons that call `setValue`.
- **Provide an a11y audit.** Out of scope; use axe or Lighthouse.

## Hard constraints

1. **No core changes.** Inspect must work via the existing public API (`spektrum.appState`, `spektrum.history`, `spektrum.describe()`, `spektrum.onRecord`, etc.) and DOM traversal. No `onDevEvent` hook added to core, no monkey-patching of binder internals. This is a hard rule: if a feature needs core support, it doesn't ship until core grows the surface for some other reason.
2. **Pay-only-when-imported.** Production users who don't import `spektrum/inspect` pay zero bytes. Same model as every other companion.
3. **Per-companion size cap, enforced in CI.** Target **≤ 6 KB minified / ≤ 2.5 KB gzipped** (between `spektrum/mcp` at 5 KB and `spektrum/agent` at 12 KB). The companion's `size.js` entry needs its own line, set when the first phase ships.
4. **No bundler required.** Like all companions, ships as a side-effect-free ESM that works from a CDN.
5. **One file.** Same auditability rule as core: `spektrum-inspect.js`, no internal module splits. Comments explain *why*.
6. **Multi-instance compatible.** Takes an instance argument; never reaches for the default singleton implicitly.

## Architecture

Single floating panel (side panel, like devtools) with **tabs**. One file, one mount function, mount returns unmount — same shape as [`spektrum/devtools`](../spektrum-devtools.js).

```js
import { mount } from 'spektrum/inspect';

const unmount = mount(spektrum, {
  position: 'top-left',           // 'top-left'|'top-right'|'bottom-left'|'bottom-right'
  parent:   document.body,        // any Element
  features: ['elements', 'mutations', 'diff', 'loops', 'subs', 'lint'],
  pinKey:   'Alt',                // hold to freeze hover tooltips
  consoleEcho: false,             // also log mutations through console.group
});

unmount();                         // remove panel, detach listeners
```

**Layout.** Vertical tab bar on one side of the panel; selected tab renders into a single content area. Keeps the DOM footprint small and lets users hide tabs they don't need via `features:`.

**Why not separate floating widgets?** Five floating widgets is visual noise. One panel with tabs is the standard React/Vue devtools shape; users already know how to read it.

**Why not extend `spektrum/devtools`?** Devtools is intentionally minimal — one job, ~3 KB. Bolting inspect onto it would force every devtools user to ship inspect's weight. Separate modules; compose by mounting both.

## Features (phased)

Phasing matches "ship something useful first, expand later." Each phase compiles independently and is independently shippable. Cancel any phase that doesn't earn its bytes after real-world use.

### Phase 1 (MVP) — Elements + Mutations

The two features that pay for the panel by themselves. If these two land, the rest is optional.

#### 1.1 Element Inspector

**Problem.** "What state does this element see right now?"

**UX.**

- `inspect` mode toggles via a button in the panel header (or hold `Alt` from `pinKey:`).
- While active, hovering any element draws a thin outline and shows a fixed tooltip listing every binding on that element + every binding inherited from its `data-each` ancestor.
- Click an element to pin the tooltip (mouse can move away). Click elsewhere or press `Esc` to unpin.

**What the tooltip shows.**

```text
<div :class="state.theme" data-if="user.loggedIn">
  bindings:
    :class    → state.theme           = "dark"
    data-if   → user.loggedIn         = true
  inside loop:
    data-each → gallery.data.items[3] (length: 24, key: item.id)
    data-as   → item                  = { id: "sku-42", price: 19.99 }
```

**Implementation sketch.**

```js
// Mouse capture phase so we beat page handlers.
document.addEventListener('mouseover', onHover, true);

function onHover(ev) {
  if (!inspectMode) return;
  const el = ev.target;
  const bindings = readBindings(el);                     // see below
  const loopCtx = findLoopContext(el);                   // walk up for data-each
  outlineEl(el);
  renderTooltip(ev.clientX, ev.clientY, bindings, loopCtx);
}

function readBindings(el) {
  const out = [];
  for (const a of el.attributes) {
    if (a.name[0] === ':')          out.push({ kind: 'attr',  name: a.name, expr: a.value });
    else if (a.name === 'data-if')  out.push({ kind: 'if',    expr: a.value });
    else if (a.name === 'data-model') out.push({ kind: 'model', path: a.value });
    else if (a.name === 'data-each') out.push({ kind: 'each',  path: a.value, as: el.dataset.as || 'item', key: el.dataset.key });
    // …data-ref, data-intent, data-action, data-fn, data-id, data-value
  }
  // Text nodes: scan for {{ … }} placeholders, list each as its own binding.
  for (const n of el.childNodes)
    if (n.nodeType === 3 && n.textContent.includes('{{'))
      for (const m of n.textContent.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g))
        out.push({ kind: 'text', expr: m[1].trim() });
  return out;
}
```

**Evaluating bindings.** For simple paths (e.g. `user.profile.name`), use the existing exported `getPathObj(state, path)` to read the value. For complex expressions (`count + 1`, `user.name.toUpperCase()`), **show the source verbatim** — don't re-evaluate via `new Function` (CSP-hostile, also duplicates engine work). A small affordance: if the expression is a single identifier or dotted path, evaluate it; otherwise display "expression — read in DevTools." This covers the 80% case for ~20 LOC.

**Cost estimate.** ~2 KB minified.

#### 1.2 Mutation Tracer

**Problem.** "Why is this system re-running?" / "What just changed in state?"

**UX.**

- Scrolling log inside the panel: timestamp, op, path, value (truncated), and the names of systems that fired in response.
- Filter input (regex on path).
- Pause / resume button.
- "Echo to console" toggle — when on, every entry also goes through `console.groupCollapsed` so it survives panel unmount.

**Display example.**

```text
14:23:01.412  set  gallery.data.items   Array(24)   → renderGallery, recountFilters
14:23:01.413  add  cart.total           +19.99      → renderCartTotal, recomputeShipping
14:23:01.414  ◆    attempt:apply-edit                (checkpoint)
```

**Implementation sketch.**

```js
const seenEntries = [];
const stopRecord = spektrum.onRecord(entry => {
  const triggers = whoSubscribesTo(entry.path);          // see below
  seenEntries.push({ ts: Date.now(), ...entry, triggers });
  if (seenEntries.length > 500) seenEntries.shift();     // bounded
  renderLog(filterPattern, paused ? null : seenEntries);
  if (consoleEcho) console.groupCollapsed(`[spektrum] ${entry.op} ${entry.path}`);
});

function whoSubscribesTo(path) {
  return spektrum.describe().systems
    .filter(s => s.paths.some(p =>
      p === path || path.startsWith(p + '.') || p.startsWith(path + '.')))
    .map(s => s.name || '(anon)');
}
```

`describe()` returns the *current* subscriber registry, not a historical snapshot — same caveat as `explain()` in core. Document this.

**Cost estimate.** ~1.2 KB minified.

### Phase 2 — Diff + Subscription Map

#### 2.1 State Diff

**Problem.** "What state changed since I clicked that button?"

**UX.**

- "Snap" button — captures the current state (`JSON.parse(JSON.stringify(spektrum.appState))`).
- Tree view of the diff between the snapped state and current:
  - **Green:** added paths
  - **Yellow:** changed values (old → new)
  - **Red:** removed paths
- Auto-refresh as state changes (subscribe via `onRecord`, recompute lazily).
- "Re-snap" button to update the baseline.

**Implementation sketch.**

```js
function diff(a, b, path = '') {
  // Recursive walk; emit { path, kind: 'add'|'change'|'remove', from, to } records.
  // For arrays: index-based comparison (good enough; not LCS).
}
```

Don't try to display giant diffs — cap displayed entries at e.g. 200 with an "expand" link.

**Cost estimate.** ~800 B minified.

#### 2.2 Subscription Map

**Problem.** "Who listens to `cart.total`?" / "Which paths have no subscribers — are they dead writes?"

**UX.**

- Tree view of every subscribed path, sorted lexically.
- Each leaf shows: list of system names subscribed to it (or any ancestor).
- A "Write-only paths" section: paths that appear in `spektrum.history` but match no subscriber's `paths`. Strong signal of dead state.

**Implementation sketch.**

```js
function buildSubMap() {
  const map = new Map();
  for (const sys of spektrum.describe().systems)
    for (const p of sys.paths)
      (map.get(p) ?? map.set(p, []).get(p)).push(sys.name || '(anon)');
  return map;
}
function writeOnlyPaths() {
  const subscribed = new Set([...buildSubMap().keys()]);
  const written = new Set(spektrum.history.map(e => e.path).filter(Boolean));
  return [...written].filter(p =>
    ![...subscribed].some(s => s === p || p.startsWith(s + '.') || s.startsWith(p + '.')));
}
```

**Cost estimate.** ~600 B minified.

### Phase 3 — Loops + Lint

#### 3.1 Loop Registry

**Problem.** "Is this list actually rendering? Are my keys colliding?"

**UX.**

- List of every `[data-each]` on the page.
- Per loop: bound path, resolved array length, `data-as` name, `data-key` expression if any, **key collision count** (computed by evaluating the key expr against each item).
- Click a row to scroll/outline the loop in the page.

**Implementation sketch.**

```js
function scanLoops() {
  return [...document.querySelectorAll('[data-each]')].map(el => {
    const path = el.dataset.each;
    const items = getPathObj(spektrum.appState, path);
    const result = { el, path, length: Array.isArray(items) ? items.length : null,
                     as: el.dataset.as || 'item', key: el.dataset.key };
    if (result.key && Array.isArray(items)) {
      // Best-effort: only handle simple `item.foo` keys; complex expressions skip
      const m = result.key.match(/^(\w+)\.([\w.]+)$/);
      if (m) {
        const keys = items.map(i => getPathObj(i, m[2]));
        result.collisions = keys.length - new Set(keys).size;
      }
    }
    return result;
  });
}
```

**Cost estimate.** ~700 B minified.

#### 3.2 Static Lint

**Problem.** Things that *would* have been inline warns in core but the size budget rejected — most notably the stray-`{{…}}`-in-attribute footgun (B.1.b from the 14-05 plan).

**UX.**

- One-shot scan on `mount()`, plus a "re-lint" button. Results render as a list with severity, message, and a "scroll to" link to each offending element.

**Initial checks.**

- `{{…}}` in plain (non-`:`, non-`data-`) attribute values → warn (B.1.b).
- `data-action="event"` with a modifier not in the known set → info (the unknown-modifier warn that core deliberately doesn't ship).
- `data-fn="name"` where `name` isn't registered in `spektrum.describe().fns` → warn.
- `data-key="item.foo"` where `foo` isn't on the first item of the resolved array → info.

This is the *expensive* lint — runs once on demand, prints findings, doesn't run on every render. The expensive walk that core can't justify lives here for free.

**Cost estimate.** ~700 B minified.

## Public API (proposed)

```ts
export function mount(
  spektrum: Spektrum,
  opts?: {
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    parent?: Element;
    features?: Array<'elements' | 'mutations' | 'diff' | 'loops' | 'subs' | 'lint'>;
    pinKey?: 'Alt' | 'Shift' | 'Meta' | 'Control';
    consoleEcho?: boolean;
  },
): () => void;

// Programmatic access (no UI). Useful in tests and for headless agents.
export function readBindings(el: Element): BindingInfo[];
export function snapshotDiff(prev: object, curr: object): DiffEntry[];
export function whoSubscribesTo(spektrum: Spektrum, path: string): string[];
export function scanLoops(spektrum: Spektrum, root?: Element): LoopInfo[];
export function lint(spektrum: Spektrum, root?: Element): LintFinding[];
```

The programmatic helpers are exported individually so tests and agents can consume the data without rendering a panel. Each helper has a small, named return shape — the `BindingInfo` / `LintFinding` etc types ship in `spektrum-inspect.d.ts`.

## Size budget

| Phase | Features | Target Δ | Cumulative target |
| --- | --- | --- | --- |
| 1 | Elements + Mutations | ~3.2 KB | ~3.2 KB raw / ~1.5 KB gz |
| 2 | Diff + Subs | ~1.4 KB | ~4.6 KB raw / ~2.0 KB gz |
| 3 | Loops + Lint | ~1.4 KB | ~6.0 KB raw / ~2.5 KB gz |

Cap proposal for [scripts/size.js](../scripts/size.js) at Phase 1 ship:

```js
{ file: 'spektrum-inspect.min.js', raw: 3584, gz: 1792 },
```

Raise to `{ raw: 5120, gz: 2304 }` at Phase 2, `{ raw: 6144, gz: 2560 }` at Phase 3 — each bump tied to a named, justified feature set in the `scripts/size.js` comment block.

## Open questions (to resolve before Phase 1)

1. **Tooltip rendering: shadow DOM or just very-high z-index?**
   Shadow DOM gives total style isolation but adds ~200 B and a small accessibility cost. Devtools chose plain DOM with `z-index: 2147483647`. **Default:** match devtools — plain DOM. Switch to shadow if real-world style conflicts surface.

2. **What happens when an element has *no* bindings?**
   Skip the tooltip silently? Show "no bindings"? **Default:** skip silently; outline-on-hover stops mid-paint. A "show all elements" power-user toggle could surface unbound elements later.

3. **Should the panel resize?**
   Devtools is fixed-width. With more content, inspect may need to. **Default:** start fixed (`width: min(360px, calc(100vw - 24px))`), add a drag handle in Phase 2 if needed.

4. **Multi-instance: one panel per instance, or one panel that toggles?**
   `mount(spektrumA)` + `mount(spektrumB)` should both work without collision. **Default:** one panel per call — tag panel with `data-spektrum-inspect="<instance-id>"`. User responsible for positioning them apart.

5. **Devtools + Inspect together: any visual conflict?**
   Same coordinate space. **Default:** document a recommended layout (e.g. devtools `bottom-right`, inspect `top-left`); don't try to auto-arrange.

6. **Does the mutation tracer leak memory on long sessions?**
   Cap `seenEntries.length` at 500 (already in the sketch). Drop oldest on overflow.

## Sequencing & milestones

1. **Phase 1 ship** — element inspector + mutation tracer. Behind a `1.2.0-alpha` tag if needed to gauge real-world feedback before committing the cap.
2. **Real-world use** — dogfood on the demo, the hourly-weather app, and the my-confs app for a release cycle. Collect feedback about what's missing.
3. **Phase 2 if Phase 1 lands.** Add diff + subs based on what users actually ask for.
4. **Phase 3 only if asked.** Loops + lint may turn out to be over-engineered; ship if demand exists, skip if not.

## What this *also* unlocks

- **Better agent debugging.** The `spektrum/agent` panel and external MCP clients can call the programmatic helpers (`readBindings`, `lint`, `scanLoops`) without rendering a UI. Useful for agentic test suites and "review this page" workflows.
- **Headless test affordances.** `snapshotDiff(prev, curr)` is exactly what a test author needs to assert state transitions after an action — could move to `spektrum/test` later if a testing companion ever materializes.
- **Educational tool.** New users hover an element to see how bindings work. Reduces the learning curve more than any doc paragraph.

## Out of scope (deliberately)

These came up in early discussion and should not ship in any phase without an explicit follow-up proposal:

- **Hot-reload / live edit.** A read-only inspector is small and safe; an editor is a different product.
- **Time-travel scrubber.** Use `spektrum/devtools`.
- **Performance profiling overlay.** Browser DevTools.
- **A11y audit.** Use `axe-core`.
- **`onDevEvent` core hook.** The original feedback proposed this; the inspector explicitly avoids needing it. If real implementation work surfaces a case that genuinely requires a core hook, that's a separate proposal — don't fold it in here.

## Related

- [Constraints](constraints.md) — the rules every feature here must pass through (single file, zero deps, per-companion size cap)
- [Modules](modules.md) — the four companions inspect would join (devtools, persist, compile, mcp, agent)
- [Trade-offs](trade-offs.md) — the inline-warn-vs-companion decisions the 1.1 batch already made
- Feedback that motivated this proposal: [implementation-plan-14-05.md](../notes/implementation-plan-14-05.md) §6 ("Big Idea: `spektrum/inspect` Companion Module")

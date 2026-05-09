<p align="center">
  <img src="example/Spektrum-logo.png" alt="Spektrum" width="480">
</p>

[![npm](https://img.shields.io/npm/v/spektrum.svg)](https://www.npmjs.com/package/spektrum)
[![bundle size](https://img.shields.io/bundlephobia/minzip/spektrum.svg)](https://bundlephobia.com/package/spektrum)
[![license](https://img.shields.io/npm/l/spektrum.svg)](LICENSE)
[![types](https://img.shields.io/npm/types/spektrum.svg)](spektrum.d.ts)

**[Live demo →](https://d-dezeeuw.github.io/spektrum/example/)**

A tiny templating engine with **time-travel built into the primitive**, deliberately auditable, drop-in, and CSP-safe.

- **Time-travel.** Every mutation is recorded. `replay(n)` rebuilds any past state. Scrub a slider through it; ship undo without thinking. The optional `spektrum/devtools` panel renders the scrubber for you in dev.
- **Auditable.** ~10 kB minified (4.5 kB gzipped), under 1000 lines (engine source), **zero runtime dependencies**, single file. Read it in an afternoon. The ecosystem keeps proving how fragile dependency sprawl is; Spektrum's design follows from that constraint.
- **Drop-in.** ESM from a `<script type="module">` tag — works in a plain HTML file, a WordPress theme, a browser extension, a CMS code block, an Electron renderer, anywhere you can write HTML. No bundler, no SPA framework, no `npm install` required. Pin a version: `https://unpkg.com/spektrum@0.3.5`.
- **CSP-safe.** Out of the box, expressions compile via `new Function` (same caveat as Vue/Alpine). For deployments behind strict CSP that disable `unsafe-eval`, run `spektrum/compile` at build time — every template expression precompiles into a plain JS module, and the runtime never reaches the `Function` fallback.

The rest is consequences.

## Features

- Declarative HTML bindings: `{{expr}}`, `:attr="expr"`, `data-if="expr"`, `data-each`, `data-key`, `data-action`, `data-model`, `data-ref`.
- Real expressions in templates — `{{count + 1}}`, `:disabled="count <= 0"`, `data-if="!user.loggedIn"`. Path lookups still work; they're just the simplest expression.
- Two-way input binding via `data-model="path"` (covers text inputs and checkboxes).
- Conditional class binding with object form: `:class="{active: x, error: y}"`.
- **Keyed list reconciliation** via `data-key="item.id"` — items at the same key + index keep their DOM, listeners, focus, and selection across re-renders.
- Event modifiers on `data-action`: `.prevent`, `.stop`, `.once` (e.g. `data-action="submit.prevent"`).
- Element refs via `data-ref="name"` → `instance.refs.name` for imperative access.
- First-class derived state via `computed(path, deps, fn)`.
- Reactive engine: subscribed systems, delta-driven tick loop, fan-out within a single tick.
- **History keeping with snapshots**: `historyLimit` to bound memory, `snapshotEvery` to make `replay()` O(K) instead of O(n).
- **`onError(fn)`** hook for surfacing system exceptions to your app.
- Test-friendly: `tick()`, `reset()`, `replay()` are public, synchronous, and deterministic. No mocks, no fake timers, no awaiting microtasks.
- Multiple isolated instances via `createSpektrum()`.
- TypeScript declarations included.

## What it doesn't do — explicit non-goals

If any of these are deal-breakers for your project, **rule Spektrum out now** rather than discover it late:

- **No SSR or hydration.** Client-only. The engine assumes a real DOM at bind time. Some orgs need server-rendered initial state for SEO or first-paint — Spektrum won't deliver that.
- **No components or slots.** Compose via JS factories (`createSpektrum()`, plain functions that return DOM templates) — this is a deliberate stance, like Alpine. If you want `<MyButton>`-style template authoring, reach for Vue or Lit.
- **No transitions system.** Use CSS classes + `:class="…"` for state-driven transitions; Spektrum gives you the binding, the browser does the animation.
- **No router or store layer.** Engine, not framework. Bring your own routing (or use the `data-model`/`computed` primitives to roll a hash-based one in ~20 lines). State is just `appState` — no stores, no slices.
- **Templates are author-written.** Expressions execute via `new Function` unless precompiled (same caveat as Vue/Alpine — don't accept untrusted templates).

What's *coming* (1.x track): the parked Phase 2 items in the [RFC](.claude/references/RFC.md) — `data-intent`, `data-schema`, optional `test()` harness. Deferred until usage data shapes them.

## Install

```bash
npm install spektrum
```

Or load straight from a CDN — no install, no build step. Spektrum ships minified `.min.js` builds for the engine and both runtime helpers (`devtools`, `persist`); the `compile` module ships only un-minified since it's read by your build script.

### From a CDN

unpkg (and jsDelivr, which uses the same conventions) serve the minified entry by default:

```html
<script type="module">
  import { setValue, bindDOM, run } from 'https://unpkg.com/spektrum';
  // ...
</script>
```

For the helpers, reference the `.min.js` siblings explicitly:

```html
<script type="module">
  import { setValue, bindDOM } from 'https://unpkg.com/spektrum';
  import { mount }             from 'https://unpkg.com/spektrum/spektrum-devtools.min.js';
  import { autoSave }          from 'https://unpkg.com/spektrum/spektrum-persist.min.js';
</script>
```

### With an importmap (named specifiers, no build)

The cleanest no-build form — every spektrum import keeps its bare-specifier form, and you can swap CDNs by editing one block:

```html
<script type="importmap">
{
  "imports": {
    "spektrum":          "https://unpkg.com/spektrum",
    "spektrum/devtools": "https://unpkg.com/spektrum/spektrum-devtools.min.js",
    "spektrum/persist":  "https://unpkg.com/spektrum/spektrum-persist.min.js"
  }
}
</script>
<script type="module">
  import { setValue, bindDOM } from 'spektrum';
  import { mount }             from 'spektrum/devtools';
</script>
```

### Pinning a version

For anything beyond a quick experiment, **pin to a known version** so a future spektrum release can't change behavior under you. unpkg accepts any npm-resolvable specifier:

```html
<script type="module">
  // Replace <version> with a concrete version, e.g. 0.4.1.
  // Find the latest at https://www.npmjs.com/package/spektrum.
  import { setValue, bindDOM } from 'https://unpkg.com/spektrum@<version>';
</script>
```

For extra defense against package compromise, hit `https://unpkg.com/spektrum@<version>?meta` to see the resolved file paths and cite a specific path with subresource integrity (`<script integrity="sha384-…">`) if your threat model needs it. Provenance is already attached to every published tarball ([npmjs.com/package/spektrum](https://www.npmjs.com/package/spektrum)).

### `.min.js` vs `.js`

Both ship in the package. The `.min.js` versions are what production bundles want — typically ~50% smaller transfer for the engine and helpers. The un-minified `.js` files are kept around for the "audit it in an afternoon" pitch — clone or `npm view` and read the source as-shipped. Bundlers (Webpack, Vite, Rollup, esbuild) reach the un-minified entry by default and minify it themselves; that's fine.

## Quick start

```html
<p>{{count}}</p>
<button data-action="click" data-fn="trigger" data-id="count" data-value="1" data-name="inc">+1</button>

<script type="module">
  import { setValue, bindDOM, run } from 'spektrum';
  setValue('count', 0);
  bindDOM();
  run();
</script>
```

That's a working reactive counter. State lives in the engine, the `<p>` stays in sync via `{{count}}`, the button mutates state via `data-action`/`data-fn` — no virtual DOM, no build step.

## Subpath modules

Spektrum ships three optional companion modules. Pull in only what you need; nothing leaks into the core bundle.

| Import | Purpose |
| --- | --- |
| `spektrum/devtools` | Floating scrubber panel — rewind, replay, watch state move. |
| `spektrum/persist` | `saveHistory` / `loadHistory` over localStorage (or any Storage-shaped backend). |
| `spektrum/compile` | Build-time helper that scans templates and emits a `precompile()` module for strict-CSP deployments. |

```js
import { mount as mountDevtools } from 'spektrum/devtools';
mountDevtools(spektrum);                                 // { position: 'top-right' } etc.

import { saveHistory, loadHistory, autoSave } from 'spektrum/persist';
loadHistory(spektrum);                                   // restore on boot
autoSave(spektrum, { debounce: 200 });                   // save on every mutation
```

## Run the local demo

```bash
npm start                 # python3 -m http.server 8088
# or, without npm:
python3 -m http.server 8088
npx http-server -p 8088
```

Open <http://127.0.0.1:8088/example/>.

## Layout

| Path | What |
| --- | --- |
| `spektrum.js` | The engine. ES module. |
| `spektrum-devtools.js` | Optional time-travel scrubber panel. |
| `spektrum-persist.js` | Optional save/load helpers over localStorage. |
| `spektrum-compile.js` | Build-time helper for CSP-safe precompile. |
| `example/index.html` | Demo page — declarative bindings using every feature. |
| `example/app.js` | Demo wiring (seed, clamp, derived flags, log fan-out, scrubber sync). |
| `spektrum.test.js` | Engine tests via `node --test`. |
| `spektrum.dom.test.js` | DOM-touching tests (happy-dom). |
| `scripts/size.js` | Zero-dep size budget enforcer. |

## Engine in three sentences

Mutations write into an append-only `appStateDelta`. Each tick drains the delta to quiescence: systems whose subscribed paths appear in the delta run, the delta merges into committed `appState` and is cleared, and any new writes during system execution kick off another pass — that's how fan-out works. Every mutation is recorded in `history` so `replay(n)` can rebuild any past point.

## Declarative bindings in HTML

| Form | Effect |
| --- | --- |
| `{{expression}}` in a text node | Interpolated text, auto-escaped. Full JS expression: `{{count + 1}}`, `{{user.name.toUpperCase()}}`. |
| `:attr="expression"` on any element | Property write. Object form on `:class` toggles named classes: `:class="{active: x, error: y}"`. |
| `data-if="expression"` | Show element when truthy, `display: none` when falsy. Children stay bound. |
| `data-each="path" data-as="name"` | Render the array at `path`, cloning the first child as a template per item. The path-rewriter is whole-word string replace — it rewrites both code positions and string literals (see [Known trade-offs](#rewritescope-rewrites-string-literals-too)). |
| `data-each ... data-key="expr"` | Keyed reconciliation. Items at the same key + index keep their DOM, listeners, focus, and selection. Without a key, the list rebuilds on each change (legacy behavior). |
| `data-each ... data-key="expr" data-stable-key` | Reuse the *same* clone across reorder. Skips path rewriting on the cloned subtree, so reorder is genuinely free of UX cost (focus, scroll, input value, selection survive moves). Author opts in by promising the row's bindings don't reference `varName.*` paths — the engine warns at bind time if they do (see [Known trade-offs](#data-each-re-clones-moved-items-default-keyed-mode)). |
| `data-model="path"` | Two-way binding for `<input>` / `<select>` / checkboxes. State → element via `:value`/`:checked`, element → state on `input`/`change` event. |
| `data-model="path.<modifiers>"` | Trailing dot-separated modifiers, chainable (Vue-style). `.lazy` commits on `change` instead of `input`; `.number` coerces via `parseFloat` (NaN → original string); `.trim` trims whitespace before write. Example: `data-model="query.trim.lazy"`. The names are reserved suffixes — see footnote below. |
| `data-ref="name"` | Expose the element on `instance.refs.name` for imperative access (`spektrum.refs.email.focus()`). |
| `data-action="cycle"` + `data-fn` + `data-id` | Subscribe a registered fn to a path. |
| `data-action="event[.modifier]*"` + `data-fn` | DOM-event dispatch. **Behavior:** `.prevent` / `.stop` / `.once` / `.self` (only when `event.target` is the bound element). **Listener options:** `.capture` / `.passive`. **Key gates:** `.enter` / `.esc` / `.tab` (key-match) and `.shift` / `.cmd` (system modifiers — Vue's `cmd` maps to `metaKey`). Chainable: `keydown.shift.enter` fires only on Shift+Enter. |

Built-in `data-fn` handlers: `trigger`, `setValue`, `setText`, `setStyle`, `toggle`. Register your own with `defineFn(name, handler)`. Handler signature: `(el, state, delta, value, event?)`. The `event` argument is the DOM `Event` for `data-action="click"`-style bindings, or `undefined` for `data-action="cycle"` (subscription-driven, no event in scope).

Derived state via `computed(path, deps, fn)` — primes synchronously from current state on registration (so registering after deps are already populated, e.g. after `loadHistory`, lands the initial value on the next tick), then re-derives whenever any `deps` change. Writes to both state and the delta so mid-tick reads see fresh values (a sibling system reading `state.derived` in the same pass gets the just-computed value, not the prior one). Returns an unsubscribe handle.

Async resources via `addAsync(path, fn)` — sets `${path}.loading` / `${path}.error` / `${path}.data` as the Promise progresses. Each phase records through `setValue`, so the round-trip lands in history (replay re-applies the values; no actual fetch re-issues). Returns a refetch handle. Example: `const refetch = spektrum.addAsync('user', () => fetch('/api/user').then(r => r.json()))`. Bind with `data-if="user.loading"`, `{{user.error}}`, `{{user.data.name}}`.

`watch(deps, fn)` is a public alias for `addSystem(deps, fn)` — same signature, conventional name.

**Footnote on `data-model` reserved suffixes.** Modifier names (`lazy`, `number`, `trim`) are stripped from the right of the path string. If your state genuinely has a leaf literally named `lazy`/`number`/`trim`, route through `data-action="input"` + `data-fn="setValue"` directly to bypass modifier parsing.

> **URL-attribute safety.** When `:href`, `:src`, `:action`, `:formaction`, `:background`, `:cite`, `:poster`, or `:data` evaluates to a string starting with `javascript:` (case-insensitive, leading whitespace ignored), Spektrum rewrites the value to `#`. This blocks the common XSS shape where an attacker-influenced value lands in an `<a :href>`. Other schemes (`https:`, `data:`, `mailto:`, etc.) pass through unchanged — review your own data sources if your threat model needs broader filtering.
>
> **Not covered:** `:srcdoc` (the value is parsed as HTML, not as a URL — same trust requirement as templates; don't bind untrusted content). The guard runs on JavaScript property writes, so attributes Spektrum doesn't expose as DOM properties (e.g. SVG `xlink:href`) are out of scope.

## `data-cloak` — suppressing the bind-time flash

Without help, the browser paints `{{count}}` literally in the DOM for one frame before `bindDOM()` runs and replaces it. To eliminate the flash, mark the affected element with `data-cloak` and pair it with a CSS rule that hides it:

```html
<style>
  [data-cloak] { visibility: hidden; }
</style>

<div id="app" data-cloak>
  <p>{{count}}</p>
</div>

<script type="module">
  import { setValue, bindDOM } from 'spektrum';
  setValue('count', 42);
  bindDOM(document.getElementById('app'));
  // bindDOM strips data-cloak after every binding has rendered, so the
  // CSS rule no longer matches and the content reveals.
</script>
```

`bindDOM` strips `data-cloak` from the bound root *and all descendants* once binding completes. The convention mirrors Vue's `v-cloak` and Alpine's `x-cloak`. Use `visibility: hidden` (preserves layout, no shift) or `display: none` (removes from layout, may cause shift on reveal) depending on your tolerance for reflow. The engine just removes the attribute — it doesn't read the property — so any pre-paint hiding strategy works.

## Public API

```js
import spektrum, {
  // state (objects mutable; cursor/replaying are getters on the default instance)
  appState, appStateDelta, history, snapshots, forks, refs,
  // mutators
  trigger, setValue, checkpoint, addAsync,
  // derived state
  computed,
  // subscriptions & hooks
  addSystem, watch, removeSystem, defineFn, onError, onRecord, onFork,
  // lifecycle
  bindDOM, run, tick, replay, reset, resetState, serialize,
  // utility
  getPathObj, setPathValue,
  // CSP-safe precompile registry
  precompile,
  // factory for multiple instances
  createSpektrum,
} from 'spektrum';

// Read live cursor / replaying via the default instance.
spektrum.cursor;     // current history position
spektrum.replaying;  // true while replay() is in flight
```

For multiple isolated apps on one page, call `createSpektrum(opts)` to get an instance with the same API.

```js
const app = createSpektrum({
  historyLimit: 1000,    // cap recorded mutations; oldest drop on overflow
  snapshotEvery: 50,     // capture appState every 50 entries → O(K) replay
  forkLimit: 50,         // cap preserved fork tails; oldest drop on overflow
});
```

## Time-travel

Every `setValue` and `trigger` is recorded into `history`. `replay(n)` reconstructs the state after the first `n` entries. With `snapshotEvery`, replay finds the latest snapshot at-or-before `n` and walks forward only the remainder — turning O(n) replay into O(K) for long histories.

Drop in the optional devtools panel for a scrubber UI:

```js
import { mount } from 'spektrum/devtools';
const unmount = mount(spektrum);   // top-right by default
```

Persist across reloads with the persist module:

```js
import { autoSave, loadHistory } from 'spektrum/persist';
loadHistory(spektrum);
autoSave(spektrum, { debounce: 200 });
```

## Checkpoints

A logically atomic event ("a search completed", "a form submitted", "wizard step 3 finished") is a *span* of `setValue` calls in Spektrum, not a single one. Replaying to the *end* of one of those spans used to require an app-side sentinel pattern (`setValue('_marker', …)` placed carefully as the last write). `checkpoint(name, metadata?)` is the first-class form:

```js
spektrum.checkpoint('search-done', { query: 'amsterdam' });
```

A checkpoint records a tagged history entry (`op: 'checkpoint'`) that has **no state effect** — `replay()` walks past it unchanged. It fires `onRecord` so `autoSave` catches it. The companion getter `spektrum.checkpoints` returns each checkpoint entry plus its position in `history`:

```js
// Replay to right after a named checkpoint:
const cp = spektrum.checkpoints.find(c => c.id === 'search-done');
spektrum.replay(cp.index + 1);
```

The `+1` lands at the position *after* the checkpoint — the checkpoint itself contributes no state, so `cp.index` and `cp.index + 1` represent the same state, but the +1 form is convention so the cursor sits past the marker.

Persisted via `spektrum/persist` (`loadHistory` recognises `op: 'checkpoint'` and re-applies via the same `checkpoint()` API). The devtools panel renders checkpoint entries with a `◆` accent so they're scannable in the scrubber log.

## Forking history

Mutating while scrubbed back overwrites the future entries with the new edit. The dropped tail isn't lost — it's preserved on `spektrum.forks` and the optional `onFork` hook fires:

```js
spektrum.onFork((fork) => {
  // fork = { entries, forkedAt, ts }
  console.warn(`discarded ${fork.entries.length} future edits at cursor ${fork.forkedAt}`);
});
```

Each fork is a plain `HistoryEntry[]` (no new types), tagged with the cursor it forked from and a wall-clock timestamp. Restore by re-applying:

```js
const restore = (fork) => {
  for (const e of fork.entries) {
    if (e.op === 'set') spektrum.setValue(e.path, e.value, e.id);
    else spektrum.trigger(e.id, e.path, e.value);
  }
};

restore(spektrum.forks.at(-1));   // re-apply the most recently dropped tail
```

Hook is descriptive: by the time it fires, the truncate has happened. To get a confirm-before-discard UX, run the prompt in your `data-fn` handler before calling the mutator. The fork array is capped by `forkLimit` (default `50`); set `forkLimit: 0` to discard forks immediately, `Infinity` to keep all of them.

## CSP-safe deployments

The default runtime compiles expressions via `new Function`. Strict CSPs that disable `unsafe-eval` block that path. Use the build-time scanner to precompile every expression once:

```js
// build script
import { extractExpressions, emitPrecompileSource } from 'spektrum/compile';
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const exprs = extractExpressions(html);
writeFileSync('precompiled.js', emitPrecompileSource(exprs));
```

Then load the generated module before `bindDOM()`:

```html
<script type="module" src="./precompiled.js"></script>
<script type="module" src="./app.js"></script>
```

With every expression precompiled, the cache hits before the runtime ever reaches the `Function` fallback. The emitted module is plain ESM — no string-to-code conversion at runtime.

> **Note on the trust model.** Precompile removes the *runtime* `new Function` requirement (the CSP-friendliness) — it does **not** change the trust requirement on templates. The emitted functions still use `with(state)`, so a template expression like `{{constructor.constructor("…")()}}` is still reachable. "We precompiled, so untrusted templates are fine" is wrong. Templates remain author-written, same caveat as Vue/Alpine.

## Error handling

```js
spektrum.onError((err, systemFn) => {
  // Surface to your app: telemetry, toast, dev overlay, etc.
  console.error('system failed:', err);
});
```

Without a handler, throwing systems fall through to `console.error`. The engine itself never crashes — one bad system doesn't abort the rest of the tick.

**Structured engine errors.** Errors raised by the engine itself (not by user systems) carry a `code` discriminator so apps and agentic tooling can branch on root cause without pattern-matching the message:

```js
spektrum.onError((err, systemFn) => {
  if (err.code === 'E_TICK_OVERFLOW') metrics.increment('spektrum.tick_overflow');
  else if (systemFn) reportSystemFailure(systemFn.name, err);
  else console.error('[spektrum]', err);
});
```

Current codes: `E_TICK_OVERFLOW` (tick fan-out exceeded 1024 iterations; delta discarded). User-thrown errors from systems pass through unannotated — same identity as the throwing code produced.

## Serializing state

`serialize(opts?)` returns a portable JSON snapshot, useful for SSR injection, debug captures, or off-engine inspection:

```js
const json = spektrum.serialize();
// { state, history, cursor }  — replay-able from a fresh instance via loadHistory

const stateOnly = spektrum.serialize({ includeHistory: false });
// { state }  — portable, no time-travel context

const debugDump = spektrum.serialize({ includeForks: true });
// { state, history, cursor, forks }  — for snapshots in error reports
```

Pairs with `spektrum/persist` — write the serialized output into a `<script type="application/json">` for SSR hydration, or hand it to your error reporter. Forks aren't replay-restored by `loadHistory` (they're a debug surface, not portable history); only include them when you need them.

## Lifecycle: `reset()` vs `resetState()`

Two ways to wipe runtime state, with different scopes:

- **`resetState()`** clears `appState`, `appStateDelta`, `refs`, `history`, `snapshots`, `forks`, and the `bindDOM` idempotency tracker. **Preserves** registered systems, `defineFn` entries, and hook registrations (`onError`, `onRecord`, `onFork`). Use this when you're swapping the data set under a running app — `spektrum/persist`'s `loadHistory` calls it internally.
- **`reset()`** does everything `resetState()` does *and* clears systems. Built-in fns and hook registrations still survive. Calling it with active systems emits a `[spektrum] reset() dropped N system(s); see resetState` warning — the warn is there because silent detachment has bitten users who assumed `reset()` was state-only. Use `resetState()` instead when you only want to wipe state.

Built-in `data-fn` handlers (`trigger`, `setValue`, `setText`, `setStyle`, `toggle`) are re-registered on every `createSpektrum()`; they survive both reset paths.

## Commands

```bash
npm test           # run the test suite (node:test, no deps)
npm run lint       # eslint
npm run build      # minified bundle
npm run size       # assert size budget
npm start          # serve on :8088
```

## Browser support

Modern evergreen browsers, plus Safari ≥ 16 and Firefox ≥ 90. Spektrum uses lookbehind regex, `WeakSet`, `String.matchAll`, and `Object.entries`; all are baseline-supported in those releases. Node ≥ 22 is required for the test suite (CI runs on Node 24 LTS).

## Known trade-offs

Things people sometimes flag as bugs that are deliberate, with the reasoning. If your case doesn't fit the rationale, file an issue — these are choices, not stone tablets.

### Expressions use `with(state)` inside `new Function`

Templates compile to `new Function('state', 'with (state) { return (expr); }')`. Two consequences worth knowing:

- **Sloppy mode applies automatically.** `new Function` always creates a function whose body is in sloppy mode unless the body itself opens with `'use strict'` — regardless of the calling module's strictness. `with` is therefore valid even when Spektrum is loaded from a strict ESM module. Verified against Node ≥ 20 and every supported browser.
- **Templates are author-written, like Vue and Alpine.** Don't compile templates from untrusted input. The constructor-escape pattern (`constructor.constructor("…")()`) is reachable from inside an expression, but only by someone authoring the template — they're already running their own code on the page. The same trust requirement applies even after `spektrum/compile`: precompiling removes the runtime `new Function` (helpful for strict CSP), it does not remove the requirement that templates be authored by you.

Why we keep `with`: a `Proxy`-based sandbox costs ~150 minified bytes and a per-eval allocation while solving a non-problem inside the stated trust model. The same is true of every alternative we evaluated.

### `data-each` re-clones moved items (default keyed mode)

Paths inside a `data-each` template are baked into each clone at clone time — `{{user.name}}` rewrites to `{{users.0.name}}` for index 0, `{{users.1.name}}` for index 1, etc. When an item changes index, its clone's bindings still read the old path, so the engine throws the clone away and builds a fresh one. UX cost: focus, scroll, selection, and any uncommitted input value in the *moved* row are lost. Items that stay put pay zero.

Why we keep this default: the rewrite is a regex one-pass instead of a tokenizer, and unmoved items (the common case) have zero cost.

**Opt-out:** `data-stable-key` (presence flag) on a keyed `data-each` skips path rewriting and reuses the same clone across reorder. The contract is that the row's bindings don't reference `varName.*` paths — they read outer-scope state, or render pure presentation. The engine scans the template at bind time and warns if a binding references the loop variable while `data-stable-key` is set:

```text
[spektrum] data-stable-key but template references "user"
```

Use `data-stable-key` when the rows are pure presentation (display the same outer state) or when the per-row bindings come exclusively from outer scope. Reorder is then genuinely free.

### `data-each` without `data-key` rebuilds the whole list

Same root cause as above: paths are baked, so any structural change re-clones. Same fix scheduled for 0.4.0.

### `rewriteScope` rewrites string literals too

Inside a `data-each` template, the rewriter doesn't distinguish code positions from string literals. Writing `{{ "user.name" }}` produces a literal that becomes `"users.0.name"` per row. A real tokenizer would fix this; the size cost is more than the foot-gun is worth.

Workaround: write expressions that return values, not strings that mention bound paths.

### `computed` writes into the delta, not state

A computed value lands in `appStateDelta` during the tick that recomputes it, and merges into `appState` when that tick commits. Mid-tick reads of the same path therefore see the *prior committed* value, not the value the current pass is producing. After `tick()` returns, both reads agree.

```js
computed('total', ['cart.items'], (s) => s.cart.items.reduce((a, x) => a + x.price, 0));
setValue('cart.items', [{price: 10}, {price: 5}]);
// During the tick this triggered, a system reading appState.total still
// sees the previous value (or undefined). After tick() returns, both
// appState.total and (a stateSnapshot read) return 15.
```

Read computed values from the snapshot/state passed to your subscriber, or after `tick()` has returned to the caller. Anything reactive sees the new value via the delta on the next pass — that's the design, not a bug.

Why we keep this: it matches the engine's commit-on-tick model. Treating the delta as the single write target keeps the `appState ⊕ appStateDelta` invariant simple to reason about.

### `history.splice(0, n)` on `historyLimit` overflow is O(n)

When `historyLimit` is set and the buffer overflows, the oldest entries get spliced off — O(n) on the array length. At the history sizes real apps reach (low thousands), the cost is negligible. An offset-pointer rewrite is queued behind every other priority.

### `walkTextNodes` is recursive

Realistic templates do not approach JS engine stack depth. A pathological template — tens of thousands of nested elements — could blow the stack. We'll convert to iterative if anyone ever reports it.

### Performance characteristics

- `replay` without `snapshotEvery` is O(n) per scrub; with snapshots, O(n mod K).
- `bindDOM` walks every text node for `{{...}}`. One-shot at boot, not a hot path.
- `tick()` filter is O(systems × paths-per-system) per pass. Fine at small scale; build a path-index if you have hundreds of systems.
- Tick fan-out is bounded to 1024 iterations; deeper feedback loops route through `onError` (with `null` for the system arg) and bail. Without an `onError` handler, the fallback is `console.warn`.
- `historyLimit` caps memory at the cost of unbounded scrubback — replay below the surviving window is undefined.

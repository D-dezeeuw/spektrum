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
- **Auditable.** ~8 kB minified, ~600 lines of actual code, **zero runtime dependencies**, single file. Read it in an afternoon. The ecosystem keeps proving how fragile dependency sprawl is; Spektrum's design follows from that constraint.
- **Drop-in.** ESM from a `<script type="module">` tag — works in a plain HTML file, a WordPress theme, a browser extension, a CMS code block, an Electron renderer, anywhere you can write HTML. No bundler, no SPA framework, no `npm install` required. Pin a version: `https://unpkg.com/spektrum@0.3.4`.
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

## What it doesn't do

- No SSR or hydration. Client-only.
- No router, store layer, or animation system. It's an engine, not a framework.
- Templates are author-written. Expressions execute via `new Function` unless precompiled (same caveat as Vue/Alpine — don't accept untrusted templates).

## Install

```bash
npm install spektrum
```

Or load straight from a CDN — no install, no build step:

```html
<script type="module">
  import { setValue, bindDOM, run } from 'https://unpkg.com/spektrum';
  // pin a specific minified build:
  // import ... from 'https://unpkg.com/spektrum@0.3.4/spektrum.min.js';
</script>
```

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
| `data-each="path" data-as="name"` | Render the array at `path`, cloning the first child as a template per item. |
| `data-each ... data-key="expr"` | Keyed reconciliation. Items at the same key + index keep their DOM, listeners, focus, and selection. Without a key, the list rebuilds on each change (legacy behavior). |
| `data-model="path"` | Two-way binding for `<input>` / `<select>` / checkboxes. State → element via `:value`/`:checked`, element → state on `input`/`change` event. |
| `data-ref="name"` | Expose the element on `instance.refs.name` for imperative access (`spektrum.refs.email.focus()`). |
| `data-action="cycle"` + `data-fn` + `data-id` | Subscribe a registered fn to a path. |
| `data-action="event[.modifier]*"` + `data-fn` | DOM-event dispatch. Modifiers: `.prevent` (preventDefault), `.stop` (stopPropagation), `.once` (auto-detach). |

Built-in `data-fn` handlers: `trigger`, `setValue`, `setText`, `setStyle`, `toggle`. Register your own with `defineFn(name, handler)`.

Derived state via `computed(path, deps, fn)` — re-runs when any `deps` change, writes the result into `path`. Returns an unsubscribe handle.

> **URL-attribute safety.** When `:href`, `:src`, `:action`, `:formaction`, `:background`, `:cite`, `:poster`, or `:data` evaluates to a string starting with `javascript:` (case-insensitive, leading whitespace ignored), Spektrum rewrites the value to `#`. This blocks the common XSS shape where an attacker-influenced value lands in an `<a :href>`. Other schemes (`https:`, `data:`, `mailto:`, etc.) pass through unchanged — review your own data sources if your threat model needs broader filtering.
>
> **Not covered:** `:srcdoc` (the value is parsed as HTML, not as a URL — same trust requirement as templates; don't bind untrusted content). The guard runs on JavaScript property writes, so attributes Spektrum doesn't expose as DOM properties (e.g. SVG `xlink:href`) are out of scope.

## Public API

```js
import spektrum, {
  // state (objects mutable; cursor/replaying are getters on the default instance)
  appState, appStateDelta, history, snapshots, forks, refs,
  // mutators
  trigger, setValue,
  // derived state
  computed,
  // subscriptions & hooks
  addSystem, removeSystem, defineFn, onError, onRecord, onFork,
  // lifecycle
  bindDOM, run, tick, replay, reset,
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

## Error handling

```js
spektrum.onError((err, systemFn) => {
  // Surface to your app: telemetry, toast, dev overlay, etc.
  console.error('system failed:', err);
});
```

Without a handler, throwing systems fall through to `console.error`. The engine itself never crashes — one bad system doesn't abort the rest of the tick.

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

### `data-each` re-clones moved items

Paths inside a `data-each` template are baked into each clone at clone time — `{{user.name}}` rewrites to `{{users.0.name}}` for index 0, `{{users.1.name}}` for index 1, etc. When an item changes index, its clone's bindings still read the old path, so the engine throws the clone away and builds a fresh one. UX cost: focus, scroll, selection, and any uncommitted input value in the *moved* row are lost. Items that stay put pay zero.

Why we keep this: the rewrite is a regex one-pass instead of a tokenizer, and unmoved items (the common case) have zero cost. An opt-in `data-stable-key` and an append/pop fast-path are scheduled for 0.4.0.

### `data-each` without `data-key` rebuilds the whole list

Same root cause as above: paths are baked, so any structural change re-clones. Same fix scheduled for 0.4.0.

### `rewriteScope` rewrites string literals too

Inside a `data-each` template, the rewriter doesn't distinguish code positions from string literals. Writing `{{ "user.name" }}` produces a literal that becomes `"users.0.name"` per row. A real tokenizer would fix this; the size cost is more than the foot-gun is worth.

Workaround: write expressions that return values, not strings that mention bound paths.

### `computed` writes into the delta, not state

A computed value lands in `appStateDelta` during the tick that recomputes it, and merges into `appState` when that tick commits. Mid-tick reads of the same path therefore see the *prior committed* value, not the value the current pass is producing. After `tick()` returns, both reads agree.

Why we keep this: it matches the engine's commit-on-tick model. Anything reactive sees the new value via the delta on the next pass.

### `history.splice(0, n)` on `historyLimit` overflow is O(n)

When `historyLimit` is set and the buffer overflows, the oldest entries get spliced off — O(n) on the array length. At the history sizes real apps reach (low thousands), the cost is negligible. An offset-pointer rewrite is queued behind every other priority.

### `walkTextNodes` is recursive

Realistic templates do not approach JS engine stack depth. A pathological template — tens of thousands of nested elements — could blow the stack. We'll convert to iterative if anyone ever reports it.

### Performance characteristics

- `replay` without `snapshotEvery` is O(n) per scrub; with snapshots, O(n mod K).
- `bindDOM` walks every text node for `{{...}}`. One-shot at boot, not a hot path.
- `tick()` filter is O(systems × paths-per-system) per pass. Fine at small scale; build a path-index if you have hundreds of systems.
- Tick fan-out is bounded to 1024 iterations; deeper feedback loops log a warning and bail. (Routing this through `onError` is on the roadmap.)
- `historyLimit` caps memory at the cost of unbounded scrubback — replay below the surviving window is undefined.

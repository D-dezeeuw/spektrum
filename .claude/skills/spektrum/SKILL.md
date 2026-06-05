---
name: spektrum
description: Build, review, or debug apps using the Spektrum reactive engine (single-file, time-travel-native, agent-driveable). Covers data-* bindings, the public API, the orient/speculate/explain/commit agent workflow, and authoring agent-ready apps. Use when working in a repo that imports `spektrum` or uses `data-action` / `data-each` / `describe()` / `attempt()`.
---

# Spektrum

A tiny reactive engine — single file, ~1100 LOC, ~12 KB minified / ~5.5 KB gzipped, zero runtime dependencies. State lives in `appState`, mutations write into `appStateDelta`, each `tick()` drains the delta and fires subscribed systems. Every mutation is recorded in `history` so `replay(n)` rebuilds any past state. Declarative HTML directives (`{{expr}}`, `:attr`, `data-if`, `data-each`, `data-model`, `data-action`, `data-ref`, `data-intent`) wire reactive nodes at `bindDOM()` time.

## When to use this skill

- The repo imports `spektrum`, has a `spektrum.js` file, or uses any companion (`spektrum/devtools`, `spektrum/persist`, `spektrum/mcp`, `spektrum/agent`, etc.).
- The user asks "how do I do X in Spektrum?" or references `describe()`, `attempt()`, `data-action`, `data-each`, `setValue`, or any directive.
- You are an agent driving a running Spektrum app (orient → speculate → explain → commit).
- You are reviewing markup or JS for a Spektrum project.

If the project uses Vue / React / Svelte / Alpine / SolidJS, this skill does **not** apply — those have separate idioms and APIs.

---

## Mental model in 60 seconds

**State + delta + tick.** All mutations land in `appStateDelta` first. `tick()` drains the delta to quiescence: systems whose subscribed paths intersect the delta run; the delta merges into `appState` and is cleared; writes during a system's run kick off another pass. The 1024-iteration cap catches feedback loops.

**Every mutation is recorded.** `setValue` / `trigger` / `checkpoint` push entries into `history`. `replay(n)` clears state and re-applies the first `n` entries. With `snapshotEvery: K`, replay is O(K) instead of O(n). When you mutate while scrubbed back, the dropped tail is preserved on `forks`.

**Write path:**
```
setValue('user.name', 'alice')
  → entry recorded in history
  → value lands in appStateDelta
  → tick() merges delta into appState
  → subscribed systems fire (data-bindings re-render, computed re-derives)
```

**Agent path:**
```
describe()        → manifest in one call (state shape, fns, intents, history)
attempt(name, fn) → speculative branch
  → fn() runs against a checkpointed cursor
  → handle.commit()  records a :commit checkpoint
  → handle.discard() replays back to the checkpoint
                     (discarded entries land on forks on next mutation)
```

See [spektrum.js](../../../spektrum.js) for the implementation, [docs/philosophy.md](../../../docs/philosophy.md) for the design rationale.

---

## Complete working example

A reactive add-to-list with keyed reconciliation, semantic intent, and a fn with metadata for agent introspection.

```html
<!DOCTYPE html>
<script type="importmap">
{ "imports": { "spektrum": "https://unpkg.com/spektrum" } }
</script>

<input data-ref="newItem" placeholder="What to buy?">
<button data-action="click" data-fn="addItem" data-intent="basket.add">add</button>

<!-- data-each marks the CONTAINER; <li> is the template (gets cloned per item).
     data-key enables keyed reconciliation — moved items keep DOM identity. -->
<ul data-each="items" data-key="item.id">
  <li>
    {{item.name}}
    <!-- data-id is rewritten per row: items.0.id, items.1.id, etc.
         The handler reads dataset.id and routes the remove via that path. -->
    <button data-action="click" data-fn="removeItem" data-id="{{item.id}}"
            data-intent="basket.remove">×</button>
  </li>
</ul>

<script type="module">
  import spektrum, { setValue, defineFn, bindDOM, run, refs } from 'spektrum';

  setValue('items', []);
  let nextId = 1;

  // defineFn metadata is what agents read via describe().fns — declare it.
  defineFn('addItem', () => {
    const name = refs.newItem.value.trim();
    if (!name) return;
    setValue('items', [...spektrum.appState.items, { id: nextId++, name }]);
    refs.newItem.value = '';
  }, { description: 'Append a named item to the basket', input: { type: 'object' } });

  defineFn('removeItem', (el) => {
    const id = Number(el.dataset.id);
    setValue('items', spektrum.appState.items.filter(i => i.id !== id));
  }, { description: 'Remove a basket item by id' });

  bindDOM(); run();
</script>
```

See [example/](../../../example/) for the full demo (counter + basket, persist, devtools, inspect, agent).

---

## Bindings reference

Every directive is wired at `bindDOM()` time. Each binder returns an unsubscribe; `bindDOM` collects them and returns a destroy fn for the whole tree.

### `{{expression}}` — text interpolation

In text nodes only. Auto-escaped. Full JS expression.

```html
<p>Hello, {{user.name.toUpperCase()}} — {{items.length}} items</p>
```

Gotcha: **text nodes only.** `<a href="{{u}}">` is literal text. Use `:href` instead.

### `:attr="expression"` — reactive attribute

Property write (not `setAttribute`). Re-runs when any referenced path changes.

```html
<button :disabled="loading" :class="{primary: active, danger: error}">Save</button>
<a :href="user.url">profile</a>
```

- `:class` accepts string (overwrites), array (joined), or object (toggles per key).
- URL-bearing attrs (`:href`, `:src`, `:action`, `:formaction`, `:background`, `:cite`, `:poster`, `:data`) rewrite `javascript:` schemes to `#`.

### `data-if="expression"` — show/hide

Truthy → shown; falsy → `display: none`. Children stay bound (Vue's `v-show`, not `v-if`).

### `data-each="path"` — list rendering ⚠️

Two authoring forms, both supported:

**Container form** — `data-each` on the parent; first element child is the template. **Opposite of Vue's `v-for`** and Alpine's `x-for`.

```html
<ul data-each="items"><li>{{item.name}}</li></ul>
```

**`<template>` form** (HTML5-spec-aligned) — `data-each` on a `<template>`; clones go into its **parent**, anchored before the `<template>` tag.

```html
<ul>
  <li class="hdr">Header</li>
  <template data-each="items"><li>{{item.name}}</li></template>
  <li class="ftr">Footer</li>
</ul>
```

Use the `<template>` form when:
- **Binding rows inside `<table>` / `<thead>` / `<tbody>` / `<select>`** — the HTML parser injects wrappers and rejects unexpected children, which breaks the container form. `<template>` content is parsed in a detached context.
- **You want zero pre-bind flicker** — the browser never renders `<template>` content.
- **The list lives alongside fixed siblings** — `<thead>` / `<tfoot>` / a static header row.

Both forms support the same modes (`data-key`, `data-as`, `data-stable-key`) and warn the same way (e.g. *"needs an element child to clone"* if the template is empty).

Three reconciliation modes:

| Mode | Markup | Behavior |
|---|---|---|
| No-key (default) | `data-each="items"` | Append/remove via prefix-match for push/pop optimization; interior change rebuilds the list. Loses focus/selection on moved items. |
| Keyed | `data-each="items" data-key="item.id"` | Items at same `(key, index)` keep DOM. Moved items get fresh clones (paths are re-baked). |
| Keyed + stable | `data-each="items" data-key="item.id" data-stable-key` | Same clone reused across reorder. Skips path rewriting — the row must NOT reference `varName.*` paths (warns at bind time if it does). Reorder is genuinely free. |

`data-as="row"` renames the loop var (default `item`). Short/common names (`t`, `index`, `key`, `value`, `name`, `el`, `fn`, `id`, `data`) warn — they rewrite unrelated text/attrs via the regex-based `rewriteScope`. **`data-each` takes a dotted path, not an expression.** Use `computed()` for derived arrays.

### `data-model="path[.modifier]*"` — two-way input binding

State → element via `.value` / `.checked`; element → state on `input` / `change` via `setValue`.

```html
<input data-model="user.email">
<input type="checkbox" data-model="user.active">
<input data-model="query.trim.lazy">
```

Modifiers (Vue-style, trailing, dot-separated, chainable):
- `.lazy` — commit on `change` instead of `input`
- `.number` — coerce via `parseFloat` (NaN → original string)
- `.trim` — trim whitespace before write

If your state has a leaf literally named `lazy`/`number`/`trim`, route through `data-action="input"` + `data-fn="setValue"` instead.

### `data-action="event[.mod]*"` + `data-fn`

DOM event dispatch into a registered handler. Modifiers chain.

```html
<button data-action="click.prevent" data-fn="submit">Save</button>
<input data-action="keydown.shift.enter" data-fn="send">
```

Behavior modifiers: `.prevent` / `.stop` / `.once` / `.self` (only when `event.target` is the bound element).
Listener options: `.capture` / `.passive`.
Key gates: `.enter` / `.esc` / `.tab` (key match), `.shift` / `.cmd` (system modifiers — `cmd` maps to `metaKey`).

Handler signature: `(el, state, delta, value, event?)`.

`data-action="cycle"` is the alternate form — subscription instead of DOM event. Requires `data-id` (the subscribed path). Fires when state at `data-id` changes.

`data-value` is read once at bind time (intentionally non-reactive). Reach into `state` from the handler for reactive values.

### `data-ref="name"`, `data-intent="verb.noun"`, `data-cloak`

- `data-ref="email"` → `spektrum.refs.email` is the element. Imperative handle, not domain state.
- `data-intent="basket.add"` → registered in `spektrum.intents`, findable via `findByIntent('basket.add')`. Pure marker — no behavior; siblings decide what it does. **The primary handle for agent UI lookup.**
- `data-cloak` → strip-on-bind. Pair with CSS `[data-cloak] { visibility: hidden; }` to hide pre-bind flash.

Built-in `data-fn` handlers: `trigger`, `setValue`, `setText`, `setStyle`, `toggle`. Register your own with `defineFn(name, fn, meta?)`.

See [docs/bindings.md](../../../docs/bindings.md) for the full directive spec.

---

## Public API reference

All exports come from `spektrum`. The default export is a singleton instance; `createSpektrum(opts)` returns an isolated one.

### State mutators

```js
setValue(path, value, id?)          // absolute write; id defaults to `set:<path>`
trigger(id, path, value)            // additive numeric (accumulates within a tick)
checkpoint(name?, metadata?)        // tagged history marker, no state effect
addAsync(path, asyncFn)             // sets {path}.loading/.error/.data; returns refetch fn
refresh(path)                       // re-run the addAsync registered under `path`
computed(path, deps, fn)            // derived state; writes to both appState AND delta
```

Gotchas:
- `trigger` is **additive numeric only.** Use `setValue` for absolute writes (most cases).
- Paths are dotted strings (`'user.email'`). No template-literal TS narrowing — paths are stringly-typed.
- Empty path is rejected with a warn (was a silent foot-gun pre-1.0).
- `computed` writes to both state and delta so mid-tick reads see fresh values. See [docs/trade-offs.md](../../../docs/trade-offs.md#computed-writes-into-the-delta-not-state).

### Reactivity

```js
addSystem(paths, fn)                // subscribe fn to one or more paths; returns unsub
watch                               // alias for addSystem (identical reference)
removeSystem(fn)                    // detach first system registered with fn
defineFn(name, fn, meta?)           // register handler callable from data-fn; meta surfaces in describe()
```

System fn signature: `(state, delta)`. The `delta` arg is empty by the time your system runs (cleared before fan-out) — read state, or know which path triggered you via the subscription.

`defineFn` `meta` shape: `{ description, input, output, examples }`. Surfaces in `describe().fns` and the MCP catalog.

### Lifecycle

```js
bindDOM(root?)                      // scan + wire reactive bindings; returns destroy fn
run()                               // rAF-driven tick pump
tick()                              // synchronous: drain delta to quiescence
reset()                             // wipe state + history + systems; warns if active systems
resetState()                        // like reset() but preserves systems, fns, hooks
precompile(source, compiledFn)      // register precompiled expression (CSP-safe path)
createSpektrum(opts?)               // isolated instance: { historyLimit, snapshotEvery, forkLimit }
```

`bindDOM` is idempotent — calling on the same root twice is a no-op until `destroy()` runs.

### History / time-travel

```js
replay(n)                           // reset + re-apply first n entries; idempotent
serialize(opts?)                    // JSON string: { state, history, cursor }
                                    // opts: { includeHistory: false } state-only
                                    //       { includeForks: true }   include discarded tails
```

Drive step-back undo from `spektrum.cursor` (the live position), not `history.length`. Replay below `historyLimit`'s surviving window is undefined.

### Agent surface

```js
describe()                          // manifest: state, systems, fns, intents, checkpoints, history shape
explain(opts?)                      // history slice annotated with current subscriber sets
attempt(name, fn)                   // speculative; returns { result, commit(), discard() }
findByIntent(name)                  // copy of [...elements] carrying data-intent="name"
```

`explain().triggers` reflects the **current** subscriber registry, not historical record (the engine doesn't preserve who actually fired). For recent agent edits, the two coincide.

### Hooks

```js
onError((err, systemFn) => …)       // multi-subscriber; err.code === 'E_TICK_OVERFLOW' for engine errors
onRecord((entry) => …)              // every recorded mutation; does NOT fire during replay()
onFork((fork) => …)                 // when mutating while scrubbed back drops a tail
```

All hooks are multi-subscriber and return an unsubscribe handle. Pass `null` to clear all subscribers on a hook.

### Instance state (read-only references)

```js
appState         // live committed state (mutable, but go through setValue)
appStateDelta    // pending writes
history          // recorded entries
snapshots        // [{ index, state }] for O(K) replay
forks            // [{ entries, forkedAt, ts }] from mutate-while-scrubbed-back
refs             // { name: Element } from data-ref
intents          // { 'verb.noun': [Element] } from data-intent
spektrum.cursor          // current history position (getter)
spektrum.replaying       // true while replay() is in flight (getter)
spektrum.checkpoints     // filtered view of history (getter)
```

See [docs/api.md](../../../docs/api.md) and [spektrum.d.ts](../../../spektrum.d.ts) for canonical signatures.

---

## Agent workflow — orient / speculate / explain / commit

This is *why* Spektrum exists for an LLM reader. The engine is built so an agent can drive it like a first-class user: read everything in one call, try things speculatively, roll back on failure, leave a clean audit trail.

### 1. Orient — `describe()`

Single best first call. Returns a complete manifest in one cheap read.

```js
const m = spektrum.describe();
// {
//   state, cursor, historyLength, forkCount, snapshotCount, options,
//   systems:     [{ paths, name }, …],
//   fns:         [{ name, description, input, output, examples }, …],
//   refs:        ['email', 'newItem', …],
//   intents:     { 'basket.add': 4, 'basket.remove': 3, … },
//   checkpoints: [{ id, index }, …],
// }
```

From one call you know: the state shape, the verbs you can call (`fns`), the UI verbs the app exposes (`intents`), and the history shape.

### 2. Locate UI — `findByIntent(name)`

Selector-based UI lookup is brittle when an LLM is synthesizing it. `data-intent` is the semantic alternative.

```js
spektrum.findByIntent('basket.add')   // → [HTMLButtonElement, …]
spektrum.findByIntent('counter.undo') // → [HTMLButtonElement]
spektrum.findByIntent('nope')         // → []
```

To **trigger** an intent: don't synthesize click events — call the underlying mutator (`setValue` / `trigger`) directly. UI events are cosmetic; state is the source of truth.

### 3. Speculate — `attempt(name, fn)`

Run a branch you can commit or roll back. Drops a checkpoint, runs `fn`, returns a handle.

```js
const h = spektrum.attempt('apply-discount', () => {
  spektrum.setValue('cart.discount', 0.15);
  return computeFinalTotal();        // sync or async — caller awaits
});

if (await validate(h.result)) h.commit();   // records :commit checkpoint
else                          h.discard();  // replays back; entries go to `forks`
```

Nesting is safe. Discarded branches survive on `forks` (capped by `forkLimit`, default 50). `discard()` rewinds **engine state**; completed side effects (console, sent network) are not undone, but `fn` receives an `AbortSignal` (also `h.signal`) that `discard()` aborts — wire it into fetches/timers to cancel in-flight work: `attempt('edit', (signal) => fetch(url, { signal }))`.

### 4. Explain — `explain(opts?)`

Causal trace over a history slice. Each entry is annotated with the systems whose subscriptions intersect its path.

```js
const trace = spektrum.explain({ from: cursorBefore });
// [{ op, path, value, id, triggers: ['renderList', 'updateTotal'], index }, …]
```

Useful for an agent reconstructing why state moved between two cursors. Note: subscriber set is **current** registry, not historical.

### 5. Mutate — `setValue` / `trigger` / `checkpoint`

```js
spektrum.setValue('user.email', 'alice@example.com');    // absolute
spektrum.setValue('cart.items', [...]);                  // overwrites whole value
spektrum.trigger('inc', 'count', 1);                     // additive numeric
spektrum.checkpoint('after-edit', { actor: 'agent-1' }); // tagged marker
```

Prefer `setValue` over `trigger` unless the user asks for an additive change. Every call records into `history`. The next `tick()` (or `requestAnimationFrame` if `run()` is active) drains the delta.

See [AGENTS.md](../../../AGENTS.md) for the full tutorial including end-to-end recipes against the basket demo.

---

## Authoring agent-ready apps

Three small additions make an app maximally agent-driveable:

### 1. `data-intent` on interactive elements

Stable across DOM renames and refactors. The semantic locator agents use instead of selectors.

```html
<button data-action="click" data-fn="addItem" data-intent="basket.add">+</button>
<button data-action="click" data-fn="checkout" data-intent="checkout.submit">Pay</button>
```

`describe().intents` returns the catalog (`{ 'verb.noun': count }`). `findByIntent('verb.noun')` returns the elements.

### 2. `defineFn` metadata

Declare what a fn does and what it accepts. Surfaces in `describe().fns` and the MCP tool catalog.

```js
defineFn('addItem', handler, {
  description: 'Append a named item to the basket',
  input: { type: 'object', properties: { name: { type: 'string' } } },
  output: { type: 'object' },
  examples: [{ input: { name: 'apple' }, note: 'most common case' }],
});
```

### 3. Expose the instance

For MCP-based agents:
```js
import { createTools } from 'spektrum/mcp';
// Writes are denied by default (read-only). Pass protectedPaths to
// allow all but those, or allowAllPaths:true to allow everything.
const tools = createTools(spektrum, { protectedPaths: ['llm.apiKey'] });
// hand `tools[].handler` to your MCP server SDK
```

For in-page agents:
```js
window.spektrum = spektrum;   // or use the spektrum/agent companion
```

Optional polish: name your systems and fns (`name`-attributed fns are easier to read in traces), drop `checkpoint(name)` at logical boundaries, set `snapshotEvery` for cheap replay, and subscribe `onRecord` for a supervisor feed.

See [AGENTS.md#author-checklist](../../../AGENTS.md) for the full version.

---

## Companions

Opt-in subpath modules. Pull in only what you need; nothing leaks into the core bundle.

| Subpath | Purpose | When to add |
|---|---|---|
| `spektrum/devtools` | Floating scrubber panel — rewind, replay, watch state move (~3.2 KB / 1.6 KB gz) | Dev-time time-travel UI |
| `spektrum/persist` | `saveHistory` / `loadHistory` / `autoSave` over Web Storage (~1 KB / 0.5 KB gz) | Survive page reloads |
| `spektrum/compile` | Build-time scanner — emits `precompile()` module for strict-CSP deployments | Strict CSP (no `unsafe-eval`) |
| `spektrum/mcp` | SDK-agnostic MCP tool catalog from the agent surface (~5 KB / 2 KB gz) | Wire to Claude Desktop / Cursor / your own MCP server |
| `spektrum/agent` | In-page LLM panel (Anthropic / OpenAI / OpenRouter), drives via the tool catalog (~12 KB / 4.8 KB gz) | Dev / internal — ship your own backend for production |
| `spektrum/inspect` | Hover-to-inspect element bindings, mutation tracer, static lint (~10 KB / 4 KB gz) | Dev-time DX panel |
| `spektrum/dock` | Shared container hosting the dev companions as tabs (~5 KB / 2 KB gz) | When you mount multiple dev companions and want one UI |

See [docs/modules.md](../../../docs/modules.md) for the per-companion API.

---

## Critical gotchas

- **`data-each` has two forms.** Container form: `data-each` on the parent, first element child is the template (opposite of Vue's `v-for`). `<template>` form: `data-each` on a `<template>`, clones go into its parent. Use the `<template>` form inside `<table>` / `<select>` / `<thead>` — the HTML parser would otherwise re-parent a container-form child and silently mis-bind. See [docs/bindings.md#data-each---two-forms](../../../docs/bindings.md).

- **`trigger` is additive numeric only.** Use `setValue` for absolute writes (most cases). `trigger('inc', 'count', 1)` accumulates within a tick — useful for batched counter ops, almost never what you want for arbitrary state.

- **Paths are stringly-typed.** `setValue('users.0.email', …)` has no TS narrowing into the state shape. The engine's `with(state)` expression engine precludes template-literal type inference. Watch for typos.

- **`with(state)` + `new Function` are the eval path.** Same trust model as Vue and Alpine: templates are author-written. Don't compile templates from untrusted input. For strict-CSP deployments, run `spektrum/compile` at build time so `new Function` is never reached at runtime. See [docs/csp.md](../../../docs/csp.md).

- **`rewriteScope` is regex string-replace, not a tokenizer.** Inside a `data-each` template, the rewriter rewrites both code positions and string literals. `{{ "user.name" }}` becomes `"users.0.name"` per row. Write expressions that return values, not strings that mention bound paths. Short `data-as` names rewrite unrelated text — the engine warns.

- **`computed` writes to both state and delta.** Mid-tick reads of a computed value see the fresh result. After `tick()` returns, both reads agree. Same wrinkle for `addAsync`: the sync portion of its fn body (before the first `await`) sees pre-tick state. Call `spektrum.tick()` between a write and an `addAsync` if the fn body needs the just-written value.

- **`data-model` modifiers are reserved suffixes.** `.lazy` / `.number` / `.trim` are stripped from the right of the path string. If your state has a leaf literally named `lazy` / `number` / `trim`, route through `data-action="input"` + `data-fn="setValue"` to bypass parsing.

- **`{{...}}` is text-node only.** Mustache runs on text nodes; it does NOT process attribute values. For reactive attributes, use `:attr="expression"`. `<a href="{{u}}">` is literal text — use `<a :href="u">`.

- **`data-action` `data-value` is non-reactive.** Read once at bind time. For reactive values inside a handler, read from the `state` arg.

- **`appState` is a live mutable reference** — go through `setValue` so changes land in history. Direct mutation skips history, doesn't fire systems, and breaks replay.

See [docs/trade-offs.md](../../../docs/trade-offs.md) for the deliberate-compromises list with full rationale.

---

## Debugging recipes

### "My binding isn't updating"

1. Confirm the system fired: `spektrum.onRecord(e => console.log(e))` before the mutation.
2. Check the subscription path. `addSystem(['user.name'], …)` does NOT fire for `setValue('user', {name: 'x'})` — top-key filter matches `'user'`, but the path check requires `user.name` in delta. Use `addSystem(['user'], …)` for whole-object writes.
3. Confirm `tick()` is running. If you're not calling `run()` and not in a `data-action` event handler, you must call `tick()` yourself.
4. For `{{expr}}` interpolation: the path must be referenced literally — `{{state[k]}}` uses dynamic indexing and won't subscribe to a fixed path.

### "Event fires twice"

1. You bound the same root twice without `destroy()` in between — `bindDOM(root)` is idempotent, but re-binding after detach without calling the returned destroy fn double-wires.
2. Bubbling: `data-action="click"` on a parent fires for child clicks too. Add `.self` if you only want clicks on the bound element itself.
3. Add `.once` if the handler is one-shot.

### "Scrub broke state"

1. Confirm `replay()` isn't being called from inside a system (it'd loop). Call from the host or a fn handler.
2. `historyLimit` trimmed entries below the surviving window — replay to an index below the window is undefined. Either drop `historyLimit` or only replay within the live range.
3. Mutate-while-scrubbed-back drops the tail. Check `spektrum.forks` — your "missing" entries are there.

### "CSP error in production: `unsafe-eval`"

1. The runtime hit `new Function`. Run `spektrum/compile` at build time:
   ```js
   import { extractExpressions, emitPrecompileSource } from 'spektrum/compile';
   const exprs = extractExpressions(htmlString);
   const moduleSource = emitPrecompileSource(exprs);
   // Write moduleSource to disk; import it before bindDOM().
   ```
2. The emitted module uses `with(state)` (a language feature, not eval) so it passes CSP. See [docs/csp.md](../../../docs/csp.md).

For mutation visibility while debugging, mount `spektrum/inspect` (hover-to-see-bindings + mutation tracer) and `spektrum/devtools` (scrubber). See [docs/time-travel.md](../../../docs/time-travel.md) for the time-travel primitives in depth.

---

## Pointers — read these for depth

- [AGENTS.md](../../../AGENTS.md) — Full agent workflow tutorial with basket-demo recipes. Read when driving a Spektrum app as an LLM.
- [docs/api.md](../../../docs/api.md) — Every export with examples. Read for the canonical signature of any API symbol.
- [docs/bindings.md](../../../docs/bindings.md) — Directive details, modifier parsing, URL safety, `data-cloak`. Read when writing or reviewing markup.
- [docs/time-travel.md](../../../docs/time-travel.md) — Snapshots, `historyLimit`, `forks`, devtools panel. Read when building undo/replay/scrub features.
- [docs/csp.md](../../../docs/csp.md) — `spektrum/compile` workflow. Read for strict-CSP deployments.
- [docs/modules.md](../../../docs/modules.md) — Per-companion API and wiring. Read when adding `persist`, `mcp`, `agent`, `inspect`, or `dock`.
- [docs/trade-offs.md](../../../docs/trade-offs.md) — Deliberate compromises with rationale. Read when something surprising happens.
- [docs/constraints.md](../../../docs/constraints.md) — Non-negotiables that gate every feature. Read before proposing engine changes.
- [docs/philosophy.md](../../../docs/philosophy.md) — Vision and non-goals. Read to know what Spektrum will never do.
- [spektrum.js](../../../spektrum.js) — The engine. 1077 lines, single file. Read end-to-end when you need ground truth.
- [spektrum.d.ts](../../../spektrum.d.ts) — TypeScript declarations. Read for typed signatures.
- [example/](../../../example/) — Reference app: counter + basket, two isolated instances, every directive in use.

---
name: spektrum
description: Build, review, or debug apps using the Spektrum reactive engine (single-file, time-travel-native, agent-driveable). Covers data-* bindings and per-row scope, the public API (setValue/addValue, computed, addAsync), the orient/speculate/explain/commit agent workflow, and authoring agent-ready apps. Use when working in a repo that imports `spektrum` or uses `data-action` / `data-each` / `describe()` / `attempt()`.
---

# Spektrum

A tiny reactive engine — single file, ~1,430 lines, ~13 kB minified / ~6 kB gzipped, zero runtime dependencies. State lives in `appState`, mutations write into `appStateDelta`, each `tick()` drains the delta and fires subscribed systems. Every mutation is recorded in `history` so `replay(n)` rebuilds any past state. Declarative HTML directives (`{{expr}}`, `:attr`, `data-if`, `data-each`, `data-model`, `data-action`, `data-ref`, `data-intent`) wire reactive nodes at `bindDOM()` time.

## When to use this skill

- The repo imports `spektrum`, has a `spektrum.js` file, or uses any companion (`spektrum/devtools`, `spektrum/persist`, `spektrum/mcp`, `spektrum/agent`, etc.).
- The user asks "how do I do X in Spektrum?" or references `describe()`, `attempt()`, `data-action`, `data-each`, `setValue`, or any directive.
- You are an agent driving a running Spektrum app (orient → speculate → explain → commit).
- You are reviewing markup or JS for a Spektrum project.

If the project uses Vue / React / Svelte / Alpine / SolidJS, this skill does **not** apply — those have separate idioms and APIs.

## How this documentation is layered

This file holds the mental model, the current idioms, and the gotchas — enough to write correct code. Canonical detail lives one level down and is **worth loading only when the task touches it** (see [Pointers](#pointers--read-these-for-depth)): [docs/api.md](../../../docs/api.md) for exact signatures, [docs/bindings.md](../../../docs/bindings.md) for the full directive spec, [spektrum.js](../../../spektrum.js) for ground truth. When any layer disagrees with the source, the source is right.

---

## Mental model in 60 seconds

**State + delta + tick.** All mutations land in `appStateDelta` first. `tick()` drains the delta to quiescence: systems whose subscribed paths intersect the delta run; the delta merges into `appState` and is cleared; writes during a system's run kick off another pass. The 1024-iteration cap catches feedback loops. Nothing ticks automatically — call `run()` once (rAF-driven pump) or call `tick()` yourself after mutating.

**Every mutation is recorded.** `setValue` / `addValue` / `checkpoint` push entries into `history`. `replay(n)` clears state and re-applies the first `n` entries. With `snapshotEvery: K`, replay is O(K) instead of O(n). When you mutate while scrubbed back, the dropped tail is preserved on `forks`.

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
  → fn(signal) runs against a checkpointed cursor
  → handle.commit()  records a :commit checkpoint
  → handle.discard() replays back to the checkpoint and aborts the signal
                     (discarded entries land on forks on next mutation)
```

See [spektrum.js](../../../spektrum.js) for the implementation, [docs/philosophy.md](../../../docs/philosophy.md) for the design rationale.

---

## Complete working example

A reactive basket with keyed reconciliation, per-row scope, semantic intents, and fn metadata for agent introspection.

```html
<!DOCTYPE html>
<script type="importmap">
{ "imports": { "spektrum": "https://unpkg.com/spektrum" } }
</script>

<input data-ref="newItem" placeholder="What to buy?">
<button data-action="click" data-fn="addItem" data-intent="basket.add">add</button>
<p>{{items.length}} items</p>

<!-- Container form: data-each marks the PARENT; the first element child
     is the template, cloned per row. data-key keeps DOM identity across
     reorder. Inside the loop, `item` (rename via data-as), `$index`,
     `$first`, `$last`, and `$path` are real scope variables. -->
<ul data-each="items" data-key="item.id">
  <li>
    <!-- data-model resolves through scope: this writes items.<i>.done -->
    <input type="checkbox" data-model="item.done">
    {{$index + 1}}. {{item.name}}
    <!-- Custom handlers receive the row scope as their 6th argument -->
    <button data-action="click" data-fn="removeItem" data-intent="basket.remove">×</button>
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
    setValue('items', [...spektrum.appState.items, { id: nextId++, name, done: false }]);
    refs.newItem.value = '';
  }, { description: 'Append a named item to the basket', input: { type: 'object' } });

  defineFn('removeItem', (el, state, _d, _v, _e, scope) => {
    setValue('items', state.items.filter(i => i !== scope.item));
  }, { description: 'Remove the row the clicked button belongs to' });

  bindDOM(); run();
</script>
```

For an additive counter, the built-in handler is one attribute set — note `data-fn="addValue"`, not the deprecated `trigger`:

```html
<p>{{count}}</p>
<button data-action="click" data-fn="addValue" data-id="count" data-value="1" data-name="inc">+1</button>
```

See [example/](../../../example/) for the full demo (counter + basket, persist, devtools, inspect, agent).

---

## Bindings — summary

Full spec with every modifier and edge: [docs/bindings.md](../../../docs/bindings.md).

| Directive | What it does | Sharpest edge |
|---|---|---|
| `{{expr}}` | Interpolated text, auto-escaped, full JS expression | **Text nodes only** — never attribute values; use `:attr` there. Bare `<`/`>` can split the text node; use `&gt;` or move the comparison into `:attr`. |
| `:attr="expr"` | Reactive property write (`:class` accepts string/array/object; hyphenated names go via `setAttribute`) | URL-bearing attrs (`:href`, `:src`, …) rewrite `javascript:` to `#`. `:innerHTML` carries the template trust model — never bind untrusted strings. |
| `data-if="expr"` | Truthy → shown, falsy → `display: none` | Vue `v-show` semantics — children stay bound; nothing unmounts. |
| `data-each="path"` | Clone a template per array item. Container form (directive on the parent, first element child is the template) or `<template>` form (clones inserted before the `<template>` anchor) | Takes a **dotted path, not an expression** — use `computed()` for derived arrays. Use the `<template>` form inside `<table>` / `<select>` / `<thead>`. |
| `data-key="expr"` | Keyed reconciliation; rows keep DOM, focus, and input state across reorder | Reuse-on-reorder is always on; `data-stable-key` is an accepted no-op. Duplicate keys warn and mis-render. |
| Scope vars | Inside a loop: the loop variable (`item` or `data-as` name), `$index`, `$first`, `$last`, `$path` (the row's state path, e.g. `items.3`) | Real lexical scope — the loop variable shadows a same-named state key by design. `$…` names are reserved. |
| `data-model="path[.mod]*"` | Two-way input binding (`.lazy` / `.number` / `.trim`, chainable) | Modifier names are reserved path suffixes. Inside a loop, `data-model="item.field"` resolves to the row's path. |
| `data-action="event[.mod]*"` + `data-fn` | Event dispatch into a registered handler. Modifiers: `.prevent` `.stop` `.once` `.self` `.capture` `.passive` `.enter` `.esc` `.tab` `.shift` `.cmd` | `data-value` is read **once at bind time** (non-reactive) — read live values from the handler's `state` arg. `data-action="cycle"` subscribes to the `data-id` path instead of a DOM event. |
| `data-ref="name"` | Element handle on `spektrum.refs.name` | Imperative escape hatch, not domain state. |
| `data-intent="verb.noun"` | Semantic marker registered in `spektrum.intents`, findable via `findByIntent()` | Pure marker — siblings decide behavior. **The primary handle for agent UI lookup.** |
| `data-cloak` | Stripped on bind; pair with `[data-cloak]{visibility:hidden}` CSS | Prevents pre-bind `{{…}}` flash. |

Built-in `data-fn` handlers: `setValue`, `addValue` (alias: `trigger`), `setText`, `setStyle`, `toggle`. Handler signature: `(el, state, delta, value, event?, scope?)` — inside a `data-each`, built-ins resolve `data-id="item.field"` through scope to the row's real path, and custom handlers can read `scope.item` / `scope.$index` / `scope.$path` directly.

---

## Public API — summary

Exact signatures and examples: [docs/api.md](../../../docs/api.md) and [spektrum.d.ts](../../../spektrum.d.ts). The default export is a singleton instance; `createSpektrum({ historyLimit, snapshotEvery, forkLimit })` returns an isolated one.

```js
// Mutators — the only two write primitives (both record into history)
setValue(path, value, id?)     // absolute write; id defaults to `set:<path>`
addValue(path, value, id?)     // additive numeric, accumulates within a tick; id defaults to `add:<path>`
trigger(id, path, value)       // DEPRECATED alias of addValue (pre-1.0 argument order)
checkpoint(name?, metadata?)   // tagged history marker, no state effect

// Derived + async
computed(path, deps, fn)       // derived state; throws E_COMPUTED_SELF_DEP on overlapping deps
addAsync(path, asyncFn)        // sets {path}.loading/.error/.data; returns refetch fn
refresh(path)                  // re-run the addAsync registered under `path`

// Reactivity
addSystem(paths, fn)           // subscribe fn(state, delta) to paths; returns unsub
watch                          // alias of addSystem (identical reference)
removeSystem(fn)               // detach first system registered with fn
defineFn(name, fn, meta?)      // register a data-fn handler; meta surfaces in describe()

// Lifecycle
bindDOM(root?)                 // wire bindings; idempotent per root; returns destroy fn
run()                          // rAF-driven tick pump
tick()                         // synchronous: drain delta to quiescence
reset() / resetState()         // wipe state+history (+systems for reset())
precompile(source, fn)         // register a precompiled (state, scope) expression — the strict-CSP path

// Time-travel
replay(n)                      // reset + re-apply first n entries; idempotent
serialize(opts?)               // JSON string { state, history, cursor }; opts: includeHistory, includeForks

// Agent surface
describe()                     // manifest: state, systems, fns, refs, intents, checkpoints, history shape
explain(opts?)                 // history slice annotated with CURRENT subscriber sets
attempt(name, fn)              // speculative; returns { result, signal, commit(), discard() }
findByIntent(name)             // elements carrying data-intent="name" (copy)

// Hooks (multi-subscriber; each returns an unsubscribe; pass null to clear all)
onError(fn)                    // engine errors carry err.code (e.g. E_TICK_OVERFLOW)
onRecord(fn)                   // every recorded mutation; does NOT fire during replay()
onFork(fn)                     // a mutate-while-scrubbed-back dropped a tail

// Instance state (read via these references; write ONLY through mutators)
appState, appStateDelta, history, snapshots, forks, refs, intents
spektrum.cursor / .replaying / .checkpoints   // getters
```

Drive step-back undo from `spektrum.cursor` (the live position), not `history.length`. Replay below `historyLimit`'s surviving window is undefined.

---

## Agent workflow — orient / speculate / explain / commit

This is *why* Spektrum exists for an LLM reader. Full tutorial with recipes: [AGENTS.md](../../../AGENTS.md).

**1. Orient — `describe()`.** The single best first call: one cheap read returns state shape, callable verbs (`fns` with schemas), UI verbs (`intents`), systems, refs, checkpoints, and history shape.

**2. Locate UI — `findByIntent('basket.add')`.** Semantic lookup instead of brittle selectors. To act, don't synthesize clicks — call the underlying mutator; UI events are cosmetic, state is the source of truth.

**3. Speculate — `attempt(name, fn)`.**

```js
const h = spektrum.attempt('apply-discount', (signal) => {
  spektrum.setValue('cart.discount', 0.15);
  return computeFinalTotal();          // sync or async — caller awaits
});
if (await validate(h.result)) h.commit();   // records :commit checkpoint
else                          h.discard();  // replays back; entries go to `forks`
```

Nesting is safe; handles are single-shot. `discard()` rewinds **engine state** only — completed side effects stay done, but `fn` receives an `AbortSignal` (also `h.signal`) that `discard()` aborts, so wire it into fetches/timers to cancel in-flight work.

**4. Explain — `explain({ from: cursorBefore })`.** History slice where each entry lists the systems whose subscriptions intersect its path. Reflects the **current** registry, not a historical record.

**5. Mutate — `setValue` / `addValue` / `checkpoint`.** Prefer `setValue` (absolute) unless the change is genuinely additive. Every call records into history; the next `tick()` (or animation frame if `run()` is active) drains the delta.

### Authoring agent-ready apps

Three additions, detailed in [AGENTS.md](../../../AGENTS.md#author-checklist--make-your-app-agent-ready): put `data-intent="verb.noun"` on interactive elements, pass `{ description, input, output, examples }` metadata to `defineFn`, and expose the instance (`window.spektrum = spektrum` for in-page agents, or `createTools(spektrum, { protectedPaths: […] })` from `spektrum/mcp` — writes are **denied by default**; opt in via `protectedPaths` or `allowAllPaths`). Optional polish: name your systems/fns, `checkpoint()` at logical boundaries, set `snapshotEvery`, feed a supervisor via `onRecord`.

---

## Companions

Opt-in subpath modules; nothing leaks into the core bundle. Per-companion API: [docs/modules.md](../../../docs/modules.md).

| Subpath | Purpose |
|---|---|
| `spektrum/devtools` | Floating scrubber panel — rewind, replay, watch state move |
| `spektrum/persist` | `saveHistory` / `loadHistory` / `autoSave` over Web Storage |
| `spektrum/compile` | Build-time expression scanner → `precompile()` module for strict-CSP deploys |
| `spektrum/mcp` | SDK-agnostic MCP tool catalog over the agent surface |
| `spektrum/agent` | In-page LLM panel (Anthropic / OpenAI / OpenRouter) driving the tool catalog |
| `spektrum/inspect` | Hover-to-inspect bindings, mutation tracer, static lint |
| `spektrum/dock` | Shared tabbed container hosting the dev companions |

---

## Critical gotchas

The failure modes that actually bite — most come from carrying Vue/React/Alpine priors into a different engine.

- **`data-each` goes on the container, not the repeated element.** Container form: directive on the parent, first element child is the template — the opposite of `v-for` / `x-for`. `<template data-each="…">` form: clones insert before the `<template>` anchor. Inside `<table>` / `<select>` / `<thead>` the `<template>` form is required — the HTML parser re-parents stray children and silently mis-binds the container form.

- **`trigger` is not an event API — and it's deprecated.** It's the pre-1.0 spelling of `addValue` (additive numeric). Use `setValue` for absolute writes (most cases), `addValue(path, value)` for accumulation. There is no event bus.

- **`{{…}}` runs in text nodes only.** `<a href="{{u}}">` stays literal text. Reactive attributes are `:href="u"`. Inside attributes there is no mustache — for row-relative targets use scope-resolved paths (`data-id="item.field"`, `data-model="item.field"`).

- **Writing `undefined` does not fire subscribers.** `tick()` selects systems by whether a subscribed path *resolves* in the delta, so an `undefined` write merges silently and nothing re-renders. **Write `null` to clear a value.** See [docs/trade-offs.md](../../../docs/trade-offs.md).

- **Nothing ticks by itself.** Without `run()`, mutations sit in the delta until you call `tick()` — including after `data-action` handler calls in tests.

- **`appState` is a live mutable reference — never assign into it.** Direct mutation skips history, fires no systems, and breaks replay and snapshots. Go through `setValue` / `addValue`.

- **Paths are stringly-typed dotted strings.** `setValue('users.0.email', …)` gets no TS narrowing (deliberate — see [docs/api.md](../../../docs/api.md#typescript)). Watch for typos; the engine can't.

- **Loop scope shadows state by design.** `data-as="user"` shadows `state.user` inside the row (`with (state) with (scope)` — inner wins). `$index` / `$first` / `$last` / `$path` are reserved. Keyed rows always reuse their DOM node; the engine re-binds a row when its index changes **or** the object at its key is replaced (the immutable-update idiom re-renders correctly).

- **`computed` writes to both state and the delta.** Mid-tick reads see the fresh value; fan-out still works via the delta. But a plain `setValue` lives only in the delta until `tick()` — so call `tick()` between a write and an `addAsync` whose sync body needs the just-written value. `computed` throws `E_COMPUTED_SELF_DEP` if a dep overlaps its own output path.

- **`data-model` modifiers are reserved suffixes.** `.lazy` / `.number` / `.trim` strip from the right of the path. A state leaf literally named `lazy` / `number` / `trim` needs `data-action="input"` + `data-fn="setValue"` instead.

- **`data-value` is non-reactive.** Read once at bind time; falls back to the element's own `.value` at dispatch when absent. Read live state from the handler's `state` argument.

- **Templates are author-written code** (`with(state)` inside `new Function` — the Vue/Alpine trust model). Never compile templates from untrusted input; never bind untrusted strings through `:innerHTML` / `:srcdoc`. For strict CSP, run `spektrum/compile` at build time. See [docs/security-model.md](../../../docs/security-model.md) and [docs/csp.md](../../../docs/csp.md).

---

## Debugging recipes

### "My binding isn't updating"

1. Did anything tick? Without `run()`, call `tick()` after mutating.
2. Did you write `undefined`? Subscribers don't fire for it — write `null` to clear.
3. Confirm the mutation recorded: `spektrum.onRecord(e => console.log(e))` before mutating. Nothing logged → you assigned into `appState` directly.
4. Is the expression subscribable? `{{state[k]}}` uses dynamic indexing — extractable paths must be referenced literally (`{{user.name}}`).
5. Mustache in an attribute? `href="{{u}}"` never binds — use `:href="u"`.

### "My list renders nothing (or warns)"

1. *"needs an element child to clone"* — the directive is on the repeated element. Move it to the container (or a `<template>`).
2. *"resolved to object/null, expected Array"* — `data-each` takes a dotted path to an array, not an expression. Derive with `computed()` first.
3. Rows inside `<table>` / `<select>` need the `<template>` form.
4. *"duplicate key"* — keyed mode merges clones on key collisions; make `data-key` unique.

### "Event fires twice"

1. Re-bound the same root after detaching without calling the returned destroy fn — `bindDOM` is idempotent per live root, but stale listeners survive a detach.
2. Bubbling: `data-action="click"` on a parent fires for child clicks — add `.self`.
3. One-shot handlers want `.once`.

### "Scrub broke state"

1. Don't call `replay()` from inside a system (it loops). Call from the host or a handler.
2. `historyLimit` trimmed entries — replay below the surviving window is undefined.
3. Mutating while scrubbed back drops the tail onto `spektrum.forks` — your "missing" entries are there.

### "CSP error: `unsafe-eval`"

The runtime hit `new Function`. Precompile at build time with `spektrum/compile` (`extractExpressions` → `emitPrecompileSource` → import the emitted module before `bindDOM()`). Emitted functions are `(state, scope)` and CSP-safe. See [docs/csp.md](../../../docs/csp.md).

For mutation visibility while debugging, mount `spektrum/inspect` (hover-to-see-bindings + tracer) and `spektrum/devtools` (scrubber).

---

## Pointers — read these for depth

- [AGENTS.md](../../../AGENTS.md) — Agent workflow tutorial with recipes against the demo. Read when driving a Spektrum app as an LLM.
- [docs/api.md](../../../docs/api.md) — Every export with examples. Read for the canonical signature of any API symbol.
- [docs/bindings.md](../../../docs/bindings.md) — Full directive spec, modifier parsing, URL safety. Read when writing or reviewing markup.
- [docs/time-travel.md](../../../docs/time-travel.md) — Snapshots, `historyLimit`, `forks`, devtools. Read when building undo/replay/scrub features.
- [docs/csp.md](../../../docs/csp.md) — `spektrum/compile` workflow. Read for strict-CSP deployments.
- [docs/modules.md](../../../docs/modules.md) — Per-companion API and wiring. Read when adding any `spektrum/*` companion.
- [docs/security-model.md](../../../docs/security-model.md) — Trust boundaries. Read before mounting an agent or exposing MCP tools.
- [docs/trade-offs.md](../../../docs/trade-offs.md) — Deliberate compromises with rationale. Read when something surprising happens.
- [docs/constraints.md](../../../docs/constraints.md) — Non-negotiables gating every feature. Read before proposing engine changes.
- [docs/philosophy.md](../../../docs/philosophy.md) — Vision and non-goals. Read to know what Spektrum will never do.
- [spektrum.js](../../../spektrum.js) — The engine, one commented file. Read end-to-end when you need ground truth — it wins every disagreement.
- [spektrum.d.ts](../../../spektrum.d.ts) — TypeScript declarations. Read for typed signatures.
- [example/](../../../example/) — Reference app: counter + basket, two isolated instances, every directive in use.
- [llms.txt](../../../llms.txt) — One-page discovery map of everything above (also shipped in the npm package).

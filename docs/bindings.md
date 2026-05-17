# Declarative bindings

Spektrum's HTML directives. Author them in markup; the engine wires them up at `bindDOM()` time.

## Directive reference

| Form | Effect |
| --- | --- |
| `{{expression}}` in a text node | Interpolated text, auto-escaped. Full JS expression: `{{count + 1}}`, `{{user.name.toUpperCase()}}`. |
| `:attr="expression"` on any element | Property write. Object form on `:class` toggles named classes: `:class="{active: x, error: y}"`. |
| `data-if="expression"` | Show element when truthy, `display: none` when falsy. Children stay bound. |
| `data-each="path" data-as="name"` | Render the array at `path`, cloning a template per item. Two forms: container (`<ul data-each>…<li>` — directive on parent, first child is template) and `<template>` (directive on a `<template>` element; clones go into its parent before the `<template>` anchor — required inside `<table>` / `<select>`). The loop variable `name` (default `item`) is a lexical scope binding — not a text substitution — so it can't collide with state or other identifiers. |
| `data-each ... data-key="expr"` | Keyed reconciliation. Items keyed identically keep their DOM, listeners, focus, and uncommitted input state across reorder (the same clone is reused; bindings re-subscribe to the new index). Without a key, the no-key path appends/pops the tail and rebuilds on interior changes. |
| Scope variables inside `data-each` | The loop variable (`item` or whatever `data-as` declares), plus `$index`, `$first`, `$last`, `$path`. `$path` is the row's full state path as a string (useful for `data-id="{{$path}}.completed"`). `data-stable-key` is accepted as a no-op for back-compat — every keyed row reuses across reorder by default. |
| `data-model="path"` | Two-way binding for `<input>` / `<select>` / checkboxes. State → element via `:value`/`:checked`, element → state on `input`/`change` event. |
| `data-model="path.<modifiers>"` | Trailing dot-separated modifiers, chainable (Vue-style). `.lazy` commits on `change` instead of `input`; `.number` coerces via `parseFloat` (NaN → original string); `.trim` trims whitespace before write. Example: `data-model="query.trim.lazy"`. The names are reserved suffixes — see footnote below. |
| `data-ref="name"` | Expose the element on `instance.refs.name` for imperative access (`spektrum.refs.email.focus()`). |
| `data-intent="verb.noun"` | Semantic locator for agentic tooling. Element is registered into `instance.intents` and findable via `spektrum.findByIntent('verb.noun')`. Pure marker — no runtime behavior; siblings (`data-action`, `data-fn`, `data-model`) decide what it does. See [agent-native workflow](../AGENTS.md). |
| `data-action="cycle"` + `data-fn` + `data-id` | Subscribe a registered fn to a path. |
| `data-action="event[.modifier]*"` + `data-fn` | DOM-event dispatch. **Behavior:** `.prevent` / `.stop` / `.once` / `.self` (only when `event.target` is the bound element). **Listener options:** `.capture` / `.passive`. **Key gates:** `.enter` / `.esc` / `.tab` (key-match) and `.shift` / `.cmd` (system modifiers — Vue's `cmd` maps to `metaKey`). Chainable: `keydown.shift.enter` fires only on Shift+Enter. |

Built-in `data-fn` handlers: `trigger`, `setValue`, `setText`, `setStyle`, `toggle`. Register your own with `defineFn(name, handler)`. Handler signature: `(el, state, delta, value, event?)`. The `event` argument is the DOM `Event` for `data-action="click"`-style bindings, or `undefined` for `data-action="cycle"` (subscription-driven, no event in scope).

### `data-each` — two forms

`data-each` supports two authoring forms. Pick whichever fits the surrounding markup.

**Container form** (legacy). `data-each` marks the **container**; its *first element child* is the template. Opposite of Vue's `v-for` and Alpine's `x-for`, which attach the directive to the element being repeated.

```html
<!-- ❌ wrong: <li> is the container; its first element child is absent -->
<li data-each="items">{{item}}</li>           <!-- nothing renders; warns -->

<!-- ✅ right: <ul> is the container, <li> is the template -->
<ul data-each="items">
  <li>{{item}}</li>
</ul>
```

**`<template>` form** (HTML5-spec-aligned). `data-each` lives on a `<template>` element; its `.content`'s first element child is the template. Clones go into the `<template>`'s **parent**, anchored before the `<template>` tag — so siblings (`<thead>`, `<tfoot>`, fixed rows, etc.) stay put.

```html
<ul>
  <li class="hdr">Header</li>
  <template data-each="items"><li>{{item}}</li></template>
  <li class="ftr">Footer</li>
</ul>
```

Use this form when:

- **You're binding rows inside `<table>` / `<thead>` / `<tbody>` / `<select>`**. The HTML parser injects elements (e.g. `<tbody>` inside `<table>`) and rejects unexpected children — the container form silently mis-binds because `firstElementChild` ends up being the injected wrapper, not your row template. `<template>` content is parsed in a detached context that doesn't suffer this.
- **You need zero pre-bind flicker.** The browser never renders `<template>` content, so the template row is invisible until `bindDOM()` runs. (`data-cloak` is not needed.)
- **You want spec-aligned markup.** `<template>` is HTML5's defined element for "markup-as-data" — accessibility tools, linters, and screen readers already know to skip its contents.

Both forms support the same modes (`data-key`, `data-as`) and reconciliation behavior. Mixing forms in the same root is fine.

`data-each` takes a **dotted path**, not an expression — unlike `data-if` and `:attr`, which evaluate full JS. For derived arrays, build a `computed` and bind that:

```js
computed('visible', ['items', 'filter'],
  state => state.items.filter(i => i.kind === state.filter));
```

```html
<ul data-each="visible"><li>{{item.name}}</li></ul>
```

If the path resolves to a non-array value (other than `undefined`, which is normal pre-population), the engine warns at tick time.

### `data-as` naming

`data-as` declares a real lexical scope binding inside the iteration — `with (state) with (scope)` puts it on the inner with-block, so it shadows same-named state keys for the duration of the row's bindings. Pick any name that reads well (`row`, `chip`, `node`, `user`, `t`). No length, character, or collision restrictions; the scope is per-iteration only and never touches outer state.

`$index`, `$first`, `$last`, `$path` are reserved scope variables and shouldn't be used as `data-as` names.

### `{{…}}` is text-node only

Mustache interpolation is wired up by `bindText`; it runs on text nodes only, **not** on attribute values. For reactive attributes, use `:attr="expression"`:

```html
<!-- ❌ wrong: href is literal text "{{user.url}}" -->
<a href="{{user.url}}">profile</a>

<!-- ✅ right: :href evaluates the expression reactively -->
<a :href="user.url">profile</a>
```

For `data-action`'s `data-value`, the value is read **once at bind time** and is intentionally non-reactive — `data-action` is dispatch metadata, not a reactive binding. Reach into state from the handler instead:

```js
defineFn('inc', (el, state) => setValue('count', state.count + 1));
```

### Handler `state` argument

The `state` arg passed to a `defineFn` handler differs by action type:

| Action type | `state` arg is… |
| --- | --- |
| `data-action="event"` (click, keydown, …) | **live** — `appState` reference, mutated in place |
| `data-action="cycle"` (subscription) | a **snapshot** passed by the system runner |

For event-based handlers, reads after `await` see fresh values (because `appState` is mutated, not replaced):

```js
defineFn('save', async (el, state) => {
  await api.put('/user', state.user);
  console.log(state.user.id);   // ALSO live — may have changed during the await
});
```

If you need a stable copy inside an async handler, capture before the first `await`:

```js
defineFn('save', async (el, state) => {
  const payload = { ...state.user };
  await api.put('/user', payload);
});
```

Async handler rejections are routed through `onError` (or `console.error` if no handler is registered); they don't disappear into unhandled-promise warnings.

### Derived state

Derived state via `computed(path, deps, fn)` — primes synchronously from current state on registration (so registering after deps are already populated, e.g. after `loadHistory`, lands the initial value on the next tick), then re-derives whenever any `deps` change. Writes to both state and the delta so mid-tick reads see fresh values (a sibling system reading `state.derived` in the same pass gets the just-computed value, not the prior one). Returns an unsubscribe handle.

### Async resources

`addAsync(path, fn)` sets `${path}.loading` / `${path}.error` / `${path}.data` as the Promise progresses. Each phase records through `setValue`, so the round-trip lands in history (replay re-applies the values; no actual fetch re-issues). **Returns a refetch handle**, and is also indexed by `path` so `refresh(path)` works without retaining the handle:

```js
import { addAsync, refresh } from 'spektrum';

const refetch = addAsync('user', () => fetch('/api/user').then(r => r.json()));
await refetch();          // re-run via the returned handle
await refresh('user');    // re-run via the keyed registry — same effect
```

Bind with `data-if="user.loading"`, `{{user.error}}`, `{{user.data.name}}`.

`watch(deps, fn)` is a public alias for `addSystem(deps, fn)` — same signature, conventional name.

**Footnote on `data-model` reserved suffixes.** Modifier names (`lazy`, `number`, `trim`) are stripped from the right of the path string. If your state genuinely has a leaf literally named `lazy`/`number`/`trim`, route through `data-action="input"` + `data-fn="setValue"` directly to bypass modifier parsing.

## URL-attribute safety

When `:href`, `:src`, `:action`, `:formaction`, `:background`, `:cite`, `:poster`, or `:data` evaluates to a string starting with `javascript:` (case-insensitive, leading whitespace ignored), Spektrum rewrites the value to `#`. This blocks the common XSS shape where an attacker-influenced value lands in an `<a :href>`. Other schemes (`https:`, `data:`, `mailto:`, etc.) pass through unchanged — review your own data sources if your threat model needs broader filtering.

**Not covered:** `:srcdoc` (the value is parsed as HTML, not as a URL — same trust requirement as templates; don't bind untrusted content). The guard runs on JavaScript property writes, so attributes Spektrum doesn't expose as DOM properties (e.g. SVG `xlink:href`) are out of scope.

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

## Related

- [Public API](api.md) — `bindDOM`, `defineFn`, `computed`, `addSystem`, etc.
- [Trade-offs](trade-offs.md) — `data-each` reorder behavior, `rewriteScope` literal handling, `with(state)` rationale
- [Agent-native workflow](../AGENTS.md) — `data-intent` + `findByIntent` in context

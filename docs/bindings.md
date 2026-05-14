# Declarative bindings

Spektrum's HTML directives. Author them in markup; the engine wires them up at `bindDOM()` time.

## Directive reference

| Form | Effect |
| --- | --- |
| `{{expression}}` in a text node | Interpolated text, auto-escaped. Full JS expression: `{{count + 1}}`, `{{user.name.toUpperCase()}}`. |
| `:attr="expression"` on any element | Property write. Object form on `:class` toggles named classes: `:class="{active: x, error: y}"`. |
| `data-if="expression"` | Show element when truthy, `display: none` when falsy. Children stay bound. |
| `data-each="path" data-as="name"` | Render the array at `path`, cloning the first child as a template per item. The path-rewriter is whole-word string replace — it rewrites both code positions and string literals (see [trade-offs](trade-offs.md#rewritescope-rewrites-string-literals-too)). |
| `data-each ... data-key="expr"` | Keyed reconciliation. Items at the same key + index keep their DOM, listeners, focus, and selection. Without a key, the list rebuilds on each change (legacy behavior). |
| `data-each ... data-key="expr" data-stable-key` | Reuse the *same* clone across reorder. Skips path rewriting on the cloned subtree, so reorder is genuinely free of UX cost (focus, scroll, input value, selection survive moves). Author opts in by promising the row's bindings don't reference `varName.*` paths — the engine warns at bind time if they do (see [trade-offs](trade-offs.md#data-each-re-clones-moved-items-default-keyed-mode)). |
| `data-model="path"` | Two-way binding for `<input>` / `<select>` / checkboxes. State → element via `:value`/`:checked`, element → state on `input`/`change` event. |
| `data-model="path.<modifiers>"` | Trailing dot-separated modifiers, chainable (Vue-style). `.lazy` commits on `change` instead of `input`; `.number` coerces via `parseFloat` (NaN → original string); `.trim` trims whitespace before write. Example: `data-model="query.trim.lazy"`. The names are reserved suffixes — see footnote below. |
| `data-ref="name"` | Expose the element on `instance.refs.name` for imperative access (`spektrum.refs.email.focus()`). |
| `data-intent="verb.noun"` | Semantic locator for agentic tooling. Element is registered into `instance.intents` and findable via `spektrum.findByIntent('verb.noun')`. Pure marker — no runtime behavior; siblings (`data-action`, `data-fn`, `data-model`) decide what it does. See [agent-native workflow](../AGENTS.md). |
| `data-action="cycle"` + `data-fn` + `data-id` | Subscribe a registered fn to a path. |
| `data-action="event[.modifier]*"` + `data-fn` | DOM-event dispatch. **Behavior:** `.prevent` / `.stop` / `.once` / `.self` (only when `event.target` is the bound element). **Listener options:** `.capture` / `.passive`. **Key gates:** `.enter` / `.esc` / `.tab` (key-match) and `.shift` / `.cmd` (system modifiers — Vue's `cmd` maps to `metaKey`). Chainable: `keydown.shift.enter` fires only on Shift+Enter. |

Built-in `data-fn` handlers: `trigger`, `setValue`, `setText`, `setStyle`, `toggle`. Register your own with `defineFn(name, handler)`. Handler signature: `(el, state, delta, value, event?)`. The `event` argument is the DOM `Event` for `data-action="click"`-style bindings, or `undefined` for `data-action="cycle"` (subscription-driven, no event in scope).

### `data-each` — container, not template

`data-each` marks the **container**; its *first element child* is what gets cloned and repeated. This is the opposite of Vue's `v-for` and Alpine's `x-for`, which attach the directive to the element being repeated.

```html
<!-- ❌ wrong: <li> is the container; its first element child is absent -->
<li data-each="items">{{item}}</li>           <!-- nothing renders; warns -->

<!-- ✅ right: <ul> is the container, <li> is the template -->
<ul data-each="items">
  <li>{{item}}</li>
</ul>
```

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

`data-as` is substituted into the cloned subtree by **whole-word string replace** (see [trade-offs](trade-offs.md#rewritescope-rewrites-string-literals-too)). Short or common names will rewrite unrelated text and attribute values. The engine warns at bind time for names ≤2 characters, common identifiers (`index`, `key`, `value`, `name`, `el`, `fn`, `id`, `data`), and names that collide with top-level state keys.

Recommended: longer, distinctive names (`row`, `chip`, `node`) or a leading-underscore convention for short ones (`_t`, `_n` — the boundary doesn't match `_`).

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

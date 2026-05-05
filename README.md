<p align="center">
  <img src="example/Spektrum-logo.png" alt="Spektrum" width="480">
</p>

[![npm](https://img.shields.io/npm/v/spektrum.svg)](https://www.npmjs.com/package/spektrum)
[![bundle size](https://img.shields.io/bundlephobia/minzip/spektrum.svg)](https://bundlephobia.com/package/spektrum)
[![license](https://img.shields.io/npm/l/spektrum.svg)](LICENSE)
[![CI](https://github.com/D-dezeeuw/spektrum/actions/workflows/ci.yml/badge.svg)](https://github.com/D-dezeeuw/spektrum/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/spektrum.svg)](spektrum.d.ts)

A tiny templating engine. ~6.5 kB minified, ~400 lines of actual code, zero runtime dependencies.

That third number is what matters. The ecosystem has spent the last decade normalizing "tiny" libraries that quietly pull in dozens of transitive dependencies — and the steady drumbeat of npm supply-chain attacks keeps proving how fragile that is. Spektrum is one file. You can audit it in an afternoon.

The rest follows from that constraint.

Features:

- Declarative HTML bindings: `{{expr}}`, `:attr="expr"`, `data-if="expr"`, `data-each`, `data-action`, `data-model`, `data-ref`.
- Real expressions in templates — `{{count + 1}}`, `:disabled="count <= 0"`, `data-if="!user.loggedIn"`. Path lookups still work; they're just the simplest case.
- Two-way input binding via `data-model="path"` (covers text inputs and checkboxes).
- Conditional class binding with object form: `:class="{active: x, error: y}"`.
- Element refs via `data-ref="name"` → `instance.refs.name` for imperative access.
- First-class derived state via `computed(path, deps, fn)`.
- Reactive engine: subscribed systems, delta-driven tick loop, fan-out within a single tick.
- History keeping: every mutation is recorded; `replay(n)` reconstructs any past state. Useful for undo, debugging, scrubbable timelines.
- Test-friendly: `tick()`, `reset()`, `replay()` are public, synchronous, and deterministic. No mocks, no fake timers, no awaiting microtasks.
- Multiple isolated instances via `createSpektrum()`.
- TypeScript declarations included.
- ESM only, no build step required.

What it doesn't do:

- No keyed list reconciliation — `data-each` rebuilds on change. Fine to ~100 items.
- No SSR or hydration. Client-only.
- No router, store layer, or animation system. It's an engine, not a framework.
- Templates are author-written; expressions execute via `new Function`. Don't accept untrusted templates (same caveat as Vue and Alpine).

**[Live demo →](https://d-dezeeuw.github.io/spektrum/example/)**

## Install

```bash
npm install spektrum
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
| `example/index.html` | Demo page — declarative bindings using every feature. |
| `example/app.js` | Demo wiring (seed, clamp, derived flags, log fan-out, scrubber sync). |
| `spektrum.test.js` | Engine tests via `node --test`. |
| `eslint.config.js` | Lint rules. |

## Engine in three sentences

Mutations write into an append-only `appStateDelta`. Each tick drains the delta to quiescence: systems whose subscribed paths appear in the delta run, the delta merges into committed `appState` and is cleared, and any new writes during system execution kick off another pass — that's how fan-out works. Every mutation is recorded in `history` so `replay(n)` can rebuild any past point.

## Declarative bindings in HTML

| Form | Effect |
| --- | --- |
| `{{expression}}` in a text node | Interpolated text, auto-escaped. Full JS expression: `{{count + 1}}`, `{{user.name.toUpperCase()}}`. |
| `:attr="expression"` on any element | Property write. Object form on `:class` toggles named classes: `:class="{active: x, error: y}"`. |
| `data-if="expression"` | Show element when truthy, `display: none` when falsy. Children stay bound. |
| `data-each="path" data-as="name"` | Render the array at `path`, cloning the first child as a template per item; `name.x` rewrites to `path.<i>.x` so cycle bindings resolve. |
| `data-model="path"` | Two-way binding for `<input>` / `<select>` / checkboxes. State → element via `:value`/`:checked`, element → state on `input`/`change` event. |
| `data-ref="name"` | Expose the element on `instance.refs.name` for imperative access (`spektrum.refs.email.focus()`). |
| `data-action="cycle"` + `data-fn` + `data-id` | Subscribe a registered fn to a path. |
| `data-action="click\|input\|..."` + `data-fn` | DOM-event dispatch. |

Built-in `data-fn` handlers: `trigger`, `setValue`, `setText`, `setStyle`, `toggle`. Register your own with `defineFn(name, handler)`.

Derived state via `computed(path, deps, fn)` — re-runs when any `deps` change, writes the result into `path`. Returns an unsubscribe handle.

## Public API

```js
import spektrum, {
  // state (objects mutable; cursor/replaying are getters on the default instance)
  appState, appStateDelta, history, refs,
  // mutators
  trigger, setValue,
  // derived state
  computed,
  // subscriptions
  addSystem, removeSystem, defineFn,
  // lifecycle
  bindDOM, run, tick, replay, reset,
  // utility
  getPathObj, setPathValue,
  // factory for multiple instances
  createSpektrum,
} from 'spektrum';

// Read live cursor / replaying via the default instance.
spektrum.cursor;     // current history position
spektrum.replaying;  // true while replay() is in flight
```

For multiple isolated apps on one page, call `createSpektrum()` to get an instance with the same API.

## Commands

```bash
npm test       # run engine tests (node:test, no deps)
npm run lint   # eslint
npm start      # serve on :8088
```

## Trade-offs

- No runtime deps. Engine is portable.
- `replay` is O(n) per scrub. Fine into the low thousands; for longer histories cache snapshots every K entries.
- `bindDOM` walks every text node for `{{...}}`. One-shot at boot, not a hot path.
- `tick()` filter is O(systems × paths-per-system) per pass. Fine at small scale; build a path-index if you have many systems.
- `data-each` re-renders the whole list on any change to the bound path. No keyed reconciliation. Good to ~100 items.
- Tick fan-out is bounded to 1024 iterations; deeper feedback loops log a warning and bail.

# Spektrum

[![npm](https://img.shields.io/npm/v/spektrum.svg)](https://www.npmjs.com/package/spektrum)
[![bundle size](https://img.shields.io/bundlephobia/minzip/spektrum.svg)](https://bundlephobia.com/package/spektrum)
[![license](https://img.shields.io/npm/l/spektrum.svg)](LICENSE)
[![CI](https://github.com/D-dezeeuw/spektrum/actions/workflows/ci.yml/badge.svg)](https://github.com/D-dezeeuw/spektrum/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/spektrum.svg)](spektrum.d.ts)

Tiny reactive engine with declarative HTML bindings, fan-out, and time-travel replay. ~500 lines, zero runtime dependencies. ESM.

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
| `{{path}}` in a text node | Interpolated text, auto-escaped. |
| `:attr="path"` on any element | Property write (`el[attr] = state[path]`). Use property names: `:className`, not `:class`. |
| `data-if="path"` | Show element when truthy, `display: none` when falsy. Children stay bound. |
| `data-each="path" data-as="name"` | Render the array at `path`, cloning the first child as a template per item; `name.x` rewrites to `path.<i>.x` so cycle bindings resolve. |
| `data-action="cycle"` + `data-fn` + `data-id` | Subscribe a registered fn to a path. |
| `data-action="click\|input\|..."` + `data-fn` | DOM-event dispatch. |

Built-in fns: `trigger`, `setValue`, `setText`, `setStyle`, `toggle`. Register your own with `defineFn(name, handler)`.

## Public API

```js
import spektrum, {
  // state (objects mutable; cursor/replaying are getters on the default instance)
  appState, appStateDelta, history,
  // mutators
  trigger, setValue,
  // subscriptions
  addSystem, removeSystem, defineFn,
  // lifecycle
  bindDOM, run, tick, replay, reset,
  // utility
  getPathObj, setPathValue,
  // factory for multiple instances
  createSpektrum,
} from './spektrum.js';

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

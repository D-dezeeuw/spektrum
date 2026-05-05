# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `checkPath` no longer materialises the leaf segment of a path on `appState`. Previously, `setValue('count', 0)` would put a `{}` placeholder on `appState.count` until the first tick merged the real value. Bindings that read state pre-tick (most commonly `data-model` on an `<input type="number">` or `:disabled="someExpr"`) would receive that placeholder and produce `"[object Object]"` warnings on number inputs and similar coercion oddities elsewhere. Intermediate parents are still materialised so systems can do direct property writes like `state.user.x = …`.

## [0.2.0] — 2026-05-05

### Added

- **Expressions in `{{...}}`, `:attr`, and `data-if`.** Path lookups still work (backward compatible) but you can now write `{{count + 1}}`, `:disabled="count <= 0"`, `data-if="!user.loggedIn"`, etc. Templates are author-written so `new Function` is acceptable; same caveat as Vue/Alpine — don't accept untrusted templates.
- **`data-model="path"`** for two-way input binding. Equivalent to `:value="path"` + `data-action="input" data-fn="setValue" data-id="path"`. Detects `<input type="checkbox">` and uses `change`/`el.checked`; everything else uses `input`/`el.value`.
- **`:class` object form**: `:class="{active: x, error: y}"` toggles individual classes via `classList.toggle`, preserving sibling classes set elsewhere. String and array forms still overwrite `className` (backward compatible).
- **`data-ref="name"`** exposes the element on `instance.refs.name` for imperative DOM access (focus, scroll, measure). `reset()` clears the refs map.
- **First-class `computed(path, deps, fn)`** — derives state into `path` whenever any of `deps` change, by writing to the delta on each pass. Returns an unsubscribe handle.

### Changed

- `bindText`, `bindAttrs`, and `bindIf` now route through the expression engine. A bare path is just the simplest expression, so existing usage is unaffected.
- `evalExpr` normalizes dotted-numeric segments (`users.0.name`, the form `bindEach` produces) into bracket notation (`users[0].name`) before compiling, so JS can parse them. Subscriptions stay dotted on the engine side.
- `evalExpr`'s compiled function wraps the body in a runtime try/catch — expressions that touch a path before it exists in state (typical of the initial render before the first tick) render as undefined instead of throwing.

## [0.1.1] — 2026-05-05

### Added

- `bindDOM` is now idempotent at the root level. Calling it twice on the same root is a safe no-op; calling the returned `destroy()` releases the root for re-binding.
- DOM-touching tests via `@happy-dom/global-registrator` (dev dep). Covers `{{path}}`, `:attr`, `data-if`, `data-each`, click dispatch, and idempotency.
- Publish-on-tag GitHub Actions workflow (`.github/workflows/publish.yml`) — pushing a `v*` tag triggers test + lint + build + `npm publish` with provenance.
- README: badges, install instructions, 6-line quickstart, link to live demo.

### Changed

- `tick()` now wraps each system in try/catch — one throwing system no longer aborts the rest of the pass.
- Per-system top-level path keys are cached at subscription time, letting `tick()` skip systems whose subscriptions don't intersect the delta's top-level keys before the full `isPath` walk. Modest speedup at scale.
- Replaced `document.createTreeWalker` with a hand-written tree walker. The standard API silently returns no nodes under happy-dom; the hand-written walker works in any DOM implementation.

## [0.1.0] — 2026-05-05

Initial release.

### Added

- **Reactive engine**: `trigger`, `setValue`, `addSystem`, `removeSystem`, `defineFn`, `tick`, `run`, `replay`, `reset`.
- **Declarative HTML bindings**:
  - `{{path}}` text interpolation (auto-escaped).
  - `:attr="path"` property binding.
  - `data-if="path"` conditional show/hide.
  - `data-each="path" data-as="name"` list rendering with per-item path rewriting.
  - `data-action="cycle|click|input|..."` plus `data-fn` for cycle systems and DOM events.
- **Built-in `data-fn` handlers**: `trigger`, `setValue`, `setText`, `setStyle`, `toggle`.
- **Time-travel replay**: `replay(n)` reconstructs state at any past history index. Triggering while scrubbed truncates the future (git-reset semantics).
- **Multiple instances** via `createSpektrum()`. Each is fully isolated.
- **Tick fan-out**: systems can write into the delta during their run; the engine drains the delta to quiescence within a single tick (bounded to 1024 iterations).
- **TypeScript declarations** (`spektrum.d.ts`).
- **Minified build** (esbuild, ~4.7 kB).

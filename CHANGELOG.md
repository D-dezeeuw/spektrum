# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.3] — 2026-05-06

### Fixed

- **`reset()` now drains DOM listeners before clearing state** (audit finding F-5). Previously, `reset()` cleared `appState`, `history`, `systems`, and the `boundRoots` idempotency tracker — but the `input`/`change` listener attached by `data-model` and the click listener attached by `data-action` stayed bound to their elements. A subsequent `bindDOM()` on the same root attached a *second* listener, so one click fired the handler twice; load-bearing for any flow that exercises time-travel or fork-replay. Cleanups now register into an instance-level `Set` that `reset()` drains before wiping state. Calling cleanups twice is safe (`removeEventListener` is idempotent), so existing destroy() callers keep working unchanged.

### Added

- **Tag-only npm publish workflow with `--provenance`** (audit finding F-7). `.github/workflows/publish.yml` triggers on a `v*` tag push, runs `lint` / `test` / `build` / `size` against a clean `npm ci` install, then publishes with `--provenance --access public`. Auth via `NPM_TOKEN` secret; OIDC `id-token: write` enables the provenance attestation independent of publish auth. Restores the supply-chain signal that 0.3.1's "drop CI" change traded away. Manual local checks remain the dev workflow; CI is publish-only.

## [0.3.2] — 2026-05-06

### Security

- **Prototype-pollution defenses** (audit findings F-1 / F-2). Added a single `SAFE_KEY` predicate (`!== '__proto__' && !== 'prototype' && !== 'constructor'`) and applied it at four sites: `isPath`, `createNestedObjects`, `setPathValue` bail when any path segment is unsafe; `deepMerge`'s key loop skips unsafe keys. Closes both the path-walker sink (`setValue('__proto__.x', …)`) and the JSON-parsed sink (`setValue('p', JSON.parse('{"__proto__":…}'))`). No public-API change for legitimate paths.
- **`spektrum-persist.js` shape validation** (F-3). `loadHistory` now skips entries with non-string `path`, requires numeric `value` for additive `trigger` ops, and caps replay at `opts.maxEntries ?? 100_000`. Defense-in-depth on top of F-1's engine guard, since persisted history is reachable via attacker-controlled storage (XSS, malicious extension).
- **URL-attribute sanitization** (F-4). `:href`, `:src`, `:action`, `:formaction`, `:background`, `:cite`, `:poster`, `:data` rewrite values starting with `javascript:` (case-insensitive, whitespace-tolerant) to `#`. Other schemes pass through unchanged. `:srcdoc` is *not* in this list — its value is HTML, not a URL, and a `javascript:` check would be a false-confidence signal. README documents the boundary explicitly.
- **Persisted `Infinity` rejected** (F-3 hardening, post-review). `loadHistory` now uses `Number.isFinite` instead of `typeof === 'number'` for additive `trigger` ops. `JSON.parse('1e1000')` overflows to `Infinity`, which the prior check let through; a single poisoned `add` would make the path stick at `Infinity` for all subsequent additive ops. Caught by independent review of the F-3 patch.

### Changed

- Size budget bumped to 9 216 raw / 4 096 gzip (was 9 000 / 4 000) to absorb the security fixes. Bundle is now 8 780 raw / 4 017 gzip.

## [0.3.1] — 2026-05-05

### Changed

- Removed both GitHub Actions workflows (`ci.yml` and `publish.yml`). Releases are now published manually from a local checkout after running the `test` / `lint` / `build` / `size` scripts. Consequence: published tarballs no longer carry a `--provenance` attestation. The published code is identical to v0.3.0 (whose tag was pushed but whose publish run failed before reaching npm).

## [0.3.0] — 2026-05-05

### Added

- **`onFork(fn)` hook + `spektrum.forks`** for mutate-while-scrubbed-back. When `record()` truncates entries, the dropped tail is now preserved on `spektrum.forks` (oldest first, capped by `forkLimit`, default 50) and the optional `onFork` hook fires with `{ entries, forkedAt, ts }`. Apps can warn ("X future edits will be discarded"), surface telemetry, or restore by re-applying the fork's entries via `setValue` / `trigger`. Descriptive only — the truncate has already happened by the time the hook fires; throwing inside it can't roll back. Set `forkLimit: 0` to discard forks immediately while still firing the hook; set `Infinity` to keep them all.
- **Keyed list reconciliation** via `data-key="expr"` on `data-each`. Items at the same key + index keep their DOM, listeners, focus, and selection across re-renders. Without a key, lists fall back to the previous full-rebuild behavior (backward-compatible).
- **Bounded history & snapshot-accelerated replay**: `createSpektrum({ historyLimit, snapshotEvery })`. `historyLimit` caps `history.length` (oldest entries drop on overflow); `snapshotEvery` captures `appState` every K recorded entries so `replay()` runs in O(K) instead of O(n).
- **`onError(fn)` hook** for surfacing system exceptions. Receives `(err, systemFn)`. Without a handler, throwing systems still fall through to `console.error` — the engine itself never crashes.
- **`onRecord(fn)` hook** fires after every recorded mutation with the full `HistoryEntry`. Does not fire during `replay()`. Used by `spektrum/persist`'s `autoSave` so `data-model` two-way edits are caught the same way explicit `setValue`/`trigger` calls are.
- **`precompile(source, fn)`** API for CSP-safe deployments. Build-time tooling emits one call per unique template expression; the runtime cache hits before the `new Function` fallback runs.
- **`spektrum/compile`** subpath module: `extractExpressions(html)` + `emitPrecompileSource(exprs)` for the build step.
- **`spektrum/devtools`** subpath module: a small floating scrubber panel (`mount(spektrum)`) that exposes time-travel as a UI in dev.
- **`spektrum/persist`** subpath module: `saveHistory` / `loadHistory` / `autoSave` over localStorage (or any Storage-shaped backend).
- **Event modifiers** on `data-action`: `.prevent`, `.stop`, `.once` (e.g. `data-action="submit.prevent"`). Mirrors Vue's v-on modifiers for the common footguns.
- **`SECURITY.md`**, **`CONTRIBUTING.md`**, **bug-report issue template**, and a zero-dep size-budget script (`scripts/size.js`) gated in CI.

### Changed

- `evalCache` is now bounded (FIFO, 500 entries) so long-running pages with dynamic templates can't grow it without limit.
- CI runs coverage (`node --test --experimental-test-coverage`) and enforces the size budget on every PR.
- Minimum Node version raised to 20 (test runner coverage flag).

### Fixed

- `replay()` now refreshes every system once against the final state after the entry-replay loop, so bindings stay in sync when scrubbing back to a state where their subscribed paths are absent. Previously, scrubbing back through a populated `data-each` left the rendered rows in the DOM (because no replayed entry touched the array, no system fired, no wipe). Users could then type into a phantom row and corrupt state.
- `deepMerge` no longer wholesale-replaces an array slot when the source is a plain object with numeric keys. `setValue('items.1.note', 'x')` writes `delta = {items: {0: {note: 'x'}}}` (path walker creates plain-object intermediates); the merge now descends into the existing array and updates `items[1].note` in place, preserving the other elements. Whole-array replacement still happens via `setValue('items', newArr)` because that lays an Array directly into the delta. Visible symptom of the prior behavior: typing into a per-item input bound via `data-model="item.note"` made the entire list disappear.
- `reset()` no longer clears `onError` / `onRecord` registrations. Hooks are configuration, not state — clearing them caused `loadHistory()` (which calls reset internally) to silently tear down handlers installed before the load. Clear them explicitly with `onError(null)` / `onRecord(null)` if needed.
- `checkPath` no longer materialises the leaf segment of a path on `appState`. Previously, `setValue('count', 0)` would put a `{}` placeholder on `appState.count` until the first tick merged the real value. Bindings that read state pre-tick (most commonly `data-model` on an `<input type="number">` or `:disabled="someExpr"`) would receive that placeholder and produce `"[object Object]"` warnings on number inputs and similar coercion oddities elsewhere. Intermediate parents are still materialised so systems can do direct property writes like `state.user.x = …`.
- `bindReactive`'s initial render now uses a snapshot of `appState ⊕ appStateDelta` instead of `appState` alone, so bindings registered after `setValue()` but before the first `tick()` see the seeded values immediately — eliminates a one-frame flicker between bind time and the first tick.
- `deepMerge` no longer crashes when a state slot's type changes from primitive to object. Previously `deepMerge({k: 5}, {k: {nested: 1}})` would try to write `(5).nested = 1` and throw in strict mode; now the slot is replaced with `{}` before recursing.

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

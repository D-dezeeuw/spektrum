# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] — 2026-06-05

**Agent writes are now deny-by-default.** An MCP/agent catalog created without write configuration is **read-only** — every mutation tool returns `protected: <path>` and the engine is never called. Opt into writes with `protectedPaths` (allow all but the listed paths) or `allowAllPaths: true` (allow everything).

> **Breaking, shipped as a minor.** Flipping the default from "allow all writes" to "deny all writes" is technically breaking. It ships as a minor rather than a major deliberately: there are no published consumers of the unrestricted default yet, and shipping the safe behavior now — before adoption — is worth more than the semver purity. If you relied on the old default, add `allowAllPaths: true` (or, better, `protectedPaths`).

### Changed

- **`createTools(spektrum)` and `spektrum/agent`'s `mount()` deny writes by default.** Precedence: `protectedPaths` (if non-empty) → allow all but those; else `allowAllPaths: true` → allow all; else → deny all. `protectedPaths` wins when both are passed. An empty `protectedPaths: []` is *not* an opt-in and falls through to deny.
- The in-page agent appends a note to its system prompt describing the limits up-front: the protected paths, or — for a read-only mount — that state-writing tools will be rejected. Saves the model wasted tool calls.
- Replaces the brief 1.0.2 "warn on ungated catalog" approach: the default is now genuinely safe rather than merely loud, so the warning string is gone. Net size *trim* — `spektrum-mcp.min.js` raw cap returns to the 1.0.1 level (5,632 → 5,376 B) and the gz cap drops (2,240 → 2,112 B).

## [1.0.2] — 2026-06-05

*Never tagged or published to npm on its own — these changes ship as part of 1.1.0. Kept as a separate section for a granular record of the hardening pass.*

**Production-hardening patch.** Five engine-correctness fixes plus a focused pass on the issues a production-readiness audit surfaced: a real time-travel snapshot fix, cancellable speculative async (`attempt()` `AbortSignal`), complete companion types, and an error-code drift gate that actually gates. All additive or bug-fix; no breaking changes.

### Fixed

- **Snapshots no longer alias live state.** `deepMerge` clones plain objects but shared array references, so a stored snapshot aliased the arrays it was captured from. A direct `appState.list.push(x)` (bypassing `setValue`/`addValue`) — or an in-place sub-path merge during `replay()` — could mutate a snapshot and make `replay()` restore corrupted state. Snapshots now `deepClone` their whole object graph at both the store and restore boundaries, so each owns its arrays. Only affected instances using `snapshotEvery`.
- **`computed()` rejects self-referential deps** at registration with `E_COMPUTED_SELF_DEP` (equal / ancestor / descendant overlap). Previously a self-dep silently burned the 1024-iteration tick cap and tripped the delta-clear safety net, dropping other systems' writes queued in the same tick.
- **`:innerHTML` / `:textContent` reach the DOM.** `bindAttrs` aliases HTML-lowercased camelCase property names (`:innerHTML` → `innerHTML`) instead of assigning a dead JS expando.
- **Hyphenated attributes reach the DOM.** `:aria-pressed`, `:data-*`, etc. route through `setAttribute` / `removeAttribute`; `null`/`undefined` clears the attribute.
- **`bindDOM` binds the root element**, not only its descendants — so `:attr` / `data-if` / `data-action` authored on a `data-each` loop body's own tag actually bind.
- **`warn()` returns `undefined`** explicitly so `return warn(…)` from a guard clause can't smuggle a monkey-patched `console.warn` return value into a cleanup collector.

### Added

- **`AbortSignal` for `attempt()`.** `fn` receives an `AbortSignal` (also `handle.signal`); `discard()` aborts it, so in-flight async speculative work wired to the signal — `attempt('edit', (signal) => fetch(url, { signal }))` — is cancelled instead of landing a write after the rewind. Back-compatible: an `fn` that ignores the arg behaves as before.
- **TypeScript declarations for all five remaining companions** (`spektrum/compile`, `/devtools`, `/persist`, `/mcp`, `/agent`), wired into the `package.json` exports `types` field. Previously these public exports shipped untyped (consumers hit `TS2307`). The type test now exercises them so `tsc --noEmit` catches companion drift too.
- **`E_COMPUTED_SELF_DEP` is now in `EngineErrorCode`** and documented in `docs/api.md`.

### Internal

- **Real error-code drift gate.** The previous `tsc --noEmit` "drift gate" passed even though `E_COMPUTED_SELF_DEP` was missing from `EngineErrorCode` — it read `err.code` one-directionally. Added an exhaustiveness `switch` over the union (catches type→handler drift) and a runtime source-scan test that fails CI if `spektrum.js` assigns a `code` not registered in the type and docs (catches JS→type drift).
- Engine size cap raised one step (13,440 → 13,696 B raw / 6,112 → 6,240 B gz) for the snapshot `deepClone` + `attempt` `AbortSignal` (~215 B net). Rationale documented inline in `scripts/size.js`.

### Docs

- README: qualified the strict-CSP claim (the default runtime needs `unsafe-eval`; precompile with `spektrum/compile` for strict CSP) and corrected the stale source-line count.
- `docs/bindings.md`: documented `:innerHTML` as carrying the same template trust requirement as `:srcdoc` — never bind untrusted/LLM/API content through it.
- `docs/modules.md`: documented `protectedPaths` and `allowAllPaths` for `spektrum/mcp` and `spektrum/agent`.
- `SECURITY.md`: added an agent-driven-mutation section.

## [1.0.1] — 2026-05-18

**Agent-mount safety.** Adds `protectedPaths` to `createTools(spektrum, opts)` and the in-page agent's `mount(spektrum, opts)` — paths that mutation tools refuse to write. Engine-level patch unblocks consumers who wanted to mount `spektrum/agent` against real apps but feared the agent overwriting sensitive state (API keys, player selection, etc.). Patch-level because the API is purely additive: omitting `protectedPaths` is identical to 1.0.0.

### Added

- **`createTools(spektrum, { protectedPaths: ['llm.apiKey', /^llm\./, ...] })`** in `spektrum/mcp`. Mutation tools (`setValue`, `trigger`, and the inline `set` / `add` ops inside `attempt.start`) refuse writes whose path matches any pattern. String entries match exact path or dot-segment prefix (so `'llm'` covers `llm.apiKey` and `llm.provider`, but not `llmFoo`). RegExp entries are tested as-is. Denied writes return `{ ok: false, error: 'protected: <path>' }` and the engine is never called — no history entry, no state mutation, no subscribed system fire.
- **`mount(spektrum, { protectedPaths })`** in `spektrum/agent` forwards the option to its internal `createTools` call. When set, a sentence enumerating the protected paths is appended to the system prompt so the model knows the limits up-front and stops wasting tool calls on writes that will be rejected. `opts.system` (full override) still wins — explicit user control trumps the guard note.
- Tests cover exact-string match, dot-segment prefix, prefix-but-not-substring (`llm` doesn't gate `llmFoo`), RegExp match, mixed patterns, gating across all three write sites (`setValue` / `trigger` / `attempt.start` actions), and the agent companion's system-prompt augmentation + end-to-end rejection in the chat panel.

### Internal

- `spektrum-mcp.min.js` size cap raised one 256 B step (5,120 → 5,376 B raw). Actual size 5,286 B raw / 2,032 B gz — gzip cap unchanged. Rationale documented inline in `scripts/size.js`.
- Engine (`spektrum.js`) is byte-identical to 1.0.0. The auditability framing of the engine bundle is untouched; the safety gate lives in the opt-in MCP companion that consumers explicitly import when they want agent access.

## [1.0.0] — 2026-05-17

**The 1.0 ship.** The agent-native surface, multi-subscriber hooks, and docs reorg that the 0.6 line built toward, plus the post-relabel batch that landed before tagging: proper `data-each` scope (`$index` / `$first` / `$last` / `$path`, nested scope, reuse-on-reorder), the `addValue` mutator, a `tsc --noEmit` `.d.ts`-drift gate, a TypeDoc-rendered API reference site, and five engine-correctness / DX fixes.

The framing is unchanged: a tiny, deliberately auditable reactive engine with time-travel as a primitive and a first-class agent surface. ~13 kB minified, zero runtime dependencies, single file. The whole engine still fits in your head — and now in any LLM's context window in one tool call.

### Breaking changes

- **Hooks (`onError`, `onRecord`, `onFork`) are now multi-subscriber.** Each call appends a subscriber and returns an unsubscribe handle; `onX(null)` clears all subscribers on that hook. Pre-1.0 behavior was single-handler-replace, which silently collided when (e.g.) `autoSave` overwrote a user-registered `onRecord`. The collision is the whole reason for the change.
  - **Migration.** Most code keeps working unchanged: `onError(fn)` still installs the handler, `onError(null)` still clears. The two cases that need attention:
    1. Code that relied on the second `onX(fn)` *replacing* the first (rather than appending) — no longer correct. Capture the unsub from the first call and call it before installing the second.
    2. `autoSave`'s teardown previously ran `spektrum.onRecord(null)`, which would have wiped any user telemetry hook installed alongside it. The bundled `autoSave` now uses the returned unsub; if you wrote a custom autosave-style helper, do the same.

### Added

- **Agent-native surface (recap from the 0.6 line that landed pre-1.0):**
  - `describe()` — operational manifest in one call (state, registered systems, fns + schemas, refs, intents, checkpoints, history shape).
  - `explain({ from, to })` — causal trace over a history range, each entry annotated with the systems whose subscriptions intersect its path.
  - `attempt(name, fn)` — speculative execution: drops a checkpoint, runs `fn`, returns a `{ result, commit, discard }` handle.
  - `findByIntent(name)` — locates elements by their declared `data-intent="verb.noun"` semantic marker.
  - `defineFn(name, fn, meta?)` — optional `meta` ({ description, input, output, examples }) for self-describing verb catalogs.
- **`data-intent` directive** — semantic locator for agentic tooling. Pure marker; no runtime behavior.
- **`spektrum/mcp`** — SDK-agnostic MCP tool catalog. `createTools(spektrum)` returns plain JS tool definitions wireable into any MCP server SDK.
- **`spektrum/agent`** — in-page LLM assistant. Floating chat panel that drives the engine via the agent surface. Supports Anthropic, OpenAI, and OpenRouter via a per-provider settings UI.
- **`AGENTS.md`** at the repo root — agent workflow tutorial (orient → speculate → explain → commit). Covers the in-page panel and the MCP catalog.
- **`$index`, `$first`, `$last`, `$path`** are first-class scope variables inside `data-each`. `$path` is the row's full state path as a string; the others are the index and its boundary flags.
- **Nested `data-each`** sees outer scope variables (and aliases) without ceremony. The inner scope merges over the outer.
- **`addValue(path, value, id?)`** — the harmonized additive mutator. Same semantics as `trigger` but with `setValue`'s argument order, so the two read naturally side-by-side and swap with a one-character edit. `id` defaults to `add:${path}` for history locatability.
- **`data-fn="addValue"`** built-in handler, symmetric with `data-fn="setValue"`. The pre-existing `data-fn="trigger"` keeps working as an alias (handler is registered under both names by sharing the same function reference — zero duplication).
- **`tsc --noEmit` gate in CI.** `tsconfig.json` + `tests/types/spektrum.types.ts` import every public export, exercise common usage patterns, and pin two `@ts-expect-error` negative cases. Breaks CI if the hand-maintained `.d.ts` files drift from the JS surface. `typescript` is a devDep only.
- **Generated API reference site** — `npm run docs` builds [TypeDoc](https://typedoc.org/) HTML from the hand-maintained `spektrum.d.ts` / companion `.d.ts` files into `docs-site/` (gitignored). A new `.github/workflows/docs.yml` builds on every push and deploys to GitHub Pages from `main`; PRs build but do not deploy. `typedoc` is a devDep — the engine's zero-runtime-deps promise is unaffected.
- **`CONTRIBUTING.md` docs-touchup checklist** under Coding conventions — closes the process gap that left stale `rewriteScope` / `data-stable-key` cross-references in `docs/` after the data-each refactor.

### Changed

- **`extractPaths` regex now honors backslash-escaped quotes.** Previously a string literal with `\"` could leak identifiers as spurious subscriptions. Failure mode was benign over-subscription; the fix is ~20 bytes for a tighter guarantee.
- **README slimmed from ~676 lines to ~120.** Reference material moved to `docs/`. The README is now the front door (pitch, quick start, install, showcase, docs index); the depth lives in eight focused topical files. Plain Markdown, no docs framework.
- **Documentation index at `docs/README.md`** — GitHub renders it natively when you visit `/docs/`. Cross-linked via relative paths.
- **`data-each` now uses proper per-iteration scope** instead of whole-word text substitution. The loop variable, `$index`, `$first`, `$last`, and `$path` are real lexical bindings carried on a scope object through `extractPaths`/`evalExpr` (subscription paths translated via a `scopePaths` WeakMap; eval uses `with (state) with (scope)` so the loop variable shadows same-named state keys).
- **Keyed reorder always reuses the same DOM node.** A moved row's bindings are torn down and re-bound with a scope pointing at the new index; the clone (and any `<input>` state, focus, scroll position inside it) survives the move. This was previously opt-in via `data-stable-key`; that attribute is now silently accepted as a no-op for back-compat.
- **`data-fn="trigger" / "setValue" / "addValue" / "setText" / "setStyle"` resolve `data-id` through scope.** Writing `data-id="row.count"` inside a `data-each` now targets the row's actual state path (e.g. `rows.3.count`). Built-ins gain an optional trailing `scope` argument; custom `data-fn` handlers can opt in to the same translation via the same arg (`(el, state, delta, value, event?, scope?)`).
- **`bindModel="item.note"` inside `data-each` resolves to the row's state path,** so two-way input bindings target the right item without manual path computation.
- `trigger(id, path, value)` is now documented as a **deprecated alias** for `addValue`. Same behavior, same back-compat surface — new code should prefer `addValue`. JSDoc `@deprecated` tag added in `spektrum.d.ts` so TypeScript users see the steer, and the rendered TypeDoc page marks the variable as deprecated.
- The mutator empty-path warn from `trigger(...)` now surfaces as `addValue: empty path` (trigger forwards rather than carrying a duplicate guard). Intentional — the warn names the real implementation and doubles as a nudge toward the non-deprecated spelling.
- `docs/api.md` gains a `## Mutators: setValue vs addValue` section explaining the absolute-vs-additive distinction, when each is appropriate, and the back-compat status of `trigger`.

### Fixed

- **`{{grid.1.0}}`-style chained numeric path segments** now convert to bracket notation in one pass — previously the first index converted (`grid.1.0` → `grid[1].0`) and the second left a parse error, silently rendering ``. The replacement also no longer touches digit-prefixed `.\d` runs in float literals: `{{val + 1.5}}` correctly evaluates to `11.5` instead of compile-throwing and rendering empty.
- **`addAsync(path, loader)` skips its initial fetch when state already holds a settled `{data}` or `{error}` shape.** The common case is re-registering after `loadHistory` has replayed an earlier fetch — the old behavior double-fetched. The runner is still registered, so `refresh(path)` continues to force a fresh fetch on demand.
- **`data-ref` cleanup only clears the slot if it still owns it.** Two elements sharing a name (last bind wins on read) no longer wipe each other's entry when one is destroyed.
- **`data-each` keyed mode warns on duplicate keys** instead of silently merging clones into the first row — surfaces the bug at bind time rather than as confusing reorder behavior later.
- **`attempt()` handle is single-shot** — a second `commit()`/`discard()` is a no-op. Guards a defensive `commit()` in a `finally{}` after `discard()`, which previously appended an orphan checkpoint past the replay point.

### Removed

- **Pre-1.0 status callout from the README.** The "feature-complete pre-1.0" framing has been true since 0.5.0; the 0.6 batch made it overdue. 1.0 means nothing about new capability — it means "we're confident the API surface is what we said it would be."
- **`rewriteScope`** (~150 B) is gone — proper scope replaces the whole-word text-substitution mechanism.
- **`data-as` short-name warning** (`data-as="t" rewrites \bt\b across template text/attrs`) is gone. With proper scope, the loop variable is lexically scoped and can't collide with unrelated identifiers in template text.
- **`data-as` shadow warning** (`data-as="user" shadows state.user`) is gone. `with (state) with (scope)` makes the loop variable's shadow of a same-named state key well-defined and intentional, not a footgun.
- **`data-stable-key needs data-key` warning** is gone. Keyed reorder always reuses now; the attribute is silently accepted for any HTML that still has it.

### Optimized

A pre-release optimization pass against the 1.0 snapshot — pure refactors, behavior-equivalent, ~370 B raw saved across the engine + agent module. All measured, kept only the wins.

- **`bindDOM` single-walk consolidation.** Five separate `querySelectorAll` calls (one per directive) plus the dedicated `[data-cloak]` strip pass collapsed into one walk over `*` that dispatches on `el.dataset.X !== undefined`. Same behavior, fewer tree traversals, also ~150 B raw saved on the engine bundle. The inline `data-action` handling extracted into a `bindAction(el)` helper to fit the per-element-binder pattern.
- **OpenAI/OpenRouter adapter merge** in `spektrum-agent.js`. Both speak the same chat-completions shape; only URL + a couple of attribution headers differ. Refactored into a shared `openaiCall(url, extraHeaders)` factory. Same behavior, ~30% less code in that section, ~216 B raw saved.
- **`URL_PROPS` regex inlined** at its single call site in `bindAttrs`. Named const removed.
- **Built-in `data-fn` table form attempted** but reverted: measured at +7 B raw vs. the original 5 individual `defineFn(...)` calls. The loop overhead and object literal wrapper exceeded the bytes saved on the calls; original form kept.
- **`safeFire` inlining attempted but skipped before implementation:** has 4 call sites (errorHandlers fires twice — system-throw and tick-overflow), inlining would have added ~170 B not saved.

### Internal

- `eachHosts` WeakSet of data-each host elements (container in container form, parent in `<template>` form) so `bindDOM`'s walks skip elements owned by an inner `bindEach`. The check is a manual ancestry walk that stops at the current walk root so inner calls still bind their own subtree.
- `textTemplates` WeakMap remembers each text node's original template so a re-bind reads `{{…}}` and not the previously rendered result.
- `addSystem` entries carry an `active: true` flag; unsub flips it to `false` and `tick()` skips inactive entries from the in-flight `toRun` snapshot. Without this, mid-tick teardown (bindEach reorder during a tick that already collected the old systems) would let stale systems write old paths back onto freshly re-bound elements.
- Net engine size at 1.0.0 tag: **13,060 B raw / 5,920 B gz minified** (under the 12.875 kB raw / 5.875 kB gz cap). The post-relabel batch netted ~+600 B raw — new scope plumbing, `addValue`, the five engine fixes — partly offset by `rewriteScope` removal and three dev-warning deletions; mutators collapsed into single-expression ternaries and the `data-fn` handler shared between `addValue` and `trigger` to keep the addition tight.

## [0.5.1] — 2026-05-10

**Size trim back under 10 kB minified.** 0.5.0's 1.0-credibility batch grew the engine to 11.1 kB raw / 5.0 kB gzip — fast feedback was that the framing of "tiny" needed to actually stay tiny. This release pulls the bundle back to **10234 raw / 4728 gzip** (under the historic 10 kB / 4.7 kB markers) without losing a single feature. 871 B trimmed across multiple passes.

### Changed

- **Five dev-mode `console.warn` calls dropped to free byte budget.** Behavior on misuse is unchanged — only the warning that pointed at the misuse is gone:
  - `data-stable-key` foot-gun warn (when the template referenced the loop variable). Misuse now produces visibly stale paths after reorder — easier to spot than silent corruption, and the README's "Known trade-offs" section documents the contract clearly.
  - Unknown `data-action` modifier warn (e.g. `click.preventdefault` typo). Typos now silently fall off the modifier path; listener fires as plain `click`. Documented as a footgun.
  - `reset()` detach warn (when called with active systems). `reset()` still clears systems; the warn that recommended `resetState()` was removed.
  - `onError` / `onRecord` / `onFork` overwrite warns. Single-handler-per-instance semantics unchanged — later calls silently replace earlier. Pass `null` to clear.
  - `defineFn` redefine warn. Same — silent replacement.
- **`watch` is now `addSystem` directly** (`const watch = addSystem`) — same function reference. Previously a one-line wrapper; the wrapper added bytes for no behavior.
- **`computed` writes to both state and delta** in a single derive closure — earlier eager-prime form duplicated the path-write logic across two places.
- **Internal compaction across the engine.** Highlights:
  - `RESERVED` Set → regex (~30 B saved at the path-extraction site).
  - `escapeRegex` helper dropped — `varName` from `data-as` is always an identifier, so the escape was dead weight. `rewriteScope` and (now-dropped) data-stable-key warn used the unsanitised regex form.
  - `applyClass` object branch uses `for...in` instead of `Object.entries` (~20 B).
  - `deepMerge` is now chainable (`return target`); `stateSnapshot` collapses to one expression.
  - `replay`'s snapshot-walk replaced with `Array.prototype.findLast` (~20 B).
  - `record`'s snapshot loops use `snapshots.at(-1)?.index` and `snapshots[0]?.index` (~30 B).
  - `addSystem`'s unsubscribe uses `~i &&` instead of `i !== -1` (~10 B).
  - `bindAttrs` and `bindEach` cleanup loops tightened with `?.remove()` and inline iteration.
  - `bindModel` writeEl/readEl simplified (`v ?? ''`, single ternary).
  - `addAsync` shares a `set` helper closure across the four phase writes.
  - `checkpointsOf` rewritten as `flatMap`.
- **Size budget reset**: raw cap returned to 10240 (was 11264 in 0.5.0); gzip cap is now 4736 (was 5184). Future additions will need to fit OR justify a deliberate bump.
- **README** — size claim back to "~10 kB minified (~4.7 kB gzipped)" since the engine is back under the 10 kB marker.

## [0.5.0] — 2026-05-10

**Feature-complete pre-1.0.** This release closes the engineering side of the external 1.0-readiness review — every blocker addressed, every high-leverage should-have shipped. The remaining items in the [RFC](.claude/references/RFC.md) (Phase 2: `data-intent`, `data-schema`, optional `test()` harness) are explicitly deferred until usage data shapes them. Engine source crossed under the **1000-line marker** (999 lines including comments) — the "audit it in an afternoon" pitch is honest. 1.0 is now a relabel-and-marketing-moment away.

The five commits since `0.4.1` are all consolidated below.

### Fixed

- **`computed` now writes to both state and delta** (mid-tick read-through). Pre-fix: a sibling system reading `state.derived` in the same tick pass that another system was computing it saw the prior committed value — fan-out worked across passes, but the SAME-pass read was stale. Real footgun in chained `computed` graphs and in any consumer that mixed plain systems with computed values. Now `computed`'s derivation writes to `appState` directly (mid-pass reads see fresh) AND to `appStateDelta` (downstream subscribers still fan out as before). Documented as a non-trade-off; the README's "Known trade-offs" entry on this is gone.
- **`computed` primes synchronously from current state on registration.** The previous behavior was a silent no-op when `computed` registered after its deps were already populated (e.g. after `loadHistory` had restored them) — the derivation only kicked in when one of the deps next appeared in the delta, which would never happen if state was already settled. Real-world bug surfaced in a downstream app: refresh-after-save left derived state undefined because the load had already drained the deps before the bindings registered. Now `computed` derives the initial value at registration time and writes it into the delta; the `addSystem` re-derivation path is unchanged. The eager prime is wrapped in try/catch so registering before deps exist still works — the system stays registered and derives normally once a dep arrives.

### Added

- **`addAsync(path, fn)` async resource primitive.** Sets `${path}.loading` / `${path}.error` / `${path}.data` as the Promise progresses, returns a refetch handle. Each phase records through `setValue`, so the round-trip lands in history (replay re-applies the values; no actual fetch re-issues). Pattern matches Solid's `createResource` and Vue's `useFetch` shape — `data-if="user.loading"`, `{{user.error}}`, `{{user.data.name}}` work out of the box. The single highest-leverage feature feedback identified for 1.0 credibility.
- **`watch(deps, fn)` as a public alias for `addSystem(deps, fn)`.** Same signature, conventional reactive-library name. One-line export — every consumer was wrapping `addSystem` to get this name; no longer needed.
- **`data-model` modifier suffixes: `.number` and `.trim`** (Vue-shaped). `.number` coerces via `parseFloat` (NaN → original string); `.trim` trims whitespace before write. Chainable with the existing `.lazy`: `data-model="query.trim.lazy"`. Form-input boilerplate (manual coercion in `defineFn`) is now unnecessary in 80%+ of cases.
- **`data-action` event modifiers: `.self`, `.capture`, `.passive`.** `.self` fires only when `event.target` is the bound element (skips bubbled events); `.capture` and `.passive` map directly to `addEventListener` options. Capture/passive flags are matched at `removeEventListener` time so cleanup works cleanly.
- **`data-action` key modifiers: `.enter` / `.esc` / `.tab` / `.shift` / `.cmd`.** Key-match modifiers (`.enter` → `ev.key === 'Enter'`; same for `Escape`, `Tab`) and system-modifier-key gates (`.shift` → `ev.shiftKey`; `.cmd` → `ev.metaKey`). Chainable: `keydown.shift.enter` fires only on Shift+Enter. Forms and modal dialogs no longer need a custom `defineFn` for "submit on Enter" / "cancel on Esc".

### Changed

- **README "What it doesn't do" rewritten as "explicit non-goals".** Per the 1.0 review's "be louder" point: SSR, components, transitions, router, store all get one-line bullets calling out the deliberate stance. The intent: orgs that need any of these rule Spektrum out fast instead of discovering the limitation late.
- **Size budget bumped to 11264 raw / 5184 gzip** (was 10240 / 4672) to absorb the 1.0-credibility batch. The five additions collectively cost ~860 B raw / ~360 B gzip — substantial but proportionate to the user-facing surface they unlock. Pre-bump trims (RESERVED keyword/operator entries removed earlier) had already been applied. Bundle now 11103 raw / 5031 gzip.

### Changed

- **`RESERVED` identifier set further trimmed.** Dropped the keyword/operator forms (`typeof`, `instanceof`, `in`, `new`, `delete`, `void`, `this`) — they're unlikely path heads in real templates, and audit F-12 explicitly classifies the over-subscription this would now allow as benign (extra never-firing subscriptions, not wrong output). Net: ~56 B raw / ~26 B gzip recovered to absorb the eager-`computed` change without bumping the size budget. Bundle now 10221 raw / 4647 gzip.

### Added

- **`data-cloak` attribute** for FOUC suppression (Vue's `v-cloak` / Alpine's `x-cloak` shape). `bindDOM` strips `data-cloak` from the bound root and all descendants once every binding has rendered. Pair with a CSS rule (`[data-cloak] { visibility: hidden }` or `display: none`) to hide elements that would otherwise paint `{{count}}` literally for one frame before binding kicks in. Author convention — the engine just removes the attribute; the CSS does the actual hiding. ~80 B raw / ~25 B gzip; documented in README and exercised by the example. 3 new tests.
- **Minified builds for the runtime helpers.** `npm run build` now emits `spektrum-persist.min.js` (~970 B raw / ~510 B gzip) and `spektrum-devtools.min.js` (~2.9 KB raw / ~1.5 KB gzip) alongside the existing `spektrum.min.js`. The build-time-only `spektrum-compile.js` stays un-minified — it's read by developers writing their own build scripts. `scripts/size.js` now budgets all three files independently (caps: `1024/576`, `3072/1536`, plus the existing `10240/4672`).
- **`unpkg` and `jsdelivr` package fields** point at `spektrum.min.js`. `https://unpkg.com/spektrum` and `https://cdn.jsdelivr.net/npm/spektrum` now serve the minified entry by default — no path needed for casual `<script type="module">` imports. Old explicit paths still work.
- **README CDN section rewritten** with three concrete patterns: direct `<script type="module">` imports, importmap-with-named-specifiers (the cleanest no-build form), and version-pinning + provenance for production. Examples use unversioned `https://unpkg.com/spektrum` for casual demos and `@<version>` placeholders for the pinning recipe (don't bake stale numbers into the docs).

### Fixed (example, post-0.4.1)

- **Demo: forks now survive scrubbing the timeline.** The previous wiring used the `onFork` hook to mirror `instance.forks` into `appStateDelta.forkSummary` — but `replay()` clears `appState`, and `onFork` only fires on `record()`, never on `replay`. Mirror moved into the seed system, which runs both on every relevant state change AND on replay's force-refresh. `data-key="f.ts"` added to the forks list so keyed reconciliation reuses rows across re-mirrors. Engine untouched; example-only fix shipped to `main` after `0.4.1`.

## [0.4.1] — 2026-05-06

### Changed

- **`extractPaths` strips string literals before identifier scanning** (audit finding F-12). An expression like `kind === 'foo' ? 'a' : 'b'` previously registered `kind`, `foo`, `a`, AND `b` as watched dependencies — harmless (extra ticks, never wrong output) but noisy on subscriber-counting telemetry. Now only `kind` is registered. The strip is a single regex pass over double-quoted, single-quoted, and template-literal contents (replaced with empty string literals before identifier matching). Crude: `\"` escapes inside a literal aren't honored — at worst, prior over-subscription returns for pathological input. Both modes are benign.
- **`history` trim is now amortized** via a chunk-based drop step (audit finding F-13). When `historyLimit` is set and overflow happens, we drop `chunk = max(1, historyLimit >>> 4)` entries at a time instead of trimming exactly to `historyLimit`. Per-record overflow cost amortizes from `O(historyLimit)` to `O(historyLimit / chunk)`. **Behavior unchanged for `historyLimit ≤ 16`** (chunk = 1 → trim to exact limit on every overflow). For larger caps, `history.length` lands at `historyLimit - chunk + 1` after each trim and grows back to `historyLimit` over `chunk` pushes — the exact length now oscillates within a `chunk`-sized window. Cursor and snapshot indices follow the trim. The cap remains a hard ceiling: `history.length` never exceeds `historyLimit`.
- **`walkTextNodes` is now iterative** with an explicit `Array` stack (audit finding F-18). Pathological template depths can no longer blow the JS engine call stack. Realistic templates never approach the limit; this is defensive only. Visit order unchanged (left-to-right depth-first).
- **Size budget gzip cap bumped to 4672** (was 4608). The three Low-priority audit cleanups above collectively crossed the prior gzip ceiling by ~30 B. Trims tried first: `walkTextNodes` inlined `childNodes` access, F-12 regex inlined into `extractPaths`. Raw cap unchanged at 10240 — bundle is now 10151 raw / 4633 gzip.
- **Source-line tightening across the engine.** `applyEntry`'s add-branch now uses an `??` chain (one fewer local, three fewer lines, ~16 B raw saved). JSDoc preambles trimmed across `bindEach`, `serialize`, `checkpoint`, `record`, `replay`, `resetState`/`reset`, `evalExpr`, and `deepMerge` — long-form narration that duplicated the README moved out, the WHY notes that explain non-obvious decisions stayed. Total: 107 fewer source lines (1035 → 927) with no behavior change. The README "lines of actual code" claim now reads "under 1000 lines (engine source)".

### Fixed

- **Demo: undo button no longer stuck disabled** after clicks. `seedCounter` and `seedBasket` were direct-mutating `appState.atSeed`, which bypasses delta fan-out — the `:disabled="atSeed"` binding only refreshed when `replay()`'s force-refresh ran (i.e. on scrub or reload). They now write `atSeed` through the delta, so a normal click fans out correctly. Engine behavior unchanged; this was an example-app misuse of the system signature. Comment updated to flag the gotcha for future readers.

### Added (example)

- **Demo: `data-model="path.lazy"` on the count input and the per-item note input.** Free-form typing no longer floods history with per-keystroke entries — commits land on blur/Enter. The basket filter input stays eager (live filtering is the desired UX). Demonstrates the 0.3.6 modifier on its home turf (a time-travel app).
- **Demo: visual "discarded futures" panel** below each panel. When the user scrubs back and mutates, the dropped tail is captured on `spektrum.forks` and rendered as a compact list ("3 edits forked · restore"). The `restore` button rewinds to `fork.forkedAt` and re-applies the dropped entries; the diverging tail becomes a *new* fork (every divergence preserved exactly once). Wired via the `onFork` hook mirroring a summary into `appStateDelta` so the `data-each="forkSummary"` binding fans out reactively. ~30 lines of glue in `example/app.js`, no engine change.

## [0.4.0] — 2026-05-06

### Added

- **`spektrum.checkpoint(name, metadata?)`** — first-class history marker (proposed-improvements #2). Records a tagged history entry (`op: 'checkpoint'`) with no state effect; `replay()` walks past it unchanged. Use to mark logically atomic boundaries (a search completes, a form submits, a multi-step wizard finishes a step) so the app can replay to the *end* of that span without inventing a sentinel pattern. Fires `onRecord` (so `autoSave` catches it). Companion `spektrum.checkpoints` getter returns each checkpoint entry augmented with its history index — replay-to-checkpoint is one line: `spektrum.replay(spektrum.checkpoints.find(c => c.id === name).index + 1)`. Persisted via `spektrum/persist` (`loadHistory` recognises and re-applies `op: 'checkpoint'`). The devtools panel renders checkpoints with a `◆` marker so they're scannable in the scrubber log.
- **`data-stable-key` opt-in on keyed `data-each`** (RFC §1 Option B, F-6). Skips path rewriting on the cloned subtree and reuses the *same* clone across reorder via `insertBefore`. Reorder is then genuinely free of UX cost — focus, scroll, selection, and uncommitted input value survive moves. Author opts in by promising the row's bindings don't reference `varName.*` paths; the engine scans the template at bind time and warns if they do (`[spektrum] data-stable-key but template references "row"`). When the promise holds, the historical "moved row loses focus / input value / scroll" trade-off is gone for that list.
- **Append/pop tail diff for non-keyed `data-each`** (RFC §1 Option C, F-8). When the array's prefix is identity-stable (same item references), push/pop now appends or removes only the tail instead of full rebuild. Covers the 90% case (chat logs, append-only feeds) at no API cost. Interior changes still trigger full rebuild — the same primitive that existed before. Heuristic is `===` over the shared prefix; deep-equal would be too expensive and most apps either reuse references (the fast path) or actively rebuild (the slow path) anyway.
- **Structured `onError` payload** (audit-final RFC §2 Phase 1, agentic foundation). Engine-thrown errors now carry an `err.code` discriminator so apps and agentic tooling can branch on root cause without pattern-matching the message. Initial closed enum: `E_TICK_OVERFLOW` (the existing 1024-iter bail). User-thrown errors from system functions pass through unchanged (no `code`) — the engine never replaces a user error with a synthetic one. Future codes added per release with an explicit CHANGELOG entry.
- **`spektrum.serialize(opts?)` method** (audit-final RFC §2 Phase 1). Returns a portable JSON snapshot for SSR injection, hydration, debug captures, or off-engine inspection. Default includes `state` + `history` + `cursor` (replay-able via `loadHistory`); pass `{ includeHistory: false }` for state-only, `{ includeForks: true }` to also include preserved fork tails (debug-only — `loadHistory` doesn't replay forks).

### Changed

- **Size budget bumped to 10240 raw / 4608 gzip** (was 9472 / 4224). The five 0.4.0 features collectively added ~890 B raw / ~390 B gzip — about 3× the conservative estimate for the list-rendering opt-ins (the prefix-scan loop, the dev-mode foot-gun warn, and clone-reuse bookkeeping cost more in real bytes than projected). Pre-bump trims (`RESERVED` set, `KNOWN_MODIFIERS` regex) recovered ~170 B; the rest required the cap raise. Bundle is now 10059 raw / 4566 gzip. Per the standing rule: trim before raising. Both were applied here.
- **`RESERVED` identifier set further trimmed** to free byte budget. Already trimmed in 0.3.6; same behavior-neutral classification (audit-final F-12) — over-subscription to non-existent paths is harmless (extra ticks, not wrong output).
- **`KNOWN_MODIFIERS` is now a regex** (`/^(prevent|stop|once)$/`) instead of a `Set`. ~15 B saved per minified output. Behavior identical.
- **README size claim updated** from "~8 kB minified" to "~10 kB minified (4.5 kB gzipped), ~700 lines of actual code". Same posture (audit-it-in-an-afternoon), bigger surface.

## [0.3.6] — 2026-05-06

### Added

- **`event` as the 5th argument to `data-fn` handlers** (proposed-improvements #4). Event-driven `data-action="click"`-style bindings now pass the DOM `Event` to handlers as `(el, state, delta, value, event)`. `data-action="cycle"` passes `undefined` for the 5th arg (no event in scope). Backward-compatible — existing 4-arg handlers ignore the extra parameter. Unlocks `event.target`/`event.submitter`/`event.key`/etc. in `defineFn` handlers without dropping to manual `addEventListener`. Type updated; bundle size unchanged.
- **`data-model="path.lazy"` modifier** (proposed-improvements #1). Commits element → state on the `change` event instead of `input`. Useful for search boxes and time-travel apps where per-keystroke writes flood `history` and fork it on every edit. State → element direction is unchanged (still updates each tick). Bare `data-model="path"` keeps current behavior. The `.lazy` suffix is reserved; if your state genuinely has a `lazy` leaf, route through `data-action="input"` + `data-fn="setValue"` instead.
- **`resetState()` method** (proposed-improvements #5). Wipes runtime state — `appState`, `appStateDelta`, `refs`, `history`, `snapshots`, `forks`, the `bindDOM` idempotency tracker — but **preserves** registered systems, `defineFn` entries, and hook registrations. `spektrum/persist`'s `loadHistory` now uses `resetState()` internally (was `reset()`), so app-level systems registered before `loadHistory` survive the load. Fixes a real bug a downstream user hit (hourly-weather): systems silently detached on every reload.

### Changed

- **`reset()` now warns when called with active systems** (proposed-improvements #5). The detach is intentional (`reset()` clears systems by design), but silent detachment had bitten users who assumed it was state-only — most visibly via `loadHistory`. The warn message (`reset() dropped N system(s); see resetState`) points at `resetState()` as the alternative. Suppress in test cleanup by mocking `console.warn` around the call.
- **`RESERVED` identifier set trimmed** to free ~150B raw / ~70B gzip for the 0.3.6 additions while staying within the 9472/4224 size budget. Dropped: `RegExp`, `Error`, `Map`, `Set`, `Symbol`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI`. Behavior change is benign: templates referencing these globals still work (`with(state)` falls through to the global scope), they just register a never-firing subscription to a path like `parseInt.something` — the audit's F-12 explicitly classifies this kind of over-subscription as harmless (extra ticks, not wrong output). If a path-extractor over-subscription bites you, register the global on `appState` directly.

### Fixed

- **README sharpened on three documented trade-offs.**
  - Precompile wording (I-2): added a callout that `precompile()` removes the *runtime* `new Function` requirement (CSP-friendliness) but does **not** change the trust model — `with(state)` and the `constructor.constructor` escape are still reachable in author-written templates.
  - `data-each` table row (F-15): forward-references the "rewriteScope rewrites string literals" trade-off so authors hit the foot-gun warning at the directive table, not just in the trade-offs section.
  - `computed` semantics (F-14): added a concrete code example showing the "prior committed value" claim, plus explicit guidance to read computed values from the subscriber's state argument or after `tick()` returns.

## [0.3.5] — 2026-05-06

### Changed

- **Tick fan-out overflow now routes through `onError`** (audit finding F-9). When a tick exceeds 1024 iterations (runaway feedback cycle), Spektrum builds an `Error('tick: max iterations exceeded')` and fires it via `onError(err, null)` — the second arg is `null` because there's no specific system to point at. Without a handler, the fallback is still `console.warn`. Lets apps surface the bail to telemetry / dev overlays instead of losing the signal in the console.
- **Single-handler hooks now warn on overwrite** (audit finding F-16). `onError`, `onRecord`, `onFork`, and `defineFn` previously replaced existing handlers silently — which let `autoSave` quietly steal `onRecord` from the host app. Calling them with a non-null value when the slot is already non-null now logs `[spektrum] <name> overwritten`. Pass `null` first to clear without warning.
- **Unknown `data-action` modifiers now warn at bind time** (audit finding F-17). `data-action="click.preventdefault"` (typo for `.prevent`) used to fall through silently as a plain click. The bind-time scan now logs `[spektrum] unknown data-action modifier .preventdefault`. Recognised modifiers: `.prevent`, `.stop`, `.once`.
- **Internal `console.warn` calls factored through a tiny `warn(msg)` helper** that prepends the `[spektrum]` namespace. Cosmetic — removes the duplicated prefix and saves bytes after minification.
- **Size budget bumped to 9472 raw / 4224 gzip** (was 9216 / 4096) to absorb the four PR3 features cleanly. Bundle is now 9145 raw / 4158 gzip.

### Security

- **Dev dependency bumps** (audit finding F-11). `@happy-dom/global-registrator` `^15.0.0` → `^20.9.0` (closes the VM-context-escape RCE plus two more critical advisories: cookie-origin leak in fetch credentials, ECMAScript module compiler eval injection). `esbuild` `^0.24.0` → `^0.25.0`. `npm audit` now reports zero vulnerabilities. Note: the `:class object form toggles individual classes` test was rewritten to spy on `classList.toggle` calls instead of reading classList state, because happy-dom ≥ 16 has a regression where `classList.toggle(name, force)` is a silent no-op on elements carrying a `:class` attribute (real browsers handle the unknown attribute fine).

## [0.3.4] — 2026-05-06

### Changed

- **Node engine bumped to `>=22`** (from `>=20`). Node 20 reached end-of-life on 2026-04-30; the maintained LTS lines are now Node 22 (Active LTS) and Node 24 (current LTS). The engine code itself doesn't use any Node-22-only feature, so anyone on 20 can keep running it from source — but `npm install spektrum` will refuse below 22 from this version on.
- **CI publish workflow runs on Node 24 LTS** and uses `actions/checkout@v6` + `actions/setup-node@v6` (both Node-24 native). Removes the "Node 20 actions deprecated" annotation that 0.3.3 emitted.

## [0.3.3] — 2026-05-06

This release bundles the security work originally drafted as 0.3.2 (see below) with the reset-leak fix, the new publish workflow, and the persist/devtools test-coverage push. 0.3.2 has its own CHANGELOG entry below for reference; no tarball was published with that version — its commits flowed into 0.3.3 directly.

### Fixed

- **`reset()` now drains DOM listeners before clearing state** (audit finding F-5). Previously, `reset()` cleared `appState`, `history`, `systems`, and the `boundRoots` idempotency tracker — but the `input`/`change` listener attached by `data-model` and the click listener attached by `data-action` stayed bound to their elements. A subsequent `bindDOM()` on the same root attached a *second* listener, so one click fired the handler twice; load-bearing for any flow that exercises time-travel or fork-replay. Cleanups now register into an instance-level `Set` that `reset()` drains before wiping state. Calling cleanups twice is safe (`removeEventListener` is idempotent), so existing destroy() callers keep working unchanged.

### Added

- **Tag-only npm publish workflow with `--provenance`** (audit finding F-7). `.github/workflows/publish.yml` triggers on a `v*` tag push, runs `lint` / `test` / `build` / `size` against a clean `npm ci` install, then publishes with `--provenance --access public`. Auth via `NPM_TOKEN` secret; OIDC `id-token: write` enables the provenance attestation independent of publish auth. Restores the supply-chain signal that 0.3.1's "drop CI" change traded away. Manual local checks remain the dev workflow; CI is publish-only.
- **Test coverage on the optional subpath modules** (audit finding F-10). New `spektrum-persist.test.js` (14 tests covering `saveHistory` / `loadHistory` / `autoSave` round-trip, shape validation, debounce, stop-detach) and `spektrum-devtools.test.js` (11 tests covering `mount`, scrubber → `replay`, live → head, **HTML-escape XSS regression**, truncation, unmount). Coverage on these files went from 78% / 0% line, 33% / 0% function → **100% line and 100% function on both**, with branch coverage ≥ 92%. The 82% per-file coverage bar is now met everywhere.
- All four security fixes originally drafted as 0.3.2 — see the 0.3.2 entry below for F-1 / F-2 / F-3 / F-4 details. They shipped in this tarball.

## [0.3.2] — 2026-05-06 *(superseded by 0.3.3 — never published as a tarball)*

This entry exists for record-keeping. The audit's plan was to ship security fixes as a focused 0.3.2 patch, then reset-leak + provenance as 0.3.3. We bundled both into 0.3.3 (Path A from the release plan) once we had a working publish workflow, so no `spektrum@0.3.2` tarball ever reached npm. The version skip is intentional and consistent with semver — patch numbers are not required to be contiguous.

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

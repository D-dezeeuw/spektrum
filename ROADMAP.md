# Roadmap

What is planned, what is deliberately not, and how stable the surface is. This is a direction document, not a delivery commitment — dates are absent on purpose.

For the non-negotiables that gate every item here, see [`docs/constraints.md`](docs/constraints.md). For what Spektrum will never do, see [`docs/philosophy.md`](docs/philosophy.md).

---

## Hard constraints on everything below

Two rules bind every item on this page. They are not trade-offs to be weighed per feature — an item that cannot fit them does not ship, however useful it would be.

**1. Zero dependencies. No exceptions.**

No `dependencies` in `package.json`, ever. The single permitted use of another library anywhere in this project is **benchmarking against it** — a comparison harness may install Alpine, petite-vue, or whatever it measures, because measuring a competitor requires having it. That allowance does not extend to build tooling, test helpers, or "it's only a devDependency."

Practical consequences for the items below:

- The **build-tool integration** ships as a separate build-time package that treats Vite/esbuild/Rollup as a *peer* the user already has. Nothing is added to this package, and the engine never gains a build step.
- The **benchmark harness** is the one place a comparison library may appear, and it stays out of the published tarball via the `files` allowlist.
- Anything else that "just needs one small library" gets written by hand or dropped. The seeded PRNG in `tests/spektrum.properties.test.js` is the pattern: ~30 lines instead of a fuzzing dependency.

**2. Size budgets are hard limits, not targets.**

The caps in [`scripts/size.js`](scripts/size.js) are a gate, not a guideline. A change that does not fit is trimmed until it does, or it is not merged. **Raising a cap requires explicit maintainer sign-off** — it is not a step an implementer may take on their own initiative, no matter how well-documented the rationale.

This is stricter than the historical practice recorded in `scripts/size.js`, where caps were raised alongside the feature that needed them. That log stays for the archaeology, but the policy going forward is: trim, or ask.

---

## Stability commitment

Spektrum follows [semver](https://semver.org/). Concretely:

| Surface | Stability |
|---|---|
| Engine exports (`setValue`, `bindDOM`, `tick`, `replay`, `describe`, …) | **Stable.** Breaking changes require a major. |
| Directives (`{{…}}`, `:attr`, `data-*`) | **Stable.** New directives are minors; changed semantics are majors. |
| Agent surface (`describe`, `explain`, `attempt`, `findByIntent`) | **Stable**, with the documented caveat that `explain().triggers` reflects the current subscriber registry. |
| Companion APIs (`spektrum/persist`, `/mcp`, `/compile`, …) | **Stable**, but security-relevant defaults may tighten in a minor — see below. |
| Dev-only companions (`/devtools`, `/inspect`, `/agent`, `/dock`) | **Best-effort.** UI and internal DOM shape may change in a minor. |
| Anything not exported | Not API. |

**Security defaults may tighten in a minor release.** This has happened twice: 1.1.0 flipped agent writes to deny-by-default, and the guard-hardening batch made read-only cover the timeline. The reasoning is that shipping a safe default early beats semver purity while adoption is small. Both were documented in the changelog with the opt-in flag to restore prior behavior. Once adoption is broad enough that this trade stops being obviously correct, it stops.

---

## Near term

- **Build-tool integration for the CSP path.** A Vite (then esbuild / Rollup) plugin wrapping `extractExpressions` / `emitPrecompileSource`. Ships as a **separate** build-time package that declares the bundler as a peer dependency the user already has — this package gains nothing, and the engine still needs no build step. Today strict-CSP users write their own build script.
- **Published benchmarks.** A pinned harness comparing bind time, update throughput, memory, and bundle size against Alpine and petite-vue on a common workload — including where those win. This is the **only** place another library may be installed (see hard constraints above); it stays out of the published tarball.
- **Directive-complete example.** The demo omits the `<template data-each>` form, scope variables, `.number` / `.trim` model modifiers, `data-action="cycle"`, and the `computed` / `addAsync` / `attempt` APIs.
- **Hosted demo** on the existing Pages pipeline.

## Under consideration

These are not committed; each has an open design question.

- **Faithful replay across tick batching.** `replay()` applies one entry per tick, but a run that batched several writes into one tick can produce different state, because the delta collapses repeated writes before merging and a plain-object source *merges* rather than replaces. Pinned in `tests/spektrum.properties.test.js`. A real fix needs the delta to distinguish "whole value written" from "sub-path scaffolding", which costs bytes and touches the core write path.
- **Write-path tracking so `setValue(path, undefined)` notifies.** Today `tick()` selects systems by whether a path *resolves* in the delta, so clearing with `undefined` is silent (`null` works). Documented in [trade-offs](docs/trade-offs.md); a fix means a parallel structure threaded through write, merge, and replay.
- **Read fencing for agents.** `protectedPaths` is a write fence only. A `redactPaths` option would need to apply uniformly across `getState` / `serialize` / `describe` / `explain` — a half-fence is worse than none.
- **Expression-cache configuration.** No lever today for apps minting expressions dynamically. Awaiting a real use case.

## Not planned

Deliberate non-goals — see [philosophy](docs/philosophy.md) for the full reasoning.

- A virtual DOM, proxy-based auto-tracking reactivity, or runtime CSS generation.
- SSR / hydration.
- A router, a state-management "ecosystem", or official UI components.
- Runtime dependencies. Ever. (See hard constraints — the only permitted use of another library anywhere in the project is benchmarking against it.)
- Sandboxed template expressions. Templates are author-written; this is the same trust model as Vue and Alpine.
- Any feature that needs a size-budget increase to fit. The budget decides; the feature adapts.

---

## Project shape

Spektrum is maintained by one person. That is worth saying plainly rather than implying otherwise with plural pronouns:

- **Bus factor is 1.** If that is disqualifying for your use case, it should be — the code is MIT and vendorable (one file, zero deps), which is the intended mitigation.
- **Review capacity is limited.** Small, focused PRs with tests get merged; large refactors will sit.
- The fastest way to change this list is to open an issue describing a real use case. Concrete beats speculative.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow.

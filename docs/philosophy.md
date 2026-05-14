# Philosophy

## Engine in three sentences

Mutations write into an append-only `appStateDelta`. Each tick drains the delta to quiescence: systems whose subscribed paths appear in the delta run, the delta merges into committed `appState` and is cleared, and any new writes during system execution kick off another pass — that's how fan-out works. Every mutation is recorded in `history` so `replay(n)` can rebuild any past point.

That's the whole engine. The rest is convenience.

## Non-goals — what Spektrum deliberately doesn't do

If any of these are deal-breakers for your project, **rule Spektrum out now** rather than discover it late:

- **No SSR or hydration.** Client-only. The engine assumes a real DOM at bind time. Some orgs need server-rendered initial state for SEO or first-paint — Spektrum won't deliver that.
- **No components or slots.** Compose via JS factories (`createSpektrum()`, plain functions that return DOM templates) — this is a deliberate stance, like Alpine. If you want `<MyButton>`-style template authoring, reach for Vue or Lit.
- **No transitions system.** Use CSS classes + `:class="…"` for state-driven transitions; Spektrum gives you the binding, the browser does the animation.
- **No router or store layer.** Engine, not framework. Bring your own routing (or use the `data-model`/`computed` primitives to roll a hash-based one in ~20 lines). State is just `appState` — no stores, no slices.
- **Templates are author-written.** Expressions execute via `new Function` unless precompiled (same caveat as Vue/Alpine — don't accept untrusted templates). See [trade-offs](trade-offs.md#expressions-use-withstate-inside-new-function).

## Design constraints

Every line of code in Spektrum was added against these constraints. Each constraint is a deliberate filter that has rejected features.

- **Single file engine.** ~1100 lines. The whole thing fits in your head — and in any LLM's context window in one read.
- **Zero runtime dependencies.** Forever. The dev deps are `esbuild` and `eslint`; both are optional for users.
- **Size budget enforced at CI.** Engine cap is ~11.5 KB minified / ~5.2 KB gzipped. Bumps are documented in [scripts/size.js](../scripts/size.js); each is one-shot, justified by a named feature.
- **No CSS-in-JS, no virtual DOM, no proxies on hot paths.** The engine uses `Object.keys` traversal, regex matchers, and a hand-written iterative tree walker. Boring, fast, and visible.
- **Deterministic + synchronous test surface.** `tick()`, `reset()`, `replay()` are public, synchronous, and deterministic. No mocks, no fake timers, no awaiting microtasks. If a test needs async, it's because the user code under test is async — never because of the engine.
- **Auditability over abstraction.** Every non-obvious decision in the source has a comment explaining *why*, not what. Comments are bytes the bundle has to carry; we accept the cost because the engine's pitch is "read it in an afternoon."

## What's coming

`data-schema` and the optional `test()` harness from the parked Phase 2 RFC. `data-intent` shipped in 1.0 as the foundation of the agent-native surface (see [AGENTS.md](../AGENTS.md)). Deferred items wait on usage data — we ship features when the use case is named, not because they sound nice.

## Repository layout

| Path | What |
| --- | --- |
| [`spektrum.js`](../spektrum.js) | The engine. ES module. Single file at root. |
| [`spektrum.d.ts`](../spektrum.d.ts) | TypeScript declarations. |
| [`companions/`](../companions/) | Opt-in subpath modules — `devtools`, `persist`, `compile`, `mcp`, `agent`, `inspect`, `dock`. Each is a single file. |
| [`tests/`](../tests/) | Engine + DOM tests (`node --test`, happy-dom). One file per concern. |
| [`example/`](../example/) | Demo page (`index.html` + `app.js`) — declarative bindings using every feature, two isolated Spektrum instances. |
| [`docs/`](../docs/) | Reference + topical guides, plus the agent workflow at [`../AGENTS.md`](../AGENTS.md). |
| [`scripts/size.js`](../scripts/size.js) | Zero-dep size budget enforcer. |

## Related

- [Public API](api.md)
- [Bindings](bindings.md)
- [Trade-offs](trade-offs.md) — the deliberate compromises behind the design

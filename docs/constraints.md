# Constraints

The non-negotiables. Every line of code in Spektrum is filtered through these — they are deliberate gates that have rejected features. If a proposed change can't fit through them, it doesn't ship, no matter how reasonable it sounds in isolation.

This page complements [philosophy.md](philosophy.md), which covers the *vision* (time-travel as a primitive, agent-native surface, "engine in three sentences"). Constraints are how that vision survives contact with feature requests.

---

## Single-file engine

The whole engine is one file: [`spektrum.js`](../spektrum.js), ~1100 lines including comments. No internal module boundaries, no build step required to read it, no jumping between files to follow a code path.

**Why it matters.** The pitch is *"read it in an afternoon"* — and the entire engine fits in any LLM's context window in one tool call. Both audiences (humans auditing, agents reasoning) get the complete picture in one read. A multi-file engine forces both to chase imports.

**What this rules out.** Internal module splits, plugin boundaries inside core, separate "core" / "runtime" / "compiler" packages. Optional functionality lives in **subpath companions** (`spektrum/devtools`, `spektrum/persist`, `spektrum/compile`, `spektrum/mcp`, `spektrum/agent`) — see [modules.md](modules.md) — never inside the core file.

---

## Zero runtime dependencies — forever

No `dependencies` in `package.json`. Ever. The only `devDependencies` are `esbuild` (for the minified bundle) and `eslint` (for linting) — both optional for users; you can use Spektrum without either.

**Why it matters.** A reactive engine that pulls in transitive packages can't credibly claim auditability. Every dep is something a security reviewer has to assess, a CSP policy has to allow, an SRI hash has to cover. Zero deps means the SHA-256 of `spektrum.min.js` is the entire trust boundary.

**What this rules out.** "Just add lodash for one helper." Polyfills bundled into core. Build-time codegen that bakes external libraries in. If a feature needs a dependency, it lives outside the engine.

---

## Size budget enforced at CI

Engine cap: **~11.5 KB minified, ~5.2 KB gzipped**. The budget is asserted in [`scripts/size.js`](../scripts/size.js) and runs as part of `npm run size` — CI fails if a change pushes the bundle over.

**Why it matters.** The budget is what keeps every other constraint honest. Without it, "just one more helper" compounds until the single-file claim becomes a 30 KB monolith and the agent-context claim no longer holds. Bytes are the currency every feature pays in.

**What this rules out.** Most. Concretely: features that cost more than ~200 B minified need a named, justified use case. Bumps to the cap itself are one-shot, documented in [`scripts/size.js`](../scripts/size.js), and tied to a specific shipped feature — never speculative headroom.

---

## No CSS-in-JS, no virtual DOM, no proxies on hot paths

The engine traverses with `Object.keys`, matches with regex, and walks the DOM with a hand-written iterative tree walker ([`walkTextNodes`](../spektrum.js#L204) in `spektrum.js`). No reactive proxy traps, no VDOM diffing, no styled-components-style runtime CSS generation.

**Why it matters.** All three of those abstractions are popular *because* they look ergonomic — and all three carry costs (size, debuggability, mental-model complexity) that conflict with the single-file / size-budget / auditability constraints. Boring code is visible code: you can step through the engine in DevTools and the call stack matches the source.

**What this rules out.** Vue-style auto-tracking reactivity (proxies on state reads). React-style render-and-diff (VDOM). Runtime CSS generation. Authors get reactivity through explicit subscriptions (`addSystem` / `computed`) and the declarative directives — no magic.

---

## Deterministic and synchronous test surface

`tick()`, `reset()`, `replay()`, `bindDOM()`, `setValue()`, `trigger()` are all public, synchronous, and deterministic. The test suite uses `node --test` with `happy-dom` — no mocks, no fake timers, no awaiting microtasks for engine behavior.

**Why it matters.** Determinism is what makes time-travel meaningful: `replay(n)` returns to *the same* state every time, every test run. If `tick()` resolved asynchronously, every test would race; if `setValue` deferred to a microtask, `replay` would have to model that. Sync + deterministic also means agents reasoning about a sequence of actions get the same result the user does.

**What this rules out.** Async-by-default mutators. Hidden microtask scheduling. Engine behavior that requires `await` to observe. (User code can be async — `addAsync`, `defineFn` handlers — but the engine's reaction to it is sync.)

---

## Auditability over abstraction

Source comments explain *why*, not *what*. Every non-obvious decision has a `// …` paragraph nearby covering the constraint, the rejected alternative, or the bug that motivated it. Examples: the `rewriteScope` regex word-boundary discussion at [spektrum.js:680](../spektrum.js#L680), the `data-each` keyed-vs-stable-key trade-off at [spektrum.js:691](../spektrum.js#L691), the `tick()` 1024-iteration cap rationale at [spektrum.js:447](../spektrum.js#L447).

Comments are bytes the bundle carries. We accept the cost.

**Why it matters.** "Read it in an afternoon" requires that the *non-obvious parts* are commented — otherwise the reader hits a clever line, can't tell whether it's clever or wrong, and stops trusting the engine. The same applies to an AI agent reading the source: comments tell it what's intentional vs. accidental.

**What this rules out.** Clever-and-uncommented one-liners. "Self-documenting" code as a substitute for explaining a design choice. Removing comments to win bytes back (the budget is for code; comments are a separate, accepted cost).

---

## Templates are author-written

Expressions in `{{…}}`, `:attr`, `data-if`, `data-each` keys, and `data-action` modifiers execute via `new Function` unless precompiled. This is the **same trust model as Vue and Alpine**: templates are code the author wrote, not user input.

For strict-CSP environments where `new Function` is unavailable, the [`spektrum/compile`](csp.md) companion precompiles every expression at build time so the runtime cache hits before `new Function` is ever reached.

**Why it matters.** Allowing untrusted templates would force the engine to sandbox expressions — which means either shipping a sandboxed evaluator (size budget says no) or restricting expressions to a safe subset (loses Vue-parity ergonomics). Neither is worth the cost when the realistic threat model is "the developer wrote the templates."

**What this rules out.** Accepting templates from users / network / database without precompiling. CMS scenarios where end-users author templates need `spektrum/compile` in front, not the engine alone.

---

## What the constraints rule in

These restrictions exist to protect a small set of properties. When evaluating a proposed change, the question is whether it preserves all of them:

- **Drop-in** — works in a plain HTML file, a WordPress theme, a CMS block, a browser extension, anywhere you can write a `<script type="module">`. Single-file + zero-deps + size budget is what enables this.
- **Auditable** — one file, every non-obvious line commented. A security reviewer can assess the engine in one sitting; an AI agent can read it in one tool call.
- **Time-travel** — every mutation recorded; `replay(n)` rebuilds any past point. Determinism + sync mutators is what makes this trustworthy.
- **CSP-safe** — strict-CSP works via `spektrum/compile`. Zero deps means no transitive `unsafe-eval` requirement.
- **Agent-native** — `describe()` returns the complete operational manifest. Single-file + auditable is what lets an agent reason about the whole engine, not just call into it.

A change that breaks any of these doesn't ship — even if it would be locally useful.

---

## Related

- [Philosophy](philosophy.md) — vision, non-goals, the engine in three sentences
- [Trade-offs](trade-offs.md) — specific design compromises (e.g. `rewriteScope`, keyed reconciliation modes, `with(state)`)
- [Subpath modules](modules.md) — where opt-in functionality lives, since it can't live in core
- [CSP guide](csp.md) — how `spektrum/compile` works around `new Function`

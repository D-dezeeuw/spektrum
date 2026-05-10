# Known trade-offs

Things people sometimes flag as bugs that are deliberate, with the reasoning. If your case doesn't fit the rationale, file an issue — these are choices, not stone tablets.

## Expressions use `with(state)` inside `new Function`

Templates compile to `new Function('state', 'with (state) { return (expr); }')`. Two consequences worth knowing:

- **Sloppy mode applies automatically.** `new Function` always creates a function whose body is in sloppy mode unless the body itself opens with `'use strict'` — regardless of the calling module's strictness. `with` is therefore valid even when Spektrum is loaded from a strict ESM module. Verified against Node ≥ 20 and every supported browser.
- **Templates are author-written, like Vue and Alpine.** Don't compile templates from untrusted input. The constructor-escape pattern (`constructor.constructor("…")()`) is reachable from inside an expression, but only by someone authoring the template — they're already running their own code on the page. The same trust requirement applies even after `spektrum/compile`: precompiling removes the runtime `new Function` (helpful for strict CSP), it does not remove the requirement that templates be authored by you.

Why we keep `with`: a `Proxy`-based sandbox costs ~150 minified bytes and a per-eval allocation while solving a non-problem inside the stated trust model. The same is true of every alternative we evaluated.

## `data-each` re-clones moved items (default keyed mode)

Paths inside a `data-each` template are baked into each clone at clone time — `{{user.name}}` rewrites to `{{users.0.name}}` for index 0, `{{users.1.name}}` for index 1, etc. When an item changes index, its clone's bindings still read the old path, so the engine throws the clone away and builds a fresh one. UX cost: focus, scroll, selection, and any uncommitted input value in the *moved* row are lost. Items that stay put pay zero.

Why we keep this default: the rewrite is a regex one-pass instead of a tokenizer, and unmoved items (the common case) have zero cost.

**Opt-out:** `data-stable-key` (presence flag) on a keyed `data-each` skips path rewriting and reuses the same clone across reorder. The contract is that the row's bindings don't reference `varName.*` paths — they read outer-scope state, or render pure presentation. The engine scans the template at bind time and warns if a binding references the loop variable while `data-stable-key` is set:

```text
[spektrum] data-stable-key but template references "user"
```

Use `data-stable-key` when the rows are pure presentation (display the same outer state) or when the per-row bindings come exclusively from outer scope. Reorder is then genuinely free.

## `data-each` without `data-key` rebuilds the whole list

Same root cause as above: paths are baked, so any structural change re-clones. Same fix scheduled for 0.4.0.

## `rewriteScope` rewrites string literals too

Inside a `data-each` template, the rewriter doesn't distinguish code positions from string literals. Writing `{{ "user.name" }}` produces a literal that becomes `"users.0.name"` per row. A real tokenizer would fix this; the size cost is more than the foot-gun is worth.

Workaround: write expressions that return values, not strings that mention bound paths.

## `computed` writes into the delta, not state

A computed value lands in `appStateDelta` during the tick that recomputes it, and merges into `appState` when that tick commits. Mid-tick reads of the same path therefore see the *prior committed* value, not the value the current pass is producing. After `tick()` returns, both reads agree.

```js
computed('total', ['cart.items'], (s) => s.cart.items.reduce((a, x) => a + x.price, 0));
setValue('cart.items', [{price: 10}, {price: 5}]);
// During the tick this triggered, a system reading appState.total still
// sees the previous value (or undefined). After tick() returns, both
// appState.total and (a stateSnapshot read) return 15.
```

Read computed values from the snapshot/state passed to your subscriber, or after `tick()` has returned to the caller. Anything reactive sees the new value via the delta on the next pass — that's the design, not a bug.

The same wrinkle applies to `addAsync`: the synchronous portion of its fn body (everything before the first `await`) sees pre-tick state, since the value you just wrote with `setValue` lives in the delta until `tick()` commits. Call `spektrum.tick()` between a `setValue` and an `addAsync` if the fn body needs the just-written value.

Why we keep this: it matches the engine's commit-on-tick model. Treating the delta as the single write target keeps the `appState ⊕ appStateDelta` invariant simple to reason about.

## `history.splice(0, n)` on `historyLimit` overflow is O(n)

When `historyLimit` is set and the buffer overflows, the oldest entries get spliced off — O(n) on the array length. At the history sizes real apps reach (low thousands), the cost is negligible. An offset-pointer rewrite is queued behind every other priority.

## `walkTextNodes` is recursive

(Historical: now iterative, with an explicit stack — see [spektrum.js:206-213](../spektrum.js#L206-L213).) Realistic templates do not approach JS engine stack depth.

## Performance characteristics

- `replay` without `snapshotEvery` is O(n) per scrub; with snapshots, O(n mod K).
- `bindDOM` walks every text node for `{{...}}`. One-shot at boot, not a hot path.
- `tick()` filter is O(systems × paths-per-system) per pass. Fine at small scale; build a path-index if you have hundreds of systems.
- Tick fan-out is bounded to 1024 iterations; deeper feedback loops route through `onError` (with `null` for the system arg) and bail. Without an `onError` handler, the fallback is `console.warn`.
- `historyLimit` caps memory at the cost of unbounded scrubback — replay below the surviving window is undefined.

## Related

- [Public API](api.md) — error handling, `onError` codes
- [Time-travel](time-travel.md) — how `historyLimit` and `snapshotEvery` interact
- [CSP-safe deployments](csp.md) — `with(state)` after precompile

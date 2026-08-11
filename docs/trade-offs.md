# Known trade-offs

Things people sometimes flag as bugs that are deliberate, with the reasoning. If your case doesn't fit the rationale, file an issue — these are choices, not stone tablets.

## Expressions use `with (state) with (scope)` inside `new Function`

Templates compile to `new Function('state', 'scope', 'with (state) with (scope||{}) { return (expr); }')`. Outer `with` puts state on the scope chain; inner `with` adds the per-iteration scope from a `data-each` (loop variable, `$index`, `$first`, `$last`, `$path`). Inner-most wins on collision, so a loop variable like `data-as="user"` shadows a state key named `user` for the duration of the iteration — that's the intended semantics, not a footgun.

This shadowing order is part of the expression contract, not an implementation detail: `spektrum/compile` reproduces it without `with` (see [CSP-safe deployments](csp.md)), and any hand-written `precompile()` function must too.

- **Sloppy mode applies automatically.** `new Function` always creates a function whose body is in sloppy mode unless the body itself opens with `'use strict'` — regardless of the calling module's strictness. `with` is therefore valid even when Spektrum is loaded from a strict ESM module. Verified against Node ≥ 20 and every supported browser.
- **Templates are author-written, like Vue and Alpine.** Don't compile templates from untrusted input. The constructor-escape pattern (`constructor.constructor("…")()`) is reachable from inside an expression, but only by someone authoring the template — they're already running their own code on the page. The same trust requirement applies even after `spektrum/compile`: precompiling removes the runtime `new Function` (helpful for strict CSP), it does not remove the requirement that templates be authored by you.

Why we keep `with`: a `Proxy`-based sandbox costs ~150 minified bytes and a per-eval allocation while solving a non-problem inside the stated trust model. The same is true of every alternative we evaluated.

## `data-each` without `data-key` rebuilds the whole list on interior change

The no-key path uses a shared-prefix tail diff: append-only and pop-tail changes are O(delta), but any change to an interior item (or an out-of-order swap) wipes and rebuilds. Add `data-key="item.id"` for keyed reconciliation with O(moves) reorder.

## Setting a value to `undefined` does not fire subscribers

`tick()` decides which systems to run by testing whether a subscribed path *resolves* in the delta (`isPath(appStateDelta, path)`). A write of `undefined` is therefore indistinguishable from "this path isn't in the delta at all" — the value merges into `appState`, but nothing re-renders and the DOM keeps showing the old value indefinitely.

```js
setValue('msg', 'visible');
tick();                      // <p>{{msg}}</p> renders "visible"
setValue('msg', undefined);
tick();                      // appState.msg is undefined — the <p> still shows "visible"
```

**Use `null` to clear a value.** `null` resolves, so subscribers fire and bindings re-render (`{{msg}}` renders as an empty string, same as `undefined` would).

This also applies to object fields: publishing `{...row}` with a key omitted leaves that path absent from the delta, so a binding on it won't re-run on that write alone.

Why we keep this: the alternative is tracking *written paths* separately from the delta's shape, which means a parallel structure threaded through every write, merge, and replay path. That's a real cost against the size budget for a case a one-character change (`null`) already covers.

## `computed` writes to both state and the delta

A computed value is written to `appStateDelta` *and* directly into `appState` in the same derivation. The state write gives read-through: a system running after the derivation in the same pass reads the fresh value from `state`. The delta write keeps fan-out working: systems subscribed to the computed path still fire on the next pass.

```js
computed('total', ['cart.items'], (s) => s.cart.items.reduce((a, x) => a + x.price, 0));
setValue('cart.items', [{price: 10}, {price: 5}]);
tick();
// During that tick, a system running after the derivation already read
// state.total === 15; systems subscribed to 'total' fired on the next
// pass; after tick() returns, appState.total === 15 for everyone.
```

The wrinkle that remains is about *plain* writes, not computed ones: `setValue` lands only in the delta until `tick()` commits, so synchronous code that runs before the tick — e.g. the portion of an `addAsync` fn body before its first `await` — still sees pre-write state. Call `spektrum.tick()` between a `setValue` and an `addAsync` registration whose fn body needs the just-written value.

Why we keep this: plain mutators writing only the delta is what keeps the `appState ⊕ appStateDelta` commit-on-tick invariant simple, and the dual write in `computed` exists precisely because derived values are read mid-tick by sibling systems — without the read-through, every consumer would be one pass behind.

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
- [CSP-safe deployments](csp.md) — how precompiled expressions reproduce the scope contract

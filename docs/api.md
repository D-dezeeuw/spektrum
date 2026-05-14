# Public API

Everything the engine exports. Type signatures live in [spektrum.d.ts](../spektrum.d.ts).

## Imports

```js
import spektrum, {
  // state (objects mutable; cursor/replaying are getters on the default instance)
  appState, appStateDelta, history, snapshots, forks, refs, intents,
  // mutators
  trigger, setValue, checkpoint, addAsync, refresh,
  // derived state
  computed,
  // subscriptions & hooks
  addSystem, watch, removeSystem, defineFn, onError, onRecord, onFork,
  // lifecycle
  bindDOM, run, tick, replay, reset, resetState, serialize,
  // agent surface
  describe, explain, attempt, findByIntent,
  // utility
  getPathObj, setPathValue,
  // CSP-safe precompile registry
  precompile,
  // factory for multiple instances
  createSpektrum,
} from 'spektrum';

// Read live cursor / replaying via the default instance.
spektrum.cursor;     // current history position
spektrum.replaying;  // true while replay() is in flight
```

## Reading state

`appState` is a stable, live reference — the same object throughout the lifetime of the instance. Mutations land in `appStateDelta` first, then merge into `appState` on each `tick()`. Import it and read directly any time:

```js
import { appState, defineFn } from 'spektrum';

defineFn('save', async (el) => {
  await api.put('/user', appState.user);   // always current
});
```

There is no `getState()` accessor — the exported reference *is* the accessor. For event-based `data-fn` handlers, the `state` arg passed to your handler is the same live reference (cycle-based handlers receive a snapshot — see [bindings](bindings.md#handler-state-argument)).

For derived values that need to re-compute on dep change, use `computed(path, deps, fn)` rather than recomputing on every read; it writes the result back into state so bindings stay reactive.

## Refetching async resources

`addAsync(path, fn)` returns the run function for refetching, and is also indexed by `path` so `refresh(path)` works without retaining the handle:

```js
import { addAsync, refresh } from 'spektrum';

const refetch = addAsync('user', () => fetch('/api/user').then(r => r.json()));

await refetch();          // re-run via the returned handle
await refresh('user');    // re-run via the keyed registry — same effect
```

`refresh(path)` returns the run Promise, or `undefined` when the path was never registered. See [bindings — async resources](bindings.md#async-resources) for the binding shape.

## Multiple isolated instances

`createSpektrum(opts)` returns an instance with the same API, fully separate from the default singleton and from any other instance.

```js
const app = createSpektrum({
  historyLimit: 1000,    // cap recorded mutations; oldest drop on overflow
  snapshotEvery: 50,     // capture appState every 50 entries → O(K) replay
  forkLimit: 50,         // cap preserved fork tails; oldest drop on overflow
});
```

Use this for two reactive areas on one page (the demo runs counter + basket as separate instances), or any test that needs isolation.

## Error handling

```js
spektrum.onError((err, systemFn) => {
  // Surface to your app: telemetry, toast, dev overlay, etc.
  console.error('system failed:', err);
});
```

Without a handler, throwing systems fall through to `console.error`. The engine itself never crashes — one bad system doesn't abort the rest of the tick.

**Structured engine errors.** Errors raised by the engine itself (not by user systems) carry a `code` discriminator so apps and agentic tooling can branch on root cause without pattern-matching the message:

```js
spektrum.onError((err, systemFn) => {
  if (err.code === 'E_TICK_OVERFLOW') metrics.increment('spektrum.tick_overflow');
  else if (systemFn) reportSystemFailure(systemFn.name, err);
  else console.error('[spektrum]', err);
});
```

Current codes: `E_TICK_OVERFLOW` (tick fan-out exceeded 1024 iterations; delta discarded). User-thrown errors from systems pass through unannotated — same identity as the throwing code produced.

## Serializing state

`serialize(opts?)` returns a portable JSON snapshot, useful for SSR injection, debug captures, or off-engine inspection:

```js
const json = spektrum.serialize();
// { state, history, cursor }  — replay-able from a fresh instance via loadHistory

const stateOnly = spektrum.serialize({ includeHistory: false });
// { state }  — portable, no time-travel context

const debugDump = spektrum.serialize({ includeForks: true });
// { state, history, cursor, forks }  — for snapshots in error reports
```

Pairs with `spektrum/persist` — write the serialized output into a `<script type="application/json">` for SSR hydration, or hand it to your error reporter. Forks aren't replay-restored by `loadHistory` (they're a debug surface, not portable history); only include them when you need them.

## Lifecycle: `reset()` vs `resetState()`

Two ways to wipe runtime state, with different scopes:

- **`resetState()`** clears `appState`, `appStateDelta`, `refs`, `history`, `snapshots`, `forks`, and the `bindDOM` idempotency tracker. **Preserves** registered systems, `defineFn` entries, and hook registrations (`onError`, `onRecord`, `onFork`). Use this when you're swapping the data set under a running app — `spektrum/persist`'s `loadHistory` calls it internally.
- **`reset()`** does everything `resetState()` does *and* clears systems. Built-in fns and hook registrations still survive. Calling it with active systems emits a `[spektrum] reset() dropped N system(s); see resetState` warning — the warn is there because silent detachment has bitten users who assumed `reset()` was state-only. Use `resetState()` instead when you only want to wipe state.

Built-in `data-fn` handlers (`trigger`, `setValue`, `setText`, `setStyle`, `toggle`) are re-registered on every `createSpektrum()`; they survive both reset paths.

## Agent surface — quick reference

The four agent-facing methods, briefly. See [AGENTS.md](../AGENTS.md) for the workflow tutorial.

### `describe()`

Returns the operational manifest — current state, registered systems and their subscribed paths, defined fns and their declared schemas, named refs, registered intents, checkpoints, and history shape. The single best first call for an agent orienting itself.

### `explain(opts?)`

Causal trace over a slice of history. Each entry is annotated with the systems whose subscriptions intersect its path. `opts: { from?: number, to?: number }`. The `triggers` field reflects the *current* subscriber registry, not a historical record of who actually fired.

### `attempt(name, fn)`

Speculative execution. Drops a checkpoint, runs `fn`, returns a handle:

```js
const h = spektrum.attempt('apply-edit', () => {
  spektrum.setValue('user.email', proposedEmail);
  return validateUser(spektrum.appState.user);   // sync or Promise
});
if (await h.result) h.commit(); else h.discard();
```

`commit()` records an `<name>:commit` checkpoint. `discard()` rewinds the cursor; the speculative entries land on `forks` on the next mutation.

### `findByIntent(name)`

Returns elements with `data-intent="<name>"`. Returns a copy so iteration doesn't race the registry.

### `defineFn(name, fn, meta?)`

Optional `meta` ({ description, input, output, examples }) attaches a schema to the handler so `describe()` returns a self-describing verb catalog.

```js
spektrum.defineFn('addToCart', (el, state, delta, value) => {
  setValue('cart.items', [...state.cart.items, value]);
}, {
  description: 'Append a product to the cart',
  input:  { type: 'object', properties: { id: { type: 'string' }, price: { type: 'number' } }, required: ['id', 'price'] },
  output: { type: 'object', properties: { cursor: { type: 'integer' } } },
  examples: [{ id: 'sku-42', price: 19.99 }],
});
```

Backwards compatible — `defineFn(name, fn)` still works.

## TypeScript

The package ships [`spektrum.d.ts`](../spektrum.d.ts) and `package.json` points to it via the `types` field — TypeScript and JS-with-`// @ts-check` projects pick it up automatically on `import 'spektrum'`. No `@types/spektrum` package needed; nothing to install.

```ts
import spektrum, {
  setValue, addAsync, defineFn,
  createSpektrum, type Spektrum, type State, type FnMeta,
} from 'spektrum';

interface AppState extends State {
  count: number;
  user?: { id: string; email: string };
}

// Cast appState to your app's shape for autocomplete inside handlers.
const app = createSpektrum() as Spektrum & { appState: AppState };

defineFn('inc', (el, state) => {
  setValue('count', (state as AppState).count + 1);
});
```

Every export carries a JSDoc-style block in the d.ts (signature, behavior, replay semantics, edge cases). When you change a public surface in `spektrum.js`, update `spektrum.d.ts` in the same commit — see [CONTRIBUTING.md](../CONTRIBUTING.md). The d.ts is the contract; reviewers will ask you to keep it in sync.

**Out of scope (deliberately).** Template-literal types over state paths (so `setValue('user.email', …)` could narrow against `AppState`) would be powerful but conflict with the dynamic-`with(state)` expression engine. The current d.ts types paths as `string`. Pass your shape through your handlers if you want stricter checking inside them.

## Related

- [Bindings](bindings.md) — declarative HTML directives that hook into the API
- [Time-travel](time-travel.md) — `replay`, `checkpoint`, `forks`, `snapshots`
- [Modules](modules.md) — `spektrum/devtools`, `persist`, `compile`, `mcp`, `agent`, `inspect`, `dock`
- [AGENTS.md](../AGENTS.md) — agent workflow tutorial
- [TypeScript declarations](../spektrum.d.ts) — full type surface

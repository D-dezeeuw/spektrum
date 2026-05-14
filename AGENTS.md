# AGENTS.md — driving Spektrum as an AI agent

A short, opinionated tutorial for the **agentic workflow**: how an AI agent reads, understands, and operates a running Spektrum app, and how you (the human author) make your app maximally agent-friendly.

> Two audiences, one doc:
> - **You're the agent (or writing one)** — skip to [Workflow](#workflow). Spektrum gives you a complete operational manifest in one call (`describe()`), causal traces (`explain()`), speculative execution (`attempt()`), and semantic UI lookup (`findByIntent()`). Time-travel is a primitive, not a devtool — every mutation you make is replayable and forkable.
> - **You're shipping a Spektrum app you want agents to drive** — skip to [Author checklist](#author-checklist-make-your-app-agent-ready). It's three small additions to markup + JS.

The [demo app](example/) is wired with all of this. Open the page, then open devtools console and try the recipes below against `window.spektrum.counter` and `window.spektrum.basket`.

---

## Why Spektrum for agents

Other engines treat agent-friendliness as an afterthought. Spektrum's foundations were already aligned:

| Property | Why an agent cares |
| --- | --- |
| ~1100 LOC, single file | The entire engine fits in your context window. One Read tool call and you've grokked the runtime. |
| `setValue('user.email', 'x')` | Path-based mutation is structured data — far easier for an LLM to synthesize than `setState(prev => ({...}))`. |
| Time-travel built into the primitive | Try an edit, evaluate, roll back. Every move is replayable. Discarded branches survive on `forks`. |
| Declarative HTML bindings | `data-action="submit.prevent"` and `data-intent="checkout.submit"` tell you what an element does without reading JS. |
| `onRecord` hook | A supervisor (human or agent) sees every mutation through one callback. |
| Errors with `code` discriminators | `err.code === 'E_TICK_OVERFLOW'` is a machine surface, not a string to grep. |

Add the 1.0 agent surface (`describe`, `explain`, `attempt`, `data-intent`, defineFn metadata, `spektrum/mcp`, `spektrum/agent`) and you have everything an agent needs to operate the app like a first-class user.

---

## Workflow

### 1. Orient — `describe()`

The single best first call. Returns a complete manifest in one cheap read.

```js
const m = spektrum.describe();
// {
//   state, cursor, historyLength, forkCount, snapshotCount, options,
//   systems: [{ paths, name }, ...],
//   fns:     [{ name, description, input, output, examples }, ...],
//   refs:    ['filterInput', ...],
//   intents: { 'basket.add': 4, 'basket.remove': 3, 'counter.undo': 1, ... },
//   checkpoints: [{ id, index }, ...],
// }
```

What you can do with this in one call:
- See the **state shape** (what data exists, what paths to write to)
- See the **registered verbs** (`fns`) with their schemas — your action vocabulary
- See the **subscribed systems** (which paths trigger what derived behavior)
- See the **semantic UI inventory** (`intents`) — what verbs the UI exposes
- See the **history shape** — how much you can scrub back, where checkpoints sit

### 2. Read state — `appState` / `serialize()`

`appState` is a plain object, mutable, but **don't write to it directly** — go through `setValue` so changes land in history.

```js
spektrum.appState                                 // current committed state
spektrum.serialize()                              // { state, history, cursor } as JSON string
spektrum.serialize({ includeHistory: false })     // state-only snapshot
spektrum.serialize({ includeForks: true })        // include discarded branches
```

For most agent reads, `appState` directly is enough. Use `serialize()` when you need a portable snapshot to send somewhere (your supervisor, a tool result, error report).

### 3. Locate UI — `findByIntent()`

Selector-based UI lookup is brittle when an LLM is generating it. `data-intent` is the semantic alternative.

```js
spektrum.findByIntent('basket.add')
// → [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement, HTMLButtonElement]
//   (the four fruit buttons in the demo)

spektrum.findByIntent('counter.undo')
// → [HTMLButtonElement]

spektrum.findByIntent('does.not.exist')
// → []
```

Multiple elements can share an intent. `describe().intents` shows you the catalog (intent → element count) so you know what verbs the UI exposes.

To **trigger** UI: don't synthesize click events — call the underlying state mutator directly (next step). UI events are cosmetic; state is the source of truth.

### 4. Mutate — `setValue` / `trigger`

Two recorded write primitives, both round-trip through history.

```js
spektrum.setValue('user.email', 'alice@example.com');     // absolute write
spektrum.setValue('cart.items', [...]);                   // overwrites whole value at path
spektrum.trigger('inc', 'count', 1);                      // additive numeric (accumulates in one tick)
spektrum.checkpoint('after-edit', { actor: 'agent-1' });  // tagged marker, no state effect
```

Every call records into `history`. The next `tick()` (or animation frame, if `run()` is active) drains the delta and fires subscribed systems.

**Don't write directly to `appState`** for anything you want replayable, persistable, or observable by the supervisor. Direct writes are appropriate only for defaults set inside a system (the demo does this in `seedCounter` / `seedBasket`).

### 5. Speculate — `attempt()`

The agentic pattern. Try a change, evaluate the outcome, decide whether to keep it.

```js
const handle = spektrum.attempt('parse-user-input', () => {
  spektrum.setValue('user.name',  parsedName);
  spektrum.setValue('user.email', parsedEmail);
  return validateUser(spektrum.appState.user);   // sync or Promise
});

const ok = await handle.result;                  // works for both sync + async
if (ok) handle.commit();                          // marks an "<name>:commit" checkpoint
else    handle.discard();                         // rewinds; entries land on `forks` next mutation
```

Worth knowing:
- The fn runs **immediately** — `result` is whatever you returned (often a Promise the caller awaits).
- `commit()` records a `<name>:commit` checkpoint so your trace is readable later.
- `discard()` rewinds the cursor only. The speculative entries don't disappear — they sit at the head of `history` until the next real mutation, at which point the engine truncates them and pushes them onto `forks`. Inspect `forks` if you want to see what trajectories you tried and discarded.
- Nested attempts are fine. They stack via checkpoints.

### 6. Explain — `explain()`

When you (or your supervisor) want to know **why state moved**:

```js
spektrum.explain({ from: lastSeenCursor })
// [
//   { index: 12, op: 'set', path: 'cart.items', value: [...], id: 'set:cart.items',
//     triggers: ['recomputeTotal', 'persistCart'] },
//   { index: 13, op: 'set', path: 'cart.total', value: 99,
//     triggers: ['updateCheckoutButton'] },
//   ...
// ]
```

`triggers` is the list of system names whose subscribed paths intersect each entry's path. **Caveat:** it reflects the *current* subscriber registry, not a historical record of who actually fired. For typical agent use (explaining recent edits) the two coincide. If you've rewired systems mid-session and are explaining old history, document this in your prompt.

### 7. Time-travel — `replay()`, `checkpoints`, `forks`

```js
spektrum.replay(0)                       // back to the very start
spektrum.replay(spektrum.cursor - 5)     // step back 5
spektrum.replay(spektrum.history.length) // jump to head ("live")

const cp = spektrum.checkpoints.find(c => c.id === 'after-edit');
spektrum.replay(cp.index + 1);            // jump to right after a named checkpoint

spektrum.forks                            // discarded branches you can re-apply
```

Replay is **idempotent** and **deterministic**. With `snapshotEvery: K` set on the instance, replay is O(K) instead of O(n) — practically free even for long histories.

### 8a. Easiest path — `spektrum/agent` (in-page LLM, three providers)

Skip MCP entirely if you just want an agent driving your Spektrum app inside the browser. `spektrum/agent` mounts a floating chat panel that runs an LLM directly against the engine. No server, no transport, no infra — just a fetch to the chosen provider's API.

```js
import spektrum from 'spektrum';
import { mount } from 'spektrum/agent';

mount(spektrum, {
  provider: 'anthropic',         // 'anthropic' | 'openai' | 'openrouter'
  apiKey:   '<key>',             // optional — panel prompts via ⚙ on first use
  model:    'claude-haiku-4-5',  // optional — provider default applies
  position: 'bottom-left',
});
```

The panel is wired with the same `createTools(spektrum)` catalog the MCP module uses, so the agent has the full surface: `getState`, `describe`, `explain`, `setValue`, `trigger`, `checkpoint`, `attempt`, `replay`, `findByIntent`, `serialize`. Every tool call renders in the chat log — full transparency.

**Three providers, one panel.** Click the ⚙ in the panel header to switch between Anthropic, OpenAI, and OpenRouter. Keys and per-provider models are stored separately in `localStorage` so switching doesn't lose anything.

| Provider | Default model | Notes |
| --- | --- | --- |
| `anthropic` | `claude-haiku-4-5` | Native tool format. Direct browser use enabled via `anthropic-dangerous-direct-browser-access`. |
| `openai` | `gpt-4o-mini` | Internal translation to OpenAI's chat-completions shape. CORS posture varies; if blocked, switch to OpenRouter. |
| `openrouter` | `anthropic/claude-sonnet-4.6` | OpenAI-compatible proxy in front of dozens of providers. Most reliable for direct browser use. |

Use this when:
- You're prototyping or building a dev tool
- The app is internal / behind auth and you trust the user with their own API key
- You want zero infra

Don't use this when:
- The app is public-facing (proxy through your own backend instead — don't expose API keys to browsers)
- You need the agent to drive multiple browser tabs or remote instances (use MCP + a bridge)

### 8b. Wire MCP — `spektrum/mcp`

If your agent speaks MCP (Claude Desktop, Cursor, an in-app supervisor, an orchestrator like Mastra/LangGraph), drop in the catalog:

```js
import spektrum from 'spektrum';
import { createTools } from 'spektrum/mcp';

const tools = createTools(spektrum);
// → [{ name: 'spektrum.getState', description, inputSchema, handler }, ...]
//   12 tools covering the full agent surface
```

`tools[].handler` is plain async JS — wire it into your MCP server SDK of choice. Spektrum has zero MCP SDK dependency; the boundary is clean.

The catalog covers: `getState`, `describe`, `explain`, `setValue`, `trigger`, `checkpoint`, `attempt.start`/`.commit`/`.discard`, `replay`, `findByIntent`, `serialize`. Every agent-driven mutation lands in history exactly like a human's would — replayable, forkable, supervisable.

---

## End-to-end recipe (against the demo basket)

The demo's basket panel is wired with intents and fn metadata. Open <http://127.0.0.1:8088/example/>, open devtools console, and walk through this:

```js
// 1. Orient
const b = window.spektrum.basket;
const m = b.describe();
console.table(m.fns);                    // ['addKind', 'removeAt', 'undo', 'restoreFork', ...]
console.table(m.intents);                // { 'basket.add': 4, 'basket.remove': N, 'basket.filter': 1 }

// 2. Read current state
b.appState.items                          // current basket contents
b.appState.filter                         // current filter string

// 3. Locate UI by intent (so you can describe what's available to the user)
b.findByIntent('basket.add').map(el => el.dataset.name)
// → ['🍎 apple', '🍌 banana', '🍇 grapes', '🥭 mango']

// 4. Speculative add: try a hypothetical purchase, validate, commit or roll back
const cursorBefore = b.cursor;
const h = b.attempt('agent-suggest-banana-trio', () => {
  for (let i = 0; i < 3; i++) {
    b.setValue('items', [...(b.appState.items || []), { id: 1000 + i, label: '🍌 banana', note: 'agent suggestion' }]);
  }
  return b.appState.items;
});
console.log('after attempt:', h.result.length, 'items');

// 5. Explain what just happened
console.table(b.explain({ from: cursorBefore }));
//   path           value                     triggers
//   set:items      [...]                     seedBasket
//   set:items      [...]                     seedBasket
//   set:items      [...]                     seedBasket

// 6. Decide. The user actually wanted apples — discard.
h.discard();
b.appState.items   // back to what it was before the attempt
b.forks            // the speculative trajectory is preserved here

// 7. Mark a logical boundary so future explain() calls have a landmark
b.checkpoint('agent-decided-against-bananas', { reason: 'user wanted apples' });
b.checkpoints      // [..., { id: 'agent-decided-against-bananas', index: ... }]

// 8. Do the right thing instead
b.setValue('items', [...(b.appState.items || []), { id: 9999, label: '🍎 apple', note: '' }]);

// 9. Snapshot the whole session for the supervisor / error report
const snapshot = b.serialize({ includeForks: true });
// JSON string — pass to your reporting tool, save to localStorage, etc.
```

This is the entire vocabulary. Orient → read → speculate → explain → commit/discard → snapshot. No selectors, no DOM events, no awaiting microtasks.

---

## Author checklist — make your app agent-ready

You have a Spektrum app and you want agents to drive it well. Three additions:

### ✅ 1. Add `data-intent` to interactive elements

Every button, link, or input an agent might want to find by purpose gets a semantic intent.

```html
<button data-intent="checkout.submit"
        data-action="click" data-fn="checkout">Pay</button>
<button data-intent="checkout.cancel"
        data-action="click" data-fn="cancel">Cancel</button>
<input  data-intent="search.query"
        data-model="query" placeholder="search…">
```

Naming convention: `noun.verb` or `domain.action`. Stable across renames — selectors change, intents shouldn't. Multiple elements can share an intent (e.g. four "add to basket" buttons in the demo).

### ✅ 2. Pass metadata to `defineFn`

Every custom verb your app exposes should declare what it does and what it expects. Surfaced via `describe()` so agents see the catalog without reading source.

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

JSON Schema is the conventional shape for `input` / `output`, but the field is free-form — use whatever your agent's tool layer expects.

### ✅ 3. Expose the instance for MCP (when applicable)

If you want an agent to drive your app over MCP:

```js
import { createTools } from 'spektrum/mcp';
import spektrum from 'spektrum';

// Your MCP server SDK — pseudocode
const server = new MCPServer({ name: 'my-app' });
for (const t of createTools(spektrum)) {
  server.tool(t.name, t.description, t.inputSchema, t.handler);
}
server.listen();
```

For in-page agents (an agent that lives inside the browser tab), just expose `spektrum` on `window` — the demo does this with `window.spektrum = { counter, basket }`.

### Optional but recommended

- **Name your systems and fns.** `addSystem(['cart.items'], function recomputeTotal() {...})` is a richer trace surface than `addSystem(['cart.items'], () => {...})`. `describe()` and `explain()` both surface the function name.
- **Use `checkpoint(name, metadata)` at logical boundaries** — search complete, form submitted, agent turn done. Lets the supervisor scrub by event, not by raw entry index.
- **Set `snapshotEvery` on long-running instances.** Replay stays O(K). Cheap insurance.
- **Set `onRecord` to feed your supervisor.** One callback, every mutation, regardless of whether it came from a user click or an agent tool call.

---

## Trust model — what hasn't changed

The agent surface gives an agent the same authority any caller of `setValue` / `trigger` has. **It doesn't add a sandbox.** Specifically:

- Don't expose the MCP catalog to an untrusted agent on an untrusted transport. Local stdio MCP, internal tools, in-page supervisors — fine. Open to the internet without auth — not fine.
- Templates are still author-written, even with `spektrum/compile`. Don't compile agent-generated templates from untrusted text — the eval model (`with(state)` inside `new Function`) is unchanged.
- `attempt().discard()` rewinds the cursor. It does **not** undo side effects your fn caused outside the engine (network calls, console output, third-party state). Speculative execution is for engine state, not the world.
- The MCP `attempt.start` tool keeps the speculative handle in a server-side map keyed by attempt id. If your server restarts mid-attempt, the handle is lost — discard manually via `replay(cursorBefore)` if needed.

---

## Reference

| Topic | Where |
| --- | --- |
| Engine source | [spektrum.js](spektrum.js) — read it. ~1100 lines. |
| Type definitions | [spektrum.d.ts](spektrum.d.ts) — `Spektrum`, `SpektrumManifest`, `ExplainedEntry`, `AttemptHandle`, `FnMeta`. |
| MCP tool factory | [companions/spektrum-mcp.js](companions/spektrum-mcp.js) — twelve tools, plain JS, SDK-agnostic. |
| Wired demo | [example/](example/) — open in a browser, then `window.spektrum.{counter,basket}` in devtools. |
| Full README | [README.md](README.md) — design philosophy, all directives, time-travel internals. |

If you're an agent reading this and you've gotten this far: you have everything you need. Open `describe()` against the running instance and start there.

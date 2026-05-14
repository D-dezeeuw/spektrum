# Subpath modules

Spektrum ships seven optional companion modules. Pull in only what you need; nothing leaks into the core bundle.

| Import | Purpose | Size (min/gz) |
| --- | --- | --- |
| [`spektrum/devtools`](#spektrumdevtools) | Floating scrubber panel — rewind, replay, watch state move | ~3.2 KB / 1.6 KB |
| [`spektrum/persist`](#spektrumpersist) | `saveHistory` / `loadHistory` over localStorage (or any Storage-shaped backend) | ~1.0 KB / 0.5 KB |
| [`spektrum/compile`](#spektrumcompile) | Build-time helper that scans templates and emits a `precompile()` module for strict-CSP deployments | (build-time only) |
| [`spektrum/mcp`](#spektrummcp) | SDK-agnostic MCP tool catalog — exposes the agent surface for orchestrators | ~5.1 KB / 2.0 KB |
| [`spektrum/agent`](#spektrumagent) | In-page LLM assistant. Mount a chat panel that drives the engine via the agent surface | ~12 KB / 4.8 KB |
| [`spektrum/inspect`](#spektruminspect) | Developer-time DX panel: hover-to-inspect element bindings, mutation tracer, static lint | ~10 KB / 4.0 KB |
| [`spektrum/dock`](#spektrumdock) | Shared container that hosts the dev companions as tabs in one cohesive UI | ~5.1 KB / 2.0 KB |

Quick sample wiring two of them up:

```js
import { mount as mountDevtools } from 'spektrum/devtools';
mountDevtools(spektrum);                                 // { position: 'top-right' } etc.

import { saveHistory, loadHistory, autoSave } from 'spektrum/persist';
loadHistory(spektrum);                                   // restore on boot
autoSave(spektrum, { debounce: 200 });                   // save on every mutation
```

---

## `spektrum/devtools`

Floating panel with a slider over `history`. Drag it to scrub state through every recorded mutation. Click "live" to jump to head. The panel is dev-only — drop it from production builds.

```js
import { mount } from 'spektrum/devtools';
const unmount = mount(spektrum, {
  position: 'bottom-right',     // 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  parent: document.body,         // any Element
  title: 'spektrum',             // header label
});
unmount();                        // remove the panel
```

Renders checkpoint entries with a `◆` accent so they stand out in the scrubber log. See [time-travel](time-travel.md) for the underlying primitives.

---

## `spektrum/persist`

Save and restore `history` to a Web Storage-shaped backend (localStorage, sessionStorage, or a custom `{ getItem, setItem }` pair).

```js
import { saveHistory, loadHistory, autoSave } from 'spektrum/persist';

loadHistory(spektrum);                          // restore on boot
saveHistory(spektrum);                          // explicit save

const stop = autoSave(spektrum, {
  debounce: 200,                                 // coalesce rapid mutations
  key: 'myapp:history',                          // default 'spektrum:history'
  storage: customStorage,                        // default localStorage
});
stop();                                          // detach the autoSave hook
```

`loadHistory` validates each entry's shape (op, path, value types) and caps replay at `opts.maxEntries` (default 100,000) so an attacker-tampered storage value can't blow up the engine. Calls `resetState()` internally — preserves your registered systems and hooks.

`autoSave` registers an `onRecord` hook. Only one onRecord handler is active per instance at a time — calling `autoSave` replaces any prior hook. Use `onRecord` directly if you need to combine with other observers.

---

## `spektrum/compile`

Build-time scanner that walks an HTML string and emits a `precompile()` module covering every template expression. Use it for deployments behind a strict CSP that disables `unsafe-eval`.

See the dedicated [CSP-safe deployments](csp.md) page for the full workflow.

---

## `spektrum/mcp`

SDK-agnostic MCP tool catalog. `createTools(spektrum)` returns plain JS tool definitions (`{ name, description, inputSchema, handler }`) so you wire them into the MCP server SDK of your choice — stdio, HTTP, your agent framework's tool layer.

```js
import spektrum from 'spektrum';
import { createTools } from 'spektrum/mcp';

const tools = createTools(spektrum);
// → [{ name: 'spektrum.getState', description, inputSchema, handler }, …]

// Wire `tools[].handler` into your MCP server SDK as you would any other tool.
```

The catalog covers `getState`, `describe`, `explain`, `setValue`, `trigger`, `checkpoint`, `attempt.start` / `attempt.commit` / `attempt.discard`, `replay`, `findByIntent`, `serialize`. All routed through the public API, so every agent-driven mutation lands in history exactly like a human's would — replayable, forkable, supervisable.

**Three usage patterns:**

| Pattern | Where it runs | Notes |
| --- | --- | --- |
| In-page agent | Browser tab | No MCP server. Hand `tools` straight to your agent library. (Or use [`spektrum/agent`](#spektrumagent), which does this for you.) |
| Local stdio MCP server | Node process | Headless Spektrum + `@modelcontextprotocol/sdk` over stdio for Claude Desktop / Cursor / etc. |
| Browser app + Node bridge | Both | Bridge via WebSocket / CDP / extension. Not yet shipped — open an issue if you need it. |

---

## `spektrum/agent`

The simplest way to put an agent on a Spektrum app: a floating chat panel that runs an LLM inside the browser tab, with the full tool surface pre-wired. No MCP server, no bridge, no backend.

```js
import spektrum from 'spektrum';
import { mount } from 'spektrum/agent';

mount(spektrum, {
  provider: 'anthropic',           // optional — 'anthropic' | 'openai' | 'openrouter'
  apiKey:   '<key>',               // optional — panel prompts via ⚙ on first use
  model:    'claude-haiku-4-5',    // optional — provider-specific default applies
  position: 'bottom-left',
});
```

Reuses [`createTools()`](#spektrummcp) for the catalog, calls the chosen provider's API directly via `fetch`, runs the tool-use loop, and renders every tool call inline.

### Provider matrix

| Provider | Default model | Browser CORS | Notes |
| --- | --- | --- | --- |
| `anthropic` | `claude-haiku-4-5` | ✓ via `anthropic-dangerous-direct-browser-access` | Messages API. Native tool format. |
| `openai` | `gpt-4o-mini` | varies | Chat Completions API. Internal translation to/from OpenAI's shape. CORS posture changes over time — if blocked, switch to OpenRouter. |
| `openrouter` | `anthropic/claude-sonnet-4.6` | ✓ permissive | OpenAI-compatible proxy in front of dozens of model providers. Most reliable for direct browser use. Sends `HTTP-Referer` + `X-Title` for attribution. |

Switch providers from the panel's ⚙ button. Keys and per-provider model choices are stored separately in `localStorage` (`spektrum:agent:apikey:<provider>`, `spektrum:agent:model:<provider>`) so flipping back and forth doesn't lose your other keys.

### Security

If you don't pass `apiKey`, the panel shows a settings panel and stores entered keys in `localStorage`. **This is a development affordance.** Production deployments should proxy through your own backend; don't ship an API key to the browser. The panel makes this clear in its UI.

The agent has the same authority over the engine as any caller of `setValue` / `trigger`. It cannot escape into the wider page. But it CAN make any state mutation your app exposes — only mount it when you accept that.

### Demo

The wired demo has the agent mounted behind an "enable AI assistant" footer link (no surprise key prompt for visitors). Click it, pick a provider, paste a key, then ask: *"what does this app do?"* — the agent will call `spektrum_describe` and walk you through the basket. Try *"add three bananas"* or *"undo the last action"* to see tool calls happen live.

For the workflow tutorial, see [AGENTS.md](../AGENTS.md).

---

## `spektrum/inspect`

Developer-time DX panel. Mount it during local development to answer the questions that `console.warn` can't: *"what state does this element see?"*, *"which systems just fired in response to that mutation?"*, *"is anything binding `{{…}}` into an attribute where it doesn't work?"*. Read-only — no buttons mutate state.

```js
import { mount } from 'spektrum/inspect';
const unmount = mount(spektrum, {
  position: 'top-left',                          // auto-picks a free corner by default
  parent:   document.body,
  features: ['elements', 'mutations', 'lint'],   // subset of tabs (default: all three)
});
unmount();
```

**Three tabs.**

| Tab | What it does |
| --- | --- |
| **Elements** | Click *inspect element*, hover anything on the page → tooltip lists every binding (`:attr`, `{{…}}`, `data-each`/`-as`/`-key`, `data-if`, `data-model`, `data-ref`, `data-intent`, `data-action`/`-fn`/`-id`) with the current evaluated value for simple paths. Click to pin. `Esc` to exit. |
| **Mutations** | Live tail of every `onRecord` entry: path, op, value (truncated), and the names of systems whose subscriptions intersect the path. Filter by regex; pause / resume / clear. Bounded ring of 500 entries. |
| **Lint** | One-shot scan (re-runnable). Flags stray `{{…}}` in plain (non-`:`, non-`data-`) attribute values — the Vue/Alpine porter footgun — and `data-fn="name"` references where `name` isn't registered. |

**Devtools coexistence.** If you mount [`spektrum/devtools`](#spektrumdevtools) too, inspect auto-picks a corner that isn't already taken (devtools defaults to `bottom-right`; inspect will land in `top-left`). Pass `position:` explicitly to override.

**Programmatic helpers (no UI).** Useful in tests and for headless agents:

```js
import { readBindings, whoSubscribesTo, lint } from 'spektrum/inspect';

readBindings(el);                  // → [{ kind: 'attr', name: 'class', expr: 'theme' }, …]
whoSubscribesTo(spektrum, 'cart'); // → ['renderCart', 'recomputeShipping']
lint(spektrum, document.body);     // → [{ kind: 'warn', msg, el }, …]
```

**Multi-instance.** Call `mount(instance, opts)` once per instance you want to inspect. Each call adds its own panel; the shared stylesheet is injected once (deduped by attribute selector).

**Production.** Don't ship it. Same opt-in model as every other companion — production users who don't `import` it pay zero bytes.

---

## `spektrum/dock`

Shared container for the dev-time companions. Without a dock, each panel (devtools, inspect, agent) floats in its own corner — fine for one tool, cluttered with several. With a dock mounted, each companion *auto-detects it* and registers as a tab in one cohesive UI that can collapse to a chip, switch side (right ⇆ bottom), and close panels individually.

```js
import { mount as mountDock }     from 'spektrum/dock';
import { mount as mountDevtools } from 'spektrum/devtools';
import { mount as mountInspect }  from 'spektrum/inspect';
import { mount as mountAgent }    from 'spektrum/agent';

mountDock({ side: 'right', collapsed: false });   // mount FIRST
mountDevtools(spektrum);                          // → registers as "Devtools" tab
mountInspect(spektrum);                           // → registers as "Inspect" tab
mountAgent(spektrum, { provider: 'anthropic' });  // → registers as "Agent" tab
```

**Mount order matters.** Mount the dock *before* the companions you want inside it. Companions detect the dock at their own `mount()` time via a DOM query; if no dock is present, they fall back to free-floating panels (backward compatible — existing code keeps working without changes).

**Layout.**

| Side | Where it sits | Default size |
| --- | --- | --- |
| `right` (default) | Right edge, top-aligned | `min(420px, 100vw - 24px)` wide, `min(80vh, 100vh - 24px)` tall |
| `bottom` | Bottom edge, full width | `min(400px, 60vh)` tall |

Click the `⇆` button in the header to switch sides at runtime. Click `▾` to collapse to a small chip (showing a badge with the active-panel count); click the chip to expand. Each tab has its own `×` to close that companion (cascades to its `onClose` so the companion's listeners detach properly).

**Public API (rare to call directly — most users just mount + go).**

```js
const dock = mountDock();

const panel = dock.registerPanel({
  id: 'devtools',                       // unique key; re-register replaces
  label: 'Devtools',                    // tab text
  onClose: () => myCompanionUnmount(),  // fired when user clicks × on the tab
});
// panel: { container, activate(), detach(), close() }
// → render your UI into panel.container

panel.activate();                       // bring this tab forward
panel.detach();                         // remove tab + container (no onClose call — for your own unmount)
panel.close();                          // simulate user clicking × (fires onClose, then detaches)

dock.expand();                          // open the panel body
dock.collapse();                        // shrink to the chip
dock.setSide('bottom');                 // 'right' | 'bottom'
dock.setActive('inspect');              // switch tab programmatically
dock.unmount();                         // close every panel via onClose, then remove dock
```

`findDock()` returns the API of the currently mounted dock, or `undefined` — companions use this internally to opt into integration.

```js
import { findDock } from 'spektrum/dock';
const dock = findDock();   // → dock API | undefined
```

**Multi-instance.** Only one dock per page is supported (the DOM query `[data-spektrum-dock]` matches the first). Companions inspecting different Spektrum instances each register under their own id; you can prefix `id`/`label` per instance if you mount the same companion twice.

**Standalone behavior preserved.** Every companion still works the way it did before — `mountDevtools(spektrum)` without a dock renders a free-floating panel. The dock is purely additive.

**Production.** Same opt-in model as every other companion — production users who don't `import` it pay zero bytes.

## Related

- [Public API](api.md) — what the modules wrap
- [Time-travel](time-travel.md) — devtools + persist build on these primitives
- [CSP-safe deployments](csp.md) — `spektrum/compile` workflow
- [AGENTS.md](../AGENTS.md) — agent workflow tutorial

# Subpath modules

Spektrum ships five optional companion modules. Pull in only what you need; nothing leaks into the core bundle.

| Import | Purpose | Size (min/gz) |
| --- | --- | --- |
| [`spektrum/devtools`](#spektrumdevtools) | Floating scrubber panel — rewind, replay, watch state move | ~3.0 KB / 1.5 KB |
| [`spektrum/persist`](#spektrumpersist) | `saveHistory` / `loadHistory` over localStorage (or any Storage-shaped backend) | ~1.0 KB / 0.5 KB |
| [`spektrum/compile`](#spektrumcompile) | Build-time helper that scans templates and emits a `precompile()` module for strict-CSP deployments | (build-time only) |
| [`spektrum/mcp`](#spektrummcp) | SDK-agnostic MCP tool catalog — exposes the agent surface for orchestrators | ~5.1 KB / 2.0 KB |
| [`spektrum/agent`](#spektrumagent) | In-page LLM assistant. Mount a chat panel that drives the engine via the agent surface | ~12 KB / 4.6 KB |

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

## Related

- [Public API](api.md) — what the modules wrap
- [Time-travel](time-travel.md) — devtools + persist build on these primitives
- [CSP-safe deployments](csp.md) — `spektrum/compile` workflow
- [AGENTS.md](../AGENTS.md) — agent workflow tutorial

<p align="center">
  <img src="example/Spektrum-logo.png" alt="Spektrum" width="480">
</p>

[![npm](https://img.shields.io/npm/v/spektrum.svg)](https://www.npmjs.com/package/spektrum)
[![bundle size](https://img.shields.io/bundlephobia/minzip/spektrum.svg)](https://bundlephobia.com/package/spektrum)
[![license](https://img.shields.io/npm/l/spektrum.svg)](LICENSE)
[![types](https://img.shields.io/npm/types/spektrum.svg)](spektrum.d.ts)

A tiny templating engine with **time-travel built into the primitive** — deliberately auditable, drop-in, CSP-safe, and the first reactive engine designed from the ground up for **AI agents to read, drive, and reason about**.

**[Live demo →](https://d-dezeeuw.github.io/spektrum/example/)**

```html
<p>{{count}}</p>
<button data-action="click" data-fn="trigger" data-id="count" data-value="1" data-name="inc">+1</button>

<script type="module">
  import { setValue, bindDOM, run } from 'https://unpkg.com/spektrum';
  setValue('count', 0);
  bindDOM();  run();
</script>
```

That's a working reactive counter. No build, no install, no SPA framework. The whole engine is one file — **read it in an afternoon, or fit it in any LLM's context window in one tool call.**

## Why

- **Time-travel.** Every mutation recorded. `replay(n)` rebuilds any past state. Undo / scrub / agent-rollback for free.
- **Auditable.** ~12 KB minified, ~5.5 KB gzipped, ~1100 lines, single file, **zero runtime dependencies**.
- **Drop-in.** ESM from a `<script type="module">` — works in plain HTML, a WordPress theme, a browser extension, an Electron renderer, anywhere.
- **CSP-safe.** Strict-CSP via `spektrum/compile`.
- **Agent-native.** `describe()` returns the full operational manifest. `attempt()` is speculative execution. Mount an in-page LLM panel in 5 lines.

## Install

```bash
npm install spektrum
```

Or load from a CDN with an importmap so every subpath keeps its bare specifier:

```html
<script type="importmap">
{
  "imports": {
    "spektrum":          "https://unpkg.com/spektrum",
    "spektrum/devtools": "https://unpkg.com/spektrum/companions/spektrum-devtools.min.js",
    "spektrum/persist":  "https://unpkg.com/spektrum/companions/spektrum-persist.min.js",
    "spektrum/inspect":  "https://unpkg.com/spektrum/companions/spektrum-inspect.min.js",
    "spektrum/dock":     "https://unpkg.com/spektrum/companions/spektrum-dock.min.js",
    "spektrum/mcp":      "https://unpkg.com/spektrum/companions/spektrum-mcp.min.js",
    "spektrum/agent":    "https://unpkg.com/spektrum/companions/spektrum-agent.min.js"
  }
}
</script>
```

For production, pin the version: `https://unpkg.com/spektrum@<version>`.

## Documentation

The depth lives in [`docs/`](docs/). Single source of truth, plain Markdown.

| Doc | What's in it |
| --- | --- |
| [Bindings](docs/bindings.md) | `{{expr}}`, `:attr`, `data-if`, `data-each` (with container-not-template rule + reconciliation modes), `data-model`, `data-action`, `data-ref`, `data-intent`, `data-cloak`, URL-attribute safety |
| [Public API](docs/api.md) | Every export, with examples — `setValue`, `addAsync` / `refresh`, `computed`, `addSystem`, `defineFn`, agent surface |
| [Time-travel](docs/time-travel.md) | `replay`, `checkpoint`, `forks`, snapshots, devtools scrubber |
| [Subpath modules](docs/modules.md) | `devtools` / `persist` / `compile` / `mcp` / `agent` / `inspect` / `dock` |
| [Agent workflow](AGENTS.md) | Orient → speculate → explain → commit. Covers the in-page agent panel and MCP catalog |
| [CSP guide](docs/csp.md) | Strict-CSP deployments via build-time precompile |
| [Constraints](docs/constraints.md) | Non-negotiables that gate every feature |
| [Trade-offs](docs/trade-offs.md) | Deliberate design choices and their rationale |
| [Philosophy](docs/philosophy.md) | Non-goals; the engine in three sentences |

## Built with Spektrum

| App | What it is | Live | Source |
| --- | --- | --- | --- |
| **SKYo** | Hourly weather, single page | [d-dezeeuw.github.io/hourly-weather](https://d-dezeeuw.github.io/hourly-weather/) | [github.com/D-dezeeuw/hourly-weather](https://github.com/D-dezeeuw/hourly-weather) |
| **Devworld26 guide** | Conference schedule navigator | [d-dezeeuw.github.io/my-confs](https://d-dezeeuw.github.io/my-confs/) | [github.com/D-dezeeuw/my-confs](https://github.com/D-dezeeuw/my-confs) |
| **Spektrum demo** | Counter + basket reference, two isolated instances, devtools, persist, inspect, agent | [d-dezeeuw.github.io/spektrum/example](https://d-dezeeuw.github.io/spektrum/example/) | [example/](example/) |

Shipped something on Spektrum? Open a PR adding it here.

## License

[MIT](LICENSE). Browser & Node support, dev commands → [docs](docs/README.md#compatibility). Contributing → [CONTRIBUTING.md](CONTRIBUTING.md). Security disclosures → [SECURITY.md](SECURITY.md).

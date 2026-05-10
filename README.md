<p align="center">
  <img src="example/Spektrum-logo.png" alt="Spektrum" width="480">
</p>

[![npm](https://img.shields.io/npm/v/spektrum.svg)](https://www.npmjs.com/package/spektrum)
[![bundle size](https://img.shields.io/bundlephobia/minzip/spektrum.svg)](https://bundlephobia.com/package/spektrum)
[![license](https://img.shields.io/npm/l/spektrum.svg)](LICENSE)
[![types](https://img.shields.io/npm/types/spektrum.svg)](spektrum.d.ts)

**[Live demo →](https://d-dezeeuw.github.io/spektrum/example/)**

A tiny templating engine with **time-travel built into the primitive** — deliberately auditable, drop-in, CSP-safe, and the first reactive engine designed from the ground up for **AI agents to read, drive, and reason about**.

```html
<p>{{count}}</p>
<button data-action="click" data-fn="trigger" data-id="count" data-value="1" data-name="inc">+1</button>

<script type="module">
  import { setValue, bindDOM, run } from 'https://unpkg.com/spektrum';
  setValue('count', 0);
  bindDOM();  run();
</script>
```

That's a working reactive counter. No build, no install, no SPA framework. The whole engine is one file — read it in an afternoon, or fit it in any LLM's context window in one tool call.

## Why Spektrum is different

- **Time-travel.** Every mutation is recorded. `replay(n)` rebuilds any past state. Scrub a slider through it; ship undo without thinking; let an agent try an edit and roll it back. → [time-travel](docs/time-travel.md)
- **Auditable.** ~11.5 KB minified (~5.2 KB gzipped), ~1100 lines, single file, **zero runtime dependencies**. → [philosophy](docs/philosophy.md)
- **Drop-in.** ESM from a `<script type="module">` — works in a plain HTML file, a WordPress theme, a browser extension, a CMS code block, an Electron renderer, anywhere you can write HTML.
- **CSP-safe.** Strict-CSP deployments via `spektrum/compile`. → [CSP guide](docs/csp.md)
- **Agent-native.** `describe()` returns the full operational manifest in one read. `attempt()` is speculative execution: try an edit, evaluate, commit or discard. `data-intent="checkout.submit"` lets agents locate UI by purpose. Mount a Claude / OpenAI / OpenRouter chat panel inside the page in 5 lines. → [AGENTS.md](AGENTS.md)

> **Stable at 1.0.** The agent surface (`describe`, `explain`, `attempt`, `findByIntent`, `data-intent`, `defineFn` metadata), the [`spektrum/mcp`](docs/modules.md#spektrummcp) tool catalog, the [`spektrum/agent`](docs/modules.md#spektrumagent) in-page panel, and multi-subscriber hooks all shipped. See the [CHANGELOG](CHANGELOG.md) for the migration note on the one breaking change (hooks: `onX(fn)` now appends and returns an unsubscribe handle instead of replacing).

The rest is consequences.

## Install

```bash
npm install spektrum
```

Or load straight from a CDN (unpkg / jsDelivr serve the minified entry by default):

```html
<script type="module">
  import { setValue, bindDOM, run } from 'https://unpkg.com/spektrum';
</script>
```

For the helpers, reference the `.min.js` siblings explicitly, or use an importmap so every spektrum import keeps its bare-specifier form:

```html
<script type="importmap">
{
  "imports": {
    "spektrum":          "https://unpkg.com/spektrum",
    "spektrum/devtools": "https://unpkg.com/spektrum/spektrum-devtools.min.js",
    "spektrum/persist":  "https://unpkg.com/spektrum/spektrum-persist.min.js",
    "spektrum/mcp":      "https://unpkg.com/spektrum/spektrum-mcp.min.js",
    "spektrum/agent":    "https://unpkg.com/spektrum/spektrum-agent.min.js"
  }
}
</script>
```

For anything beyond a quick experiment, **pin to a known version**: `https://unpkg.com/spektrum@<version>`. The `?meta` suffix on unpkg returns the resolved file paths if you want to add subresource integrity hashes.

## Built with Spektrum

Apps shipping on Spektrum today — single static `index.html`, no build, no SPA framework:

| App | What it is | Live | Source |
| --- | --- | --- | --- |
| **SKYo** | Hourly weather, single page | [d-dezeeuw.github.io/hourly-weather](https://d-dezeeuw.github.io/hourly-weather/) | [github.com/D-dezeeuw/hourly-weather](https://github.com/D-dezeeuw/hourly-weather) |
| **Devworld26 guide** | Conference schedule navigator | — | [github.com/D-dezeeuw/my-confs](https://github.com/D-dezeeuw/my-confs) |
| **Spektrum demo** | Counter + basket reference, two isolated instances, devtools, persist, agent | [d-dezeeuw.github.io/spektrum/example](https://d-dezeeuw.github.io/spektrum/example/) | [example/](example/) |

Shipped something on Spektrum? Open a PR adding it here.

## Documentation

The depth lives in [`docs/`](docs/). Single source of truth, plain Markdown, GitHub renders it natively.

- **[Bindings](docs/bindings.md)** — declarative HTML directives
- **[Public API](docs/api.md)** — every export, with examples
- **[Time-travel](docs/time-travel.md)** — `replay`, `checkpoint`, `forks`, snapshots
- **[Subpath modules](docs/modules.md)** — `devtools` / `persist` / `compile` / `mcp` / `agent`
- **[Agent workflow](AGENTS.md)** — orient → speculate → explain → commit
- **[CSP-safe deployments](docs/csp.md)** — strict CSP via build-time precompile
- **[Trade-offs](docs/trade-offs.md)** — deliberate design choices and their rationale
- **[Philosophy](docs/philosophy.md)** — non-goals, design constraints, the engine in three sentences

Or browse the index at [`docs/README.md`](docs/README.md).

## Run the local demo

```bash
npm start                 # python3 -m http.server 8088
```

Open <http://127.0.0.1:8088/example/>.

## Browser support

Modern evergreen browsers, plus Safari ≥ 16 and Firefox ≥ 90. Node ≥ 22 for the test suite.

## Commands

```bash
npm test           # run the test suite (node:test, no deps)
npm run lint       # eslint
npm run build      # minified bundle
npm run size       # assert size budget
npm start          # serve on :8088
```

## License + contributing

[MIT](LICENSE). Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security disclosures: [SECURITY.md](SECURITY.md).

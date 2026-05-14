# Spektrum documentation

Reference material for working with Spektrum. The [root README](../README.md) is the pitch and the quick-start; this directory holds the depth.

## Reference

- **[Bindings](bindings.md)** — `{{expr}}`, `:attr`, `data-if`, `data-each`, `data-key`, `data-model`, `data-action`, `data-ref`, `data-intent`, `data-cloak`, URL-attribute safety
- **[Public API](api.md)** — `setValue`, `trigger`, `computed`, `addAsync`, `addSystem`, `defineFn`, `serialize`, `reset` / `resetState`, error handling, agent surface
- **[Time-travel](time-travel.md)** — `replay`, `checkpoint`, `forks`, `snapshotEvery`, the devtools scrubber, persistence
- **[Subpath modules](modules.md)** — `spektrum/devtools`, `spektrum/persist`, `spektrum/compile`, `spektrum/mcp`, `spektrum/agent`, `spektrum/inspect`, `spektrum/dock`

## Topical guides

- **[CSP-safe deployments](csp.md)** — build-time precompile for `unsafe-eval`-blocked environments
- **[Constraints](constraints.md)** — the non-negotiables that gate every feature (single file, zero deps, size budget, sync test surface, …)
- **[Known trade-offs](trade-offs.md)** — deliberate design choices and their rationale
- **[Philosophy](philosophy.md)** — non-goals, design constraints, the three-sentence engine model

## Agent integration

- **[../AGENTS.md](../AGENTS.md)** — agent workflow tutorial: orient → speculate → explain → commit. Covers the in-page agent panel and the MCP catalog.

## Source-of-truth pointers

- **Engine** — [`spektrum.js`](../spektrum.js) (~1100 lines, single file, zero deps)
- **Types** — [`spektrum.d.ts`](../spektrum.d.ts)
- **Tests** — [`tests/`](../tests/) (engine + DOM, one file per concern)
- **Demo** — [`example/`](../example/)
- **Changelog** — [`../CHANGELOG.md`](../CHANGELOG.md)
- **Security policy** — [`../SECURITY.md`](../SECURITY.md)
- **Contributing** — [`../CONTRIBUTING.md`](../CONTRIBUTING.md)

## Compatibility

- **Browsers** — modern evergreen (Chrome, Edge, Safari, Firefox). Minimum: Safari ≥ 16, Firefox ≥ 90.
- **Node** — ≥ 22 for the test suite (`node --test`, no fake timers, no DOM polyfill in the engine tests).
- **Module format** — ESM only. `<script type="module">` from a CDN; `import` in bundlers; `--input-type=module` in Node.
- **No bundler required** — every file (engine + companions) is ESM, side-effect-free, and works from `unpkg` / `jsdelivr` straight to the browser.

## Development

The full contributor workflow lives in [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — clone, install, conventions, what to think twice about, review etiquette. Day-to-day commands:

```bash
npm test           # node:test, no deps
npm run lint       # eslint
npm run build      # minified bundles
npm run size       # assert size budget
npm start          # serve on :8088 — open /example/
```

Every behavior change ships with a test, every public change updates `spektrum.d.ts`, every bundle change passes `npm run size`. See [Constraints](constraints.md) for what those gates enforce and why.

## Got somewhere?

If you came here looking for something specific and didn't find it, open an issue and we'll either add the page or point you at the existing one. The docs are deliberately tight — every page should answer a question someone actually asked.

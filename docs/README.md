# Spektrum documentation

Reference material for working with Spektrum. The [root README](../README.md) is the pitch and the quick-start; this directory holds the depth.

## Reference

- **[Bindings](bindings.md)** — `{{expr}}`, `:attr`, `data-if`, `data-each`, `data-key`, `data-model`, `data-action`, `data-ref`, `data-intent`, `data-cloak`, URL-attribute safety
- **[Public API](api.md)** — `setValue`, `trigger`, `computed`, `addAsync`, `addSystem`, `defineFn`, `serialize`, `reset` / `resetState`, error handling, agent surface
- **[Time-travel](time-travel.md)** — `replay`, `checkpoint`, `forks`, `snapshotEvery`, the devtools scrubber, persistence
- **[Subpath modules](modules.md)** — `spektrum/devtools`, `spektrum/persist`, `spektrum/compile`, `spektrum/mcp`, `spektrum/agent`

## Topical guides

- **[CSP-safe deployments](csp.md)** — build-time precompile for `unsafe-eval`-blocked environments
- **[Known trade-offs](trade-offs.md)** — deliberate design choices and their rationale
- **[Philosophy](philosophy.md)** — non-goals, design constraints, the three-sentence engine model

## Agent integration

- **[../AGENTS.md](../AGENTS.md)** — agent workflow tutorial: orient → speculate → explain → commit. Covers the in-page agent panel and the MCP catalog.

## Source-of-truth pointers

- **Engine** — [`spektrum.js`](../spektrum.js) (~1100 lines, single file, zero deps)
- **Types** — [`spektrum.d.ts`](../spektrum.d.ts)
- **Tests** — [`spektrum.test.js`](../spektrum.test.js) + [`spektrum.dom.test.js`](../spektrum.dom.test.js)
- **Demo** — [`example/`](../example/)
- **Changelog** — [`../CHANGELOG.md`](../CHANGELOG.md)
- **Security policy** — [`../SECURITY.md`](../SECURITY.md)
- **Contributing** — [`../CONTRIBUTING.md`](../CONTRIBUTING.md)

## Got somewhere?

If you came here looking for something specific and didn't find it, open an issue and we'll either add the page or point you at the existing one. The docs are deliberately tight — every page should answer a question someone actually asked.

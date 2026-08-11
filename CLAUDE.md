# Working on the Spektrum repo

Spektrum is a single-file reactive engine (`spektrum.js`) with opt-in companions (`companions/`). This file orients agents contributing **to** the engine. If you're **using** Spektrum in an app, read [`AGENTS.md`](AGENTS.md) or load the `spektrum` skill (`.claude/skills/spektrum/SKILL.md`) instead — and [`llms.txt`](llms.txt) maps every document in one page.

## Source-of-truth order

`spektrum.js` + `spektrum.d.ts` + `tests/` &nbsp;→&nbsp; `docs/` &nbsp;→&nbsp; `SKILL.md` / `AGENTS.md` / `README.md`

When layers disagree, the source is right, and the stale layer is a bug — fix it in the same change. This has real history: guides kept teaching the pre-1.0 engine (`trigger` as the additive primitive, regex-based loop-variable rewriting) long after 1.0 replaced them. The current surface: `addValue(path, value, id?)` is the additive mutator with `trigger` as its deprecated alias; `data-each` provides real per-row scope (`$index` / `$first` / `$last` / `$path`); keyed rows always reuse DOM on reorder (`data-stable-key` is a no-op).

## Hard gates — every change passes through these

Full rationale in [`docs/constraints.md`](docs/constraints.md). The short version:

- **The engine stays one file with zero runtime dependencies.** No exceptions, no "just one helper," no internal module splits. Opt-in functionality goes in `companions/`.
- **Size caps in [`scripts/size.js`](scripts/size.js) are hard limits**, CI-enforced. A change that doesn't fit is trimmed until it does, or it doesn't merge. Never raise a cap on your own initiative — that requires explicit maintainer sign-off.
- **Every behavior change ships a test.** `tests/`, `node --test` + happy-dom, synchronous and deterministic — no mocks, no fake timers.
- **Every public-surface change updates `spektrum.d.ts`** (the `tsc --noEmit` gate catches drift) **and every doc that mentions the surface** — including `.claude/skills/spektrum/SKILL.md` and `AGENTS.md`.
- **Templates are author-written** (the Vue/Alpine trust model). Don't weaken the eval/CSP posture; see [`docs/security-model.md`](docs/security-model.md).
- **Comments explain why, not what.** Non-obvious decisions get a nearby comment covering the constraint or the bug that motivated them.

## Commands

```bash
npm test            # engine + DOM + companion + property tests
npm run lint        # eslint
npm run typecheck   # tsc --noEmit — .d.ts drift gate
npm run build       # minified bundles (prerequisite for size)
npm run size        # assert size budgets — run after every engine/companion edit
npm start           # demo at http://127.0.0.1:8088/example/
```

CI also runs real-browser smoke tests (`node --test tests/browser/*.test.js`, Playwright installed ad hoc — deliberately not a devDependency).

## Read this when

| Working on | Read first |
| --- | --- |
| Engine internals | `spektrum.js` end-to-end (it fits in one read), then [`docs/trade-offs.md`](docs/trade-offs.md) |
| Any new feature | [`docs/constraints.md`](docs/constraints.md) — it has rejected reasonable-sounding features before |
| Directives / markup behavior | [`docs/bindings.md`](docs/bindings.md) |
| Public API shape | [`docs/api.md`](docs/api.md) + [`spektrum.d.ts`](spektrum.d.ts) |
| History / replay / forks | [`docs/time-travel.md`](docs/time-travel.md) |
| A companion module | [`docs/modules.md`](docs/modules.md) + that companion's `.d.ts` |
| Agent surface or MCP | [`AGENTS.md`](AGENTS.md) + [`docs/security-model.md`](docs/security-model.md) |
| Release notes | [`CHANGELOG.md`](CHANGELOG.md) — Keep a Changelog format, entries land under Unreleased |

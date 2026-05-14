# Contributing to Spektrum

The whole library is one ~600-line file plus a few small subpath
modules. That's deliberate — it's the property the README leads
with. Most contributions should preserve it.

## Quick start

```bash
git clone https://github.com/D-dezeeuw/spektrum.git
cd spektrum
npm install
npm test          # node --test, no fake timers
npm run lint
npm run build
npm run size      # asserts the minified bundle is under budget
```

Open the demo with `npm start` and visit
<http://127.0.0.1:8088/example/>.

## What we'd love

- **Bug reports with a failing test.** A 10-line `.test.js`
  reproduction is worth any amount of prose.
- **Performance work** that doesn't cost size: tighter inner loops,
  better path-key indexing, snapshot strategies.
- **Build-tool integrations** for the `precompile()` path: a Vite
  plugin, an esbuild plugin, a Rollup hook. Keep them as separate
  packages — the core stays zero-dep.
- **Recipes** for common patterns (forms, async loading, routing).
  These belong in `example/` or the README, not the engine.

## What to think twice about

- **Anything that adds a runtime dependency.** Don't, unless we've
  agreed on it first in an issue. The auditability pitch dies the
  moment `spektrum` has a transitive dep tail.
- **Features that grow the bundle past the size budget**
  (`scripts/size.js`). If you need to spend the budget, justify
  it.
- **API surface area.** The current API is a few dozen named
  exports. Each new one is a maintenance commitment.
- **Refactors that obscure the engine.** The engine's job is to be
  readable. Optimizations that bloat the source for marginal
  performance lose the philosophy fight.

## Coding conventions

- **Code style.** Read `spektrum.js`. Match it. ESLint's flat
  config (`eslint.config.js`) is the baseline.
- **Comments document *why*, not *what*.** Reviewers will ask you
  to delete `// returns the value` and keep `// runtime try/catch
  so paths absent before the first tick render as undefined`.
- **Tests.** Every behavior change ships with a `node:test` test
  in `tests/spektrum.test.js` (no DOM) or `tests/spektrum.dom.test.js`
  (happy-dom). Companion tests live alongside (`tests/spektrum-*.test.js`).
  No fake timers, no mocks of the DOM, no awaits on microtasks —
  `tick()` is synchronous on purpose.
- **Public API surface** lives in `spektrum.d.ts` — keep it in
  sync.
- **Changelog.** Add a line under `## [Unreleased]` in
  `CHANGELOG.md`. The format follows
  [Keep a Changelog](https://keepachangelog.com/).

## Reviewing & merging

Before you open a PR, run `npm test`, `npm run lint`, `npm run build`,
and `npm run size` locally and make sure they pass. There's no CI to
catch regressions for you. Substantive changes usually want an issue
first to avoid work going sideways.

Be patient — this is a side project and reviews aren't always
same-day.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please **don't** file public issues
for vulnerabilities.

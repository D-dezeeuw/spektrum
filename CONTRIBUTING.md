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
npm run typecheck # tsc --noEmit against the hand-maintained .d.ts files
npm run build
npm run size      # asserts the minified bundle is under budget
```

Open the demo with `npm start` and visit
<http://127.0.0.1:8088/example/>.

### Browser tests (optional locally, required in CI)

`npm test` runs against happy-dom, which is fast but lenient exactly
where real engines are strict — `progress.value = NaN` throws in a
browser and not in happy-dom, and a regex lookbehind is a parse error on
Safari < 16.4. `tests/browser/` covers that gap with Playwright:

```bash
npx playwright install chromium
SPEKTRUM_BROWSERS=chromium node --test tests/browser/*.test.js
```

Playwright is deliberately not a dependency (not even a dev one), so the
file **skips** when it isn't installed and `npm test` stays lean. CI
installs it ad hoc and runs Chromium, Firefox, and WebKit. If your
environment ships pre-installed browsers whose revision doesn't match
Playwright's pin, set `SPEKTRUM_BROWSER_EXECUTABLE=/path/to/binary`.

### Property tests

`tests/spektrum.properties.test.js` asserts engine invariants (replay
determinism, delta drainage, prototype-pollution safety) over generated
mutation programs, using a seeded PRNG so failures reproduce. Every
assertion prints its seed; replay a counterexample with
`SPEKTRUM_SEED=<n> npm test`, and widen the search with
`SPEKTRUM_RUNS=1000`.

## Project structure

```text
spektrum.js            engine — single file, the constraint everything else defends
spektrum.d.ts          TypeScript declarations
spektrum.min.js        built artifact (gitignored; CI re-builds)
companions/            opt-in subpath modules (devtools / persist / compile / mcp /
                       agent / inspect / dock) — each a single file + matching .min.js
docs/                  reference + topical guides; see docs/README.md for the index
docs-site/             TypeDoc-rendered API reference (gitignored; `npm run docs` builds)
example/               demo wiring (index.html + app.js); two isolated instances
tests/                 node:test + happy-dom; one file per concern
scripts/size.js        zero-dep size-budget enforcer
notes/                 working notes (gitignored)
```

Standards files (`README.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`,
`AGENTS.md`, this file) and config (`package.json`, `package-lock.json`,
`eslint.config.js`, `.editorconfig`, `.gitignore`) stay at root because
GitHub, npm, and unpkg read them by exact name there.

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
- **Docs touchup after refactors.** When a refactor renames or
  removes an internal helper or built-in (e.g. the old
  `rewriteScope`, `data-stable-key`), grep `docs/` for references
  before opening the PR — stale cross-links lie to readers. The
  short ritual: `git diff --stat main…HEAD` to spot renamed
  identifiers, then `grep -rn '<name>' docs/` for each. Same goes
  for the `## Related` link blocks at the bottom of each doc page.
- **Changelog.** Add a line under `## [Unreleased]` in
  `CHANGELOG.md`. The format follows
  [Keep a Changelog](https://keepachangelog.com/).

## Reviewing & merging

Before you open a PR, run `npm test`, `npm run lint`, `npm run typecheck`,
`npm run build`, and `npm run size` locally and make sure they pass. CI
runs the same gate on every PR (across Node 22 and 24) plus a
Chromium/Firefox/WebKit smoke lane, but finding it locally is faster than
finding it in a workflow log. Substantive changes usually want an issue
first to avoid work going sideways.

See [`ROADMAP.md`](ROADMAP.md) for what's planned, what's under
consideration, and what's deliberately out of scope — it's the quickest
way to tell whether an idea will land before you build it.

Be patient — this is a side project and reviews aren't always
same-day.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please **don't** file public issues
for vulnerabilities.

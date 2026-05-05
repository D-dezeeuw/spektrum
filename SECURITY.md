# Security policy

Spektrum is a single ~600-line file with zero runtime dependencies.
The supply-chain story is the whole pitch — please help keep it
honest.

## Reporting a vulnerability

Please report security issues **privately** by emailing
**danny@nekomedia.nl**. Do not open a public GitHub issue for
suspected vulnerabilities until a fix is released.

Include:

- A description of the issue and its impact.
- A minimal reproduction (HTML + JS snippet, or a failing test).
- The version of Spektrum you observed it on (`npm ls spektrum`).
- Whether you'd like to be credited in the release notes.

You should expect an acknowledgement within **3 working days**, and
a fix or remediation plan within **10 working days** for confirmed
issues. If you don't hear back, please re-send — mail does
occasionally get filtered.

## Scope

In scope:

- The runtime engine (`spektrum.js`) and bundled subpath modules
  (`spektrum-compile.js`, `spektrum-devtools.js`,
  `spektrum-persist.js`).
- Anything published under the `spektrum` npm package.
- The published GitHub Actions workflows in this repository.

Out of scope:

- The example app (`example/`) — it's demonstrative, not part of
  the published package.
- Issues that require accepting attacker-controlled HTML *templates*
  (the runtime compiles author-written templates via `new Function`;
  same caveat as Vue/Alpine). Do report bypasses where attacker
  *data* leads to template-level execution — that is in scope.

## Hardening posture

Spektrum publishes with [npm provenance](https://docs.npmjs.com/generating-provenance-statements);
each release is built and published from the public `Publish`
workflow on push of a `v*` tag, with no manual artifact uploads.

For deployments under strict CSP that disable `unsafe-eval`, use
the `precompile()` API plus the build-time scanner in
`spektrum/compile` — see the README. With every template expression
precompiled, the runtime never reaches the `new Function` fallback.

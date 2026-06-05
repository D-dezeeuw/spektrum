# Security policy

Spektrum is a single ~1,350-line file with zero runtime dependencies.
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

- The runtime engine (`spektrum.js`) and the published subpath
  modules (`spektrum/compile`, `/devtools`, `/persist`, `/mcp`,
  `/agent`, `/inspect`, `/dock`).
- Anything published under the `spektrum` npm package.

Out of scope:

- The example app (`example/`) — it's demonstrative, not part of
  the published package.
- Issues that require accepting attacker-controlled HTML *templates*
  (the runtime compiles author-written templates via `new Function`;
  same caveat as Vue/Alpine). Do report bypasses where attacker
  *data* leads to template-level execution — that is in scope.

## Hardening posture

Releases are published manually from the maintainer's machine after
local `npm test` / `lint` / `build` / `size` checks pass. The
package has no runtime dependencies, so the supply-chain surface is
limited to the single tarball.

For deployments under strict CSP that disable `unsafe-eval`, use
the `precompile()` API plus the build-time scanner in
`spektrum/compile` — see the README. With every template expression
precompiled, the runtime never reaches the `new Function` fallback.

### Agent-driven mutations

`spektrum/mcp` and `spektrum/agent` hand an LLM the same write authority
over engine state as any caller of `setValue` / `trigger`. Two things to
know when putting an app on the wire for an agent:

- **Writes are denied by default.** `createTools()` / `mount()` produce
  a read-only agent unless you opt in: pass `protectedPaths` to allow
  writes except to sensitive paths (API keys, auth, config), or
  `{ allowAllPaths: true }` for unrestricted writes. `protectedPaths`
  takes precedence if both are set. Even with writes enabled, mount the
  agent only where you trust the agent and the transport (e.g. local
  stdio MCP — never exposed to the internet without auth).
- **Don't render agent output through `:innerHTML`.** LLM/API responses
  are semi-trusted data. `:innerHTML` and `:srcdoc` parse their value as
  HTML, so binding model output through them reintroduces XSS. Use
  `{{ }}` text interpolation or `:textContent` for agent-produced
  strings.

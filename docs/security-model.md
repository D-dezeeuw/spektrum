# Security model

What Spektrum protects, what it deliberately does not, and where the boundaries sit. Read this before putting an app on the wire for an agent.

This page is the map; the details live in [constraints](constraints.md), [trade-offs](trade-offs.md), [CSP](csp.md), and [modules](modules.md). For reporting a vulnerability, see [`SECURITY.md`](../SECURITY.md).

---

## The one-paragraph version

Templates are code you wrote, and are trusted like code. Application *data* is not trusted and is escaped on the way into the DOM. An agent given the MCP or in-page-agent catalog can read everything in state and — only if you opt in — write to it. Nothing in the engine sandboxes an expression, and nothing hides state from a reader.

---

## Trust boundaries

### Templates are author-written

Expressions in `{{…}}`, `:attr`, `data-if`, and `data-key` compile through `new Function` (or a `precompile()` registration under strict CSP). This is the **same trust model as Vue and Alpine**: templates are source code, not input.

`{{constructor.constructor("…")()}}` is reachable from a template — by whoever wrote the template, who is already running code on the page. Precompiling does **not** change this; it removes the runtime `new Function` requirement, not the trust requirement.

**Never** build templates from user input, database rows, or network responses. A CMS that lets end users author markup needs its own sanitization layer in front — the engine has none. See [constraints → templates are author-written](constraints.md#templates-are-author-written).

### Data is untrusted and is escaped

Values flowing through `{{…}}` are set via `textContent` — never parsed as HTML. `:href`, `:src`, `:action`, `:formaction`, `:background`, `:cite`, `:poster`, and `:data` rewrite a `javascript:` value to `#`.

Two attributes deliberately bypass that, because their value *is* markup by definition:

- `:innerHTML` — parsed as HTML.
- `:srcdoc` — parsed as an HTML document. It is intentionally excluded from the URL-scheme guard, where a scheme check would give false confidence.

Binding untrusted data — especially LLM output — through either is XSS. Use `{{ }}` or `:textContent`.

### Prototype pollution is guarded at every merge

Every path walk and object merge (`setPathValue`, `createNestedObjects`, `deepMerge`, `deepClone`) rejects `__proto__`, `prototype`, and `constructor` segments. This matters most for `spektrum/persist`, whose input is browser storage — attacker-reachable in a way normal engine input is not. Persist additionally replays through the public mutators rather than assigning parsed objects into state.

### Strict CSP

The default runtime needs `unsafe-eval`. For a strict CSP, precompile every expression at build time with [`spektrum/compile`](csp.md) so `new Function` is never reached. Registrations live in an unbounded registry and take precedence over the runtime's bounded compile cache.

---

## Agent access

`spektrum/mcp` and `spektrum/agent` hand an LLM the same authority over engine state as any caller of `setValue`. Two properties are easy to get backwards:

### Writes are denied by default

A catalog created without write configuration is read-only. Opt in with `protectedPaths` (allow all but these) or `allowAllPaths: true`. See [modules → restricting writes](modules.md#restricting-writes) for the matching rules — note that a protected path is denied bidirectionally, so writing its *parent* object is blocked too.

Read-only also denies the history-mutating tools (`checkpoint`, `attempt.start`, `replay`), because `replay` plus one recorded entry truncates history. `allowTimeTravel: true` re-enables them for a read-only agent.

### `protectedPaths` is a write fence, not a read fence

**A guarded path is still fully readable** through `getState`, `describe`, `explain`, and `serialize`. `spektrum/agent` then sends what it reads to Anthropic / OpenAI / OpenRouter.

So `protectedPaths: ['llm.apiKey']` stops an agent from *corrupting* that value. It does not stop the agent from reading it and putting it in a prompt. **Keep real secrets out of engine state.** If a value would be damaging to disclose, it does not belong in `appState` on a page with an agent mounted.

### Transport

Mount an agent only where you trust the agent *and* the transport — local stdio MCP, an authenticated backend. Never expose a tool catalog to the open internet.

---

## Dev-only companions

`spektrum/agent`, `spektrum/inspect`, `spektrum/devtools`, and `spektrum/dock` are development affordances. In particular, `spektrum/agent` stores its API key in `localStorage` in plaintext, and calls provider APIs directly from the browser — any script on the origin can read that key. That is an acceptable trade for local development and unacceptable for production: ship your own authenticated backend instead and never mount the panel for end users.

---

## Out of scope

- Sandboxing template expressions. Rejected: a sandboxed evaluator costs bytes the [size budget](constraints.md#size-budget-enforced-at-ci) does not have, to solve a non-problem inside the stated trust model.
- Hiding state from a reader that has the tool catalog. Reads are not gated; use application architecture instead.
- The example app (`example/`), which is demonstrative and not published.

---

## Related

- [`SECURITY.md`](../SECURITY.md) — reporting a vulnerability, supported scope
- [Constraints](constraints.md) — why the trust model is what it is
- [CSP-safe deployments](csp.md) — the precompile workflow
- [Subpath modules](modules.md) — per-companion options, including the full write-guard rules
- [Trade-offs](trade-offs.md) — deliberate compromises

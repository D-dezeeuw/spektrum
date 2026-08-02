# CSP-safe deployments

The default Spektrum runtime compiles template expressions via `new Function`. Strict Content-Security-Policies that disable `unsafe-eval` block that path. Use `spektrum/compile` at build time to precompile every expression once — the runtime cache hits before the `Function` fallback ever runs.

## Build step

```js
// build script
import { extractExpressions, emitPrecompileSource } from 'spektrum/compile';
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const exprs = extractExpressions(html);
writeFileSync('precompiled.js', emitPrecompileSource(exprs));
```

`extractExpressions(html)` returns the unique set of expressions found in `{{…}}`, `:attr="…"`, `data-if`, and `data-key`. `emitPrecompileSource(exprs)` emits a JS module that registers each via `precompile()`.

## Loading the precompiled module

Load the generated module before `bindDOM()`:

```html
<script type="module" src="./precompiled.js"></script>
<script type="module" src="./app.js"></script>
```

With every expression precompiled, the registry hits before the runtime ever reaches the `Function` fallback. The emitted module is plain ESM — no string-to-code conversion at runtime.

Registrations are held in their own unbounded registry, separate from the bounded cache the runtime compiler uses, and take precedence over it. Register as many expressions as your templates contain; they are never evicted.

## What the emitted functions look like

Each registration is a `(state, scope)` function. `scope` carries the per-iteration `data-each` bindings — the loop variable, `$index`, `$first`, `$last`, `$path` — and is undefined outside a loop. Every free identifier is resolved scope-first, reproducing the runtime's `with (state) with (scope||{})` shadowing order:

```js
precompile("item.label", (state, scope) => {
  const _ = scope || {};
  try {
    const item = "item" in _ ? _["item"] : state["item"];
    return (item.label);
  } catch { return undefined; }
});
```

The generated code is strict-mode safe, which is what lets it load as an ES module. If you hand-write a `precompile()` call instead of generating it, match this shape — a function that ignores its second argument returns `undefined` for every expression inside a `data-each`, including `data-key`, which collapses keyed lists onto a single `undefined` key.

One limitation: an expression whose identifier head is literally `state` or `scope` resolves to the emitted function's own parameter rather than a same-named state key. Rename the key, or leave that one expression to the runtime compiler.

## What it doesn't change

Precompile removes the *runtime* `new Function` requirement (the CSP-friendliness). It does **not** change the trust requirement on templates.

The emitted functions still evaluate author-written expressions verbatim, so a template expression like `{{constructor.constructor("…")()}}` is still reachable. **"We precompiled, so untrusted templates are fine" is wrong.** Templates remain author-written, same caveat as Vue/Alpine. See [trade-offs](trade-offs.md#expressions-use-withstate-inside-new-function) for the rationale.

## Build-tool integration

The scanner is a pure function over an HTML string — wire it into any build pipeline (esbuild plugin, Vite plugin, Rollup hook, or a one-shot script in `package.json`). It deliberately doesn't ship as a plugin for any specific bundler; the integration is small and your build is yours.

If your HTML has unusual shapes (`<` inside attribute values, weird quoting), feed it through a real HTML parser first and pass the cleaned string to `extractExpressions`.

## Related

- [Trade-offs → `with(state)` rationale](trade-offs.md#expressions-use-withstate-inside-new-function)
- [Modules → spektrum/compile](modules.md#spektrumcompile)

/*
  Spektrum — CSP-safe template compiler.

  At runtime, Spektrum compiles `{{...}}`, `:attr="..."`, `data-if`,
  and `data-key` expressions via `new Function`. Strict CSPs that
  disable `unsafe-eval` block that path. The fix: in a build step,
  walk every template once, emit one `precompile(source, fn)` call
  per unique expression, and ship that module. At runtime the cache
  hits before the `new Function` fallback runs.

  This file provides:

    extractExpressions(html) -> string[]
      Scan an HTML string. Returns the list of unique expression
      sources used in {{...}}, :attr, data-if, and data-key.

    emitPrecompileSource(expressions) -> string
      Take an array of expressions and emit a JS module string that
      registers each one with Spektrum's precompile(). The emitted
      module is plain ESM — no eval, no Function constructor.

  Use it from your build pipeline (esbuild plugin, Vite plugin,
  Rollup hook, or a one-shot script). The runtime stays untouched.
  Keep this module out of your shipped bundle — it's a build-time
  tool, not a runtime dep.

  Limitations: this scanner is intentionally tiny (regex over HTML
  string). It handles the common cases. If you have weird inline
  HTML — `<` inside attribute values, etc. — feed it through a real
  HTML parser first and pass the cleaned string here.
*/

const MUSTACHE = /\{\{\s*([^}]+?)\s*\}\}/g;
const ATTR_BIND = /(?:\s|^)(:[\w-]+|data-if|data-key)\s*=\s*"([^"]+)"/g;

// Identifier scanner — same shape as the runtime's `extractPaths`, so
// the set of names the emitted prelude resolves matches the set the
// runtime subscribes to. The lookbehind keeps `user.name.toUpperCase`
// as one path (head `user`) instead of three.
const IDENT = /(?<![\w$.])([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/g;
const STRINGS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
// Heads that must NOT be resolved against state/scope: JS globals and
// literals (same list as the runtime's RESERVED), plus the two
// parameter names of the emitted function — shadowing those with a
// `const` would break the prelude that reads them.
const RESERVED = /^(true|false|null|undefined|NaN|Infinity|Math|JSON|Date|Number|String|Array|Object|Boolean|state|scope)$/;

/** Dotted-numeric → bracket normalization, matching the runtime.
 *  Handles chained indices (`grid.1.0` → `grid[1][0]`) in one pass and
 *  leaves float literals alone (`val + 1.5` is not a path). */
const normalize = (src) => src.replace(
  /([a-zA-Z_$][\w$]*)((?:\.\d+)+)/g,
  (_, h, t) => h + t.replace(/\.(\d+)/g, '[$1]'),
);

/** Free identifier heads in an expression, in encounter order.
 *  String literals are stripped first so names inside quotes don't
 *  become spurious bindings. */
const identHeads = (src) => {
  const out = new Set();
  for (const m of src.replace(STRINGS, '""').matchAll(IDENT)) {
    const head = m[1].split('.')[0];
    if (!RESERVED.test(head)) out.add(head);
  }
  return [...out];
};

/**
 * Extract every unique expression source from an HTML string.
 *
 * @param {string} html
 * @returns {string[]} unique expression sources, in encounter order
 */
export const extractExpressions = (html) => {
  const seen = new Set();
  for (const m of html.matchAll(MUSTACHE)) seen.add(m[1].trim());
  for (const m of html.matchAll(ATTR_BIND)) {
    const value = m[2].trim();
    if (value) seen.add(value);
  }
  return [...seen];
};

/**
 * Emit a JS module string that registers each expression with
 * Spektrum's precompile(). The output:
 *
 *   import { precompile } from 'spektrum';
 *   precompile("count + 1", (state, scope) => { const _ = scope || {}; try { const count = 'count' in _ ? _.count : state.count; return (count + 1); } catch { return undefined; } });
 *   ...
 *
 * Two properties this shape buys, both of which the previous
 * `with (state)` emitter got wrong:
 *
 *   1. **It parses as an ES module.** `with` is a SyntaxError in
 *      strict-mode code, and ES modules are always strict — so the
 *      emitted file could not be loaded the way csp.md documents
 *      (`<script type="module">`). The prelude below is strict-safe,
 *      so the module loads as a module.
 *
 *   2. **It honours `data-each` scope.** The runtime calls compiled
 *      expressions as `fn(state, scope)`; `scope` carries the loop
 *      variable (`item`), `$index`, `$path`, and friends. A
 *      `(state) => …` function ignores it, so under CSP every row
 *      expression and every `data-key` evaluated to undefined — rows
 *      rendered blank and keyed lists collapsed on duplicate
 *      `undefined` keys. Each identifier is resolved scope-first,
 *      matching the runtime's `with (state) with (scope||{})`
 *      shadowing order.
 *
 * No string-to-code conversion happens at runtime: the engine parses
 * the emitted module the same way it parses any other source file.
 *
 * Limitation: an expression whose identifier head is literally `state`
 * or `scope` resolves to the function's own parameter rather than a
 * same-named state key. Rename the key, or leave that expression to
 * the runtime compiler.
 *
 * @param {string[]} expressions
 * @param {object} [opts]
 * @param {string} [opts.specifier='spektrum']  Import specifier for precompile.
 * @returns {string}
 */
export const emitPrecompileSource = (expressions, opts = {}) => {
  const specifier = opts.specifier || 'spektrum';
  const lines = [`import { precompile } from '${specifier}';`, ''];
  for (const src of expressions) {
    const normalized = normalize(src);
    // One `const` per free identifier, scope-first then state. Reads a
    // missing name as undefined instead of throwing, which is what the
    // runtime's inner try/catch already normalises to.
    const prelude = identHeads(normalized)
      .map(h => `const ${h} = ${JSON.stringify(h)} in _ ? _[${JSON.stringify(h)}] : state[${JSON.stringify(h)}];`)
      .join(' ');
    const body = prelude ? `${prelude} return (${normalized});` : `return (${normalized});`;
    const fnSource = `(state, scope) => { const _ = scope || {}; try { ${body} } catch { return undefined; } }`;
    lines.push(`precompile(${JSON.stringify(src)}, ${fnSource});`);
  }
  return lines.join('\n') + '\n';
};

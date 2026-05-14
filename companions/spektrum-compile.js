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
 *   precompile('count + 1', (state) => { try { with (state) { return (count + 1); } } catch { return undefined; } });
 *   ...
 *
 * The emitted functions use `with` — a language feature, not
 * eval/Function — so they're allowed under CSP. The point of this
 * build step is that no string-to-code conversion happens at
 * runtime: the engine parses the emitted module the same way it
 * parses any other source file.
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
    // Same dotted-numeric → bracket normalization the runtime does,
    // so `users.0.name` is parseable JS.
    const normalized = src.replace(/([a-zA-Z_$][\w$]*)\.(\d+)/g, '$1[$2]');
    const fnSource = `(state) => { try { with (state) { return (${normalized}); } } catch { return undefined; } }`;
    lines.push(`precompile(${JSON.stringify(src)}, ${fnSource});`);
  }
  return lines.join('\n') + '\n';
};

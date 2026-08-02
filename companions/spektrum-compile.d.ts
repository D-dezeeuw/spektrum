/**
 * Type declarations for `spektrum/compile` — the build-time, CSP-safe
 * template compiler. Scans HTML for template expressions and emits a
 * module of `precompile()` calls so the runtime never reaches
 * `new Function` under a strict Content-Security-Policy.
 *
 * Source of truth: `companions/spektrum-compile.js`. When the runtime
 * shape changes, update this file in the same commit.
 *
 * This is a build-time tool — keep it out of your shipped bundle.
 */

/**
 * Scan an HTML string and return every unique expression source used
 * in `{{...}}`, `:attr="..."`, `data-if`, and `data-key`, in
 * encounter order.
 *
 * The scanner is intentionally tiny (regex over the HTML string). For
 * pathological inline HTML (`<` inside attribute values, etc.) run the
 * string through a real HTML parser first.
 */
export function extractExpressions(html: string): string[];

/** Options for {@link emitPrecompileSource}. */
export interface EmitOptions {
  /** Import specifier for `precompile`. Defaults to `'spektrum'`. */
  specifier?: string;
}

/**
 * Emit a JS module string that registers each expression with
 * Spektrum's `precompile()`. No string-to-code conversion happens at
 * runtime, so the output is CSP-clean.
 *
 * Emitted functions take `(state, scope)` and resolve each free
 * identifier scope-first, matching the runtime's
 * `with (state) with (scope||{})` shadowing order — so expressions
 * inside a `data-each` (including `data-key`) resolve the loop
 * variable. The generated code is strict-mode safe and therefore loads
 * as an ES module.
 */
export function emitPrecompileSource(
  expressions: string[],
  opts?: EmitOptions,
): string;

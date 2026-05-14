/**
 * Type declarations for `spektrum/inspect` — the developer-time DX
 * panel (element hover inspector, mutation tracer, static lint).
 *
 * Source of truth: `companions/spektrum-inspect.js`. When the runtime
 * shape changes, update this file in the same commit.
 */

import type { Spektrum } from '../spektrum.js';

/** Where the panel docks. Auto-picks a free corner by default,
 *  avoiding existing devtools / inspect / dock panels. */
export type InspectPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** The three feature tabs. Pass a subset to `mount({ features })` to
 *  render only what you need. */
export type InspectFeature = 'elements' | 'mutations' | 'lint';

/** A binding extracted from an element by `readBindings(el)`. The
 *  union mirrors the directive kinds — each variant carries only the
 *  fields that apply. Element identity isn't included; the caller
 *  already has it. */
export type BindingInfo =
  | { kind: 'attr';   name: string; expr: string }                   // :attr
  | { kind: 'if';     expr: string }                                 // data-if
  | { kind: 'each';   path: string; as: string; key?: string }       // data-each
  | { kind: 'model';  path: string }                                 // data-model
  | { kind: 'ref';    name: string }                                 // data-ref
  | { kind: 'intent'; name: string }                                 // data-intent
  | { kind: 'action'; event: string; fn?: string; id?: string }      // data-action
  | { kind: 'text';   expr: string };                                // {{expr}} in a text node

/** A finding from `lint(spektrum, root)`. `el` is the offending node
 *  so the panel can scroll to it / outline it. `kind` is `'warn'`
 *  today; future severities will widen the union. */
export interface LintFinding {
  kind: 'warn';
  msg: string;
  el: Element;
}

export interface InspectOptions {
  /** Defaults to the first free corner (avoiding existing devtools /
   *  inspect / dock panels). When a dock is mounted, position is
   *  ignored — the dock owns layout. */
  position?: InspectPosition;
  /** Container the panel is appended to. Defaults to `document.body`. */
  parent?: Element;
  /** Subset of tabs to render. Defaults to all three. */
  features?: InspectFeature[];
  /** When `true`, every mutation also routes through `console.groupCollapsed`
   *  so it survives panel unmount. Default: `false`. */
  consoleEcho?: boolean;
}

/**
 * Mount the inspector for the given Spektrum instance. Auto-detects a
 * mounted dock and registers as a tab inside it; falls back to a
 * free-floating panel if no dock is present.
 *
 * Returns an unmount function — detaches listeners, removes the panel,
 * removes the tooltip + outline overlays.
 */
export function mount(spektrum: Spektrum, opts?: InspectOptions): () => void;

/** Read every declarative binding on `el` into a plain-JS array. UI-free;
 *  useful in tests and for headless agents reasoning about the DOM. */
export function readBindings(el: Element): BindingInfo[];

/** Systems currently subscribed to a path or any path that overlaps it
 *  (a path-key intersection check, same as the engine uses in `tick`).
 *  Returns system names — `'(anon)'` for unnamed functions. */
export function whoSubscribesTo(spektrum: Spektrum, path: string): string[];

/** One-shot static lint pass — currently flags stray `{{…}}` in plain
 *  attribute values (the Vue/Alpine porter footgun that core deliberately
 *  doesn't ship) and `data-fn="name"` references where `name` isn't
 *  registered via `defineFn`. Renders nothing; caller decides. */
export function lint(spektrum: Spektrum, root?: Element): LintFinding[];

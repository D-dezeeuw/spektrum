/**
 * Type declarations for `spektrum/devtools` — the dev-time history
 * scrubber / state panel. If a `spektrum/dock` is mounted it renders
 * as a dock tab; otherwise it free-floats in a corner.
 *
 * Source of truth: `companions/spektrum-devtools.js`. When the runtime
 * shape changes, update this file in the same commit.
 */

import type { Spektrum } from '../spektrum.js';

/** Corner the free-floating panel docks to. */
export type DevtoolsPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Options for {@link mount}. */
export interface DevtoolsOptions {
  /** Corner for the free-floating panel. Defaults to `'bottom-right'`.
   *  Ignored when a dock owns layout. */
  position?: DevtoolsPosition;
  /** Mount target. Defaults to `document.body`. */
  parent?: Element;
  /** Panel title. Defaults to `'spektrum'`. */
  title?: string;
}

/**
 * Mount a devtools panel for the given instance. Returns an `unmount()`
 * that removes the panel, detaches its listeners, and detaches from the
 * dock if it was hosted there.
 */
export function mount(spektrum: Spektrum, opts?: DevtoolsOptions): () => void;

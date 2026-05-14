/**
 * Type declarations for `spektrum/dock` — the shared container that
 * hosts the dev-time companions as tabs.
 *
 * Source of truth: `companions/spektrum-dock.js`. When the runtime
 * shape changes, update this file in the same commit.
 */

/** Which edge the dock anchors to. */
export type DockSide = 'right' | 'bottom';

/** A panel registered with the dock. The companion gets back this
 *  handle and renders its UI into `container`. */
export interface DockPanelHandle {
  readonly id: string;
  readonly label: string;
  /** The Element to render into. Already styled to fill the dock's
   *  content area; companions can `appendChild` and inline-style as
   *  they would any container. */
  readonly container: Element;
  /** Make this the visible tab. */
  activate(): void;
  /** Remove the tab + container *without* invoking `onClose`. Use this
   *  from the companion's own `unmount()` to avoid recursion. */
  detach(): void;
  /** Simulate the user clicking × on the tab — fires `onClose` (so the
   *  companion can tear down its listeners), then detaches. */
  close(): void;
}

export interface DockPanelOptions {
  /** Stable key. Re-registering the same id replaces the prior panel —
   *  re-mounting a companion refreshes, doesn't stack. */
  id: string;
  /** Visible tab label. */
  label: string;
  /** Called when the user clicks × on the tab. Typically `() => unmount()`
   *  — the dock then `detach()`es so a double-detach is a no-op. */
  onClose?: () => void;
}

export interface DockOptions {
  /** Default: `'right'`. */
  side?: DockSide;
  /** Start collapsed to a chip. Default: `false`. */
  collapsed?: boolean;
  /** Container the dock is appended to. Default: `document.body`. */
  parent?: Element;
  /** Header title text. Default: `'spektrum'`. */
  title?: string;
}

/** The dock's public API. `mount(opts)` returns this object; companions
 *  reach it via `findDock()` or by reading `_spektrumDock` off the dock
 *  element. */
export interface DockHandle {
  /** Add a panel. Returns a handle the caller uses to render and clean up. */
  registerPanel(opts: DockPanelOptions): DockPanelHandle;
  /** Open the panel body (no-op if already open). */
  expand(): void;
  /** Shrink to the floating chip (with the active-panel-count badge). */
  collapse(): void;
  /** Switch dock side at runtime. */
  setSide(side: DockSide): void;
  /** Activate a panel by id (no-op if id not registered). */
  setActive(id: string): void;
  /** Live `Map<id, DockPanelHandle>` of registered panels. Read-only by
   *  convention; mutate via registerPanel / detach. */
  readonly panels: Map<string, DockPanelHandle>;
  /** Close every registered panel via its `onClose`, then remove the dock. */
  unmount(): void;
}

/** Mount the dock container. Only one dock should be mounted per page —
 *  companions discover it via `findDock()`, which matches the first
 *  `[data-spektrum-dock]` element. */
export function mount(opts?: DockOptions): DockHandle;

/** Locate the currently mounted dock on the page. Returns its public
 *  API, or `undefined` if no dock is mounted. Companions call this in
 *  their own `mount()` to opt into integration without importing this
 *  module — they look for `[data-spektrum-dock]?._spektrumDock` directly. */
export function findDock(): DockHandle | undefined;

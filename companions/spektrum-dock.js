/*
  Spektrum Dock — shared container for the dev-time companions.

  Without a dock, each companion (devtools / inspect / agent) mounts
  its own floating panel — fine for a single tool, but they overlap
  and clutter the page when several are active. With a dock present,
  each companion auto-detects it and registers as a *tab* inside one
  cohesive UI that can collapse to a chip, expand to a side or bottom
  drawer, and close panels individually.

  The dock is purely a container. It has no knowledge of Spektrum
  state — companions render their own UI into the container element
  the dock hands back from `registerPanel()`.

  Usage:

    import { mount as mountDock }    from 'spektrum/dock';
    import { mount as mountDevtools } from 'spektrum/devtools';
    import { mount as mountInspect }  from 'spektrum/inspect';

    mountDock();                     // create the container first
    mountDevtools(spektrum);         // auto-detects the dock
    mountInspect(spektrum);          // auto-detects the dock

  Each companion's mount/unmount lifecycle is unchanged from the
  caller's perspective — it just renders inside the dock instead of
  floating standalone.
*/

const CSS = `
[data-spektrum-dock]{position:fixed;z-index:2147483646;font-family:ui-monospace,Menlo,monospace;font-size:11px;background:rgba(15,15,16,.96);color:#ddd;border:1px solid #2a2a2e;border-radius:6px;display:flex;flex-direction:column;backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,.4)}
[data-spektrum-dock].r{top:12px;right:12px;width:min(420px,calc(100vw - 24px));height:min(80vh,calc(100vh - 24px))}
[data-spektrum-dock].b{left:12px;right:12px;bottom:12px;height:min(400px,60vh)}
[data-spektrum-dock].c{width:auto;height:auto;padding:0}
[data-spektrum-dock] .dh{display:flex;align-items:center;border-bottom:1px solid #2a2a2e;padding:4px 8px;gap:4px;cursor:default;user-select:none}
[data-spektrum-dock].c .dh{border-bottom:0}
[data-spektrum-dock] .dh>b{font-size:10px;letter-spacing:.2em;color:#888;font-weight:700}
[data-spektrum-dock] .dh>i{flex:1}
[data-spektrum-dock] button{background:transparent;border:0;color:#888;font:inherit;padding:2px 6px;cursor:pointer;border-radius:3px}
[data-spektrum-dock] button:hover{color:#ddd;background:#2a2a2e}
[data-spektrum-dock] .dt{display:flex;border-bottom:1px solid #2a2a2e;overflow-x:auto}
[data-spektrum-dock].c .dt{display:none}
[data-spektrum-dock] .dt button{padding:6px 10px;color:#888;border-bottom:2px solid transparent;border-radius:0;white-space:nowrap;display:flex;gap:4px;align-items:center}
[data-spektrum-dock] .dt button.a{color:#ddd;border-bottom-color:#4ade80}
[data-spektrum-dock] .dt button .xc{font-size:10px;opacity:.5;padding:0 2px}
[data-spektrum-dock] .dt button:hover .xc{opacity:1}
[data-spektrum-dock] .dc{flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0}
[data-spektrum-dock].c .dc{display:none}
[data-spektrum-dock] .dp{flex:1;overflow:auto;min-height:0;display:none}
[data-spektrum-dock] .dp.a{display:flex;flex-direction:column}
[data-spektrum-dock] .empty{color:#666;padding:16px;text-align:center;font-style:italic}
[data-spektrum-dock] .chip{padding:6px 10px;display:flex;align-items:center;gap:6px;cursor:pointer}
[data-spektrum-dock] .chip .badge{background:#4ade80;color:#0a0a0a;border-radius:8px;padding:0 5px;font-size:9px;font-weight:700;min-width:14px;text-align:center}
`;

const SIDES = { right: 'r', bottom: 'b' };

const injectCss = () => {
  if (document.querySelector('[data-spektrum-dock-css]')) return;
  const s = document.createElement('style');
  s.setAttribute('data-spektrum-dock-css', '');
  s.textContent = CSS;
  document.head.appendChild(s);
};

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Locate the currently mounted dock on the page. Returns its public
 *  registration API, or `undefined` if no dock is mounted. Companions
 *  call this in their own `mount()` to opt into integration. */
export const findDock = () =>
  document.querySelector('[data-spektrum-dock]')?._spektrumDock;

/**
 * Mount the dock container.
 *
 * @param {object} [opts]
 * @param {'right'|'bottom'} [opts.side='right']
 * @param {boolean} [opts.collapsed=false] Start collapsed (chip-only).
 * @param {Element} [opts.parent=document.body]
 * @param {string} [opts.title='spektrum']
 * @returns {object} dock handle with registerPanel/expand/collapse/unmount
 */
export const mount = (opts = {}) => {
  injectCss();
  const parent = opts.parent || document.body;
  let side = SIDES[opts.side] || 'r';
  let collapsed = !!opts.collapsed;
  const title = opts.title || 'spektrum';

  const root = document.createElement('div');
  root.setAttribute('data-spektrum-dock', '');
  root.innerHTML = `
    <div class="dh">
      <b>${escapeHtml(title)}</b>
      <i></i>
      <button data-act="side" title="dock side">⇆</button>
      <button data-act="toggle" title="collapse / expand">▾</button>
    </div>
    <div class="dt" role="tablist"></div>
    <div class="dc"></div>
    <div class="chip" data-chip style="display:none;"><b>⌘</b><span class="badge" data-count>0</span></div>
  `;
  parent.appendChild(root);

  const tabsEl  = root.querySelector('.dt');
  const contEl  = root.querySelector('.dc');
  const chipEl  = root.querySelector('[data-chip]');
  const countEl = root.querySelector('[data-count]');
  const toggleBtn = root.querySelector('[data-act="toggle"]');

  const panels = new Map();           // id → { id, label, button, container, onClose }
  let activeId = null;

  const applySide = () => {
    root.classList.remove('r', 'b');
    if (!collapsed) root.classList.add(side);
  };
  const applyCollapsed = () => {
    root.classList.toggle('c', collapsed);
    if (!collapsed) applySide();
    toggleBtn.textContent = collapsed ? '▴' : '▾';
    chipEl.style.display = collapsed ? 'flex' : 'none';
    countEl.textContent = String(panels.size);
  };
  const renderEmpty = () => {
    if (panels.size) return;
    contEl.innerHTML = `<div class="empty">No panels mounted.<br>Import a companion (devtools / inspect / agent) and call its <code>mount(spektrum)</code> — it will register here.</div>`;
  };

  const setActive = (id) => {
    if (!panels.has(id)) return;
    activeId = id;
    for (const p of panels.values()) {
      p.button.classList.toggle('a', p.id === id);
      p.container.classList.toggle('a', p.id === id);
    }
  };

  /** Add a panel to the dock. Returns a handle the caller uses to
   *  remove the panel (in addition to its own cleanup) and to flip
   *  to it programmatically. */
  const registerPanel = ({ id, label, onClose }) => {
    if (panels.has(id)) {
      // Replace existing — re-mounting a companion should refresh, not stack.
      panels.get(id).detach();
    }
    contEl.querySelector('.empty')?.remove();
    const container = document.createElement('div');
    container.className = 'dp';
    container.setAttribute('data-panel', id);
    contEl.appendChild(container);

    const button = document.createElement('button');
    button.setAttribute('data-panel-tab', id);
    button.innerHTML = `<span>${escapeHtml(label)}</span><span class="xc" title="close" data-x>×</span>`;
    button.addEventListener('click', (ev) => {
      if (ev.target.dataset?.x !== undefined) { panel.close(); return; }
      setActive(id);
    });
    tabsEl.appendChild(button);

    const panel = {
      id, label, button, container, onClose,
      activate: () => setActive(id),
      detach() {
        // Remove tab + content without invoking onClose. Used by the
        // companion's own unmount() and by re-register.
        button.remove();
        container.remove();
        panels.delete(id);
        if (activeId === id) {
          activeId = null;
          const next = panels.values().next().value;
          if (next) setActive(next.id);
          else renderEmpty();
        }
        countEl.textContent = String(panels.size);
      },
      close() {
        // User clicked × on the tab — cascade to the companion so it
        // can tear down its listeners, then remove from the dock.
        try { onClose?.(); } catch (err) { console.error('[spektrum.dock] onClose threw', err); }
        // onClose typically calls detach() through the companion's unmount;
        // double-detach is a no-op (Map.delete on missing id is safe).
        if (panels.has(id)) panel.detach();
      },
    };
    panels.set(id, panel);
    countEl.textContent = String(panels.size);
    if (!activeId) setActive(id);
    return panel;
  };

  // Header buttons
  toggleBtn.addEventListener('click', () => { collapsed = !collapsed; applyCollapsed(); });
  root.querySelector('[data-act="side"]').addEventListener('click', () => {
    side = side === 'r' ? 'b' : 'r';
    applySide();
  });
  chipEl.addEventListener('click', () => { collapsed = false; applyCollapsed(); });

  applySide();
  applyCollapsed();
  renderEmpty();

  // Expose the registration API on the root element so companions can
  // discover it via DOM lookup without needing to import this module.
  const api = {
    registerPanel,
    expand:   () => { collapsed = false; applyCollapsed(); },
    collapse: () => { collapsed = true;  applyCollapsed(); },
    setSide: (s) => { if (SIDES[s]) { side = SIDES[s]; applySide(); } },
    setActive,
    panels,
    unmount() {
      // Cascade close to every registered panel so companions clean up
      // listeners; then remove the dock root.
      for (const p of [...panels.values()]) p.close();
      root.remove();
    },
  };
  root._spektrumDock = api;
  return api;
};

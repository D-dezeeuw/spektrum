/*
  Spektrum DevTools — a tiny floating scrubber for time-travel.

  History and replay are Spektrum's distinguishing primitives, but
  they're invisible without a UI. This module mounts a small
  fixed-position panel that exposes them: scrub a slider over the
  recorded mutations, watch state rewind in real time.

  Standalone module, zero deps, ~150 lines. Not bundled into
  spektrum.js — opt in only when you need it (typically in
  development).

  Usage:

    import { mount } from 'spektrum/devtools';
    const unmount = mount(spektrum);     // default singleton
    // ...
    unmount();                            // remove the panel

  Pass `{ position: 'bottom-left' }` etc. to relocate. Pass an
  instance returned by createSpektrum() to inspect that one.
*/

const STYLES = `
  position: fixed;
  z-index: 2147483647;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  background: rgba(15, 15, 16, 0.94);
  color: #ddd;
  border: 1px solid #2a2a2e;
  border-radius: 6px;
  padding: 10px 12px;
  width: min(260px, calc(100vw - 24px));
  backdrop-filter: blur(6px);
  user-select: none;
`;

const corners = {
  'top-right':    'top: 12px; right: 12px;',
  'top-left':     'top: 12px; left: 12px;',
  'bottom-right': 'bottom: 12px; right: 12px;',
  'bottom-left':  'bottom: 12px; left: 12px;',
};

/**
 * Mount a devtools panel for the given Spektrum instance.
 *
 * @param {object} spektrum - instance from `createSpektrum()` or the default singleton
 * @param {object} [opts]
 * @param {'top-right'|'top-left'|'bottom-right'|'bottom-left'} [opts.position='bottom-right']
 * @param {Element} [opts.parent=document.body]
 * @param {string} [opts.title='spektrum']
 * @returns {() => void} unmount
 */
export const mount = (spektrum, opts = {}) => {
  const parent = opts.parent || document.body;
  const position = opts.position || 'bottom-right';
  const title = opts.title || 'spektrum';

  const root = document.createElement('div');
  root.setAttribute('data-spektrum-devtools', '');
  root.style.cssText = STYLES + (corners[position] || corners['bottom-right']);

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <strong style="font-size:10px;letter-spacing:0.18em;color:#888;">${escapeHtml(title)}</strong>
      <button data-act="live" style="background:transparent;border:1px solid #36363c;color:#ddd;border-radius:3px;padding:2px 6px;font:inherit;cursor:pointer;">live</button>
    </div>
    <div data-cursor style="font-variant-numeric:tabular-nums;color:#4ade80;margin-bottom:6px;"></div>
    <input data-scrub type="range" min="0" max="0" value="0" step="1" style="width:100%;margin-bottom:8px;">
    <div data-log style="max-height:120px;overflow-y:auto;font-size:10px;color:#888;line-height:1.5;border-top:1px solid #2a2a2e;padding-top:6px;"></div>
  `;
  parent.appendChild(root);

  const cursorEl = root.querySelector('[data-cursor]');
  const scrubEl = root.querySelector('[data-scrub]');
  const logEl = root.querySelector('[data-log]');
  const liveBtn = root.querySelector('[data-act="live"]');

  // Render is cheap; rAF-driven so we don't have to subscribe to
  // anything. The panel is dev-only; the cost is irrelevant.
  let stopped = false;
  let lastLen = -1;
  let lastCursor = -1;

  const render = () => {
    if (stopped) return;
    const h = spektrum.history;
    const c = spektrum.cursor;
    if (h.length !== lastLen || c !== lastCursor) {
      cursorEl.textContent = `cursor ${c} / ${h.length}`;
      scrubEl.max = String(h.length);
      // Don't fight the user's drag.
      if (document.activeElement !== scrubEl) scrubEl.value = String(c);
      // Show the last 12 entries; newest at top.
      const start = Math.max(0, h.length - 12);
      logEl.innerHTML = h.slice(start).reverse().map((e, i) => {
        const idx = h.length - 1 - i;
        const at = idx < c;
        const dim = at ? '#888' : '#444';
        const op = e.op === 'add' ? `+${e.value}` : `=${truncate(e.value)}`;
        return `<div style="color:${dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          <span style="color:${at ? '#4ade80' : '#444'};">${idx}</span>
          <span style="color:${dim};"> ${escapeHtml(e.path)}</span>
          <span style="color:${dim};"> ${escapeHtml(op)}</span>
        </div>`;
      }).join('');
      lastLen = h.length;
      lastCursor = c;
    }
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);

  const onScrub = () => spektrum.replay(Number(scrubEl.value));
  scrubEl.addEventListener('input', onScrub);

  const onLive = () => spektrum.replay(spektrum.history.length);
  liveBtn.addEventListener('click', onLive);

  return () => {
    stopped = true;
    scrubEl.removeEventListener('input', onScrub);
    liveBtn.removeEventListener('click', onLive);
    root.remove();
  };
};

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const truncate = (v) => {
  const s = typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
  return s == null ? String(v) : (s.length > 20 ? s.slice(0, 19) + '…' : s);
};

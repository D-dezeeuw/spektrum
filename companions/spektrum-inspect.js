/*
  Spektrum Inspect — developer-time DX panel.

  Three features in one opt-in companion: an Element Inspector (hover
  any node, see its bindings + current values), a Mutation Tracer
  (live log of every record, annotated with which systems fired), and
  a Static Lint pass (one-shot scan for stray `{{…}}` in attributes
  and references to undefined `data-fn` names).

  Standalone module, zero deps. Mount via the same shape as
  spektrum/devtools — calling `mount(spektrum, opts)` returns an
  unmount thunk. Auto-detects existing devtools / inspect panels and
  picks a free corner so they don't overlap.

  Usage:

    import { mount } from 'spektrum/inspect';
    const unmount = mount(spektrum);
    unmount();

  Pass `{ position: 'top-left' }` to override; pass `{ features: [...] }`
  to render a subset of tabs (default: all). The programmatic helpers
  (readBindings, lint, whoSubscribesTo) are exported separately for
  tests and headless agents.
*/

import { getPathObj } from '../spektrum.js';

// Scoped via the [data-spektrum-inspect] root attribute. One stylesheet
// per page (cssInjected guard); panel elements add no inline styles.
// `S` is the common prefix; `T` and `O` are the standalone selectors
// for the tooltip and outline (which live outside the panel root).
const S = '[data-spektrum-inspect]';
const T = '[data-spektrum-inspect-tip]';
const O = '[data-spektrum-inspect-outline]';
const FONT = 'font-family:ui-monospace,Menlo,monospace;font-size:11px';
const BG   = 'background:rgba(15,15,16,.94);color:#ddd;border:1px solid #2a2a2e';
const CSS = `
${S},${T}{${FONT};${BG};border-radius:4px}
${S}{position:fixed;z-index:2147483646;width:min(360px,calc(100vw - 24px));max-height:min(480px,calc(100vh - 24px));display:flex;flex-direction:column;backdrop-filter:blur(6px)}
${T}{position:fixed;z-index:2147483647;pointer-events:none;padding:6px 8px;max-width:360px;white-space:pre-wrap;line-height:1.4}
${O}{position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #4ade80}
${S} .h{display:flex;align-items:center;border-bottom:1px solid #2a2a2e;padding:4px 6px;gap:2px}
${S} .h>b{font-size:10px;letter-spacing:.18em;color:#888;margin-right:6px}
${S} .h>i{flex:1}
${S} button{background:transparent;border:0;color:#888;padding:4px 8px;font:inherit;cursor:pointer;border-bottom:1px solid transparent}
${S} .x{background:#1f1f23;border:1px solid #36363c;color:#ddd;border-radius:3px;padding:2px 8px;margin-bottom:6px}
${S} button.a{color:#ddd;border-bottom-color:#4ade80}
${S} .x.on{border-color:#4ade80}
${S} .p{flex:1;overflow:auto;padding:8px 10px;display:none}
${S} .p.a{display:block}
${S} .row{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#888;line-height:1.5;font-size:10px}
${S} em{color:#4ade80;font-style:normal}
${S} s{color:#888;text-decoration:none}
${S} q{color:#666;quotes:none}
${S} .cp{color:#fcd34d}
${S} .f{margin-bottom:6px;padding:4px 6px;background:#1f1f23;border-left:2px solid #fbbf24}
${S} .f i{color:#666;font-size:10px;font-style:normal}
${S} .ok{color:#4ade80}
${S} input{flex:1;background:#1f1f23;border:1px solid #36363c;color:#ddd;border-radius:3px;padding:2px 6px;font:inherit}
${S} .bar{display:flex;gap:4px;margin-bottom:6px}
${S} .info{white-space:pre-wrap;color:#aaa}
`;

const CORNERS = {
  'top-left':     'top:12px;left:12px',
  'top-right':    'top:12px;right:12px',
  'bottom-left':  'bottom:12px;left:12px',
  'bottom-right': 'bottom:12px;right:12px',
};

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const truncate = (v, n = 40) => {
  let s; try { s = typeof v === 'string' ? `"${v}"` : JSON.stringify(v); } catch { s = String(v); }
  if (s == null) s = String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Simple identifier / dotted-path test — covers ~80% of binding
// expressions. Anything else (calls, operators, ternaries) is shown as
// source rather than re-evaluated; re-evaluating would either duplicate
// `new Function` work or break under strict CSP.
const SIMPLE_PATH = /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*|\.\d+)*$/;
const tryEval = (expr, state) => SIMPLE_PATH.test(expr) ? getPathObj(state, expr) : undefined;
const evalSuffix = (expr, state) => SIMPLE_PATH.test(expr) ? ` = ${escapeHtml(truncate(tryEval(expr, state)))}` : '';

/** Read every declarative binding on `el` into a plain-JS array.
 *  Exported so tests and headless agents can use it without UI. */
export const readBindings = (el) => {
  const out = [];
  for (const a of el.attributes) {
    const n = a.name, v = a.value;
    if (n[0] === ':') out.push({ kind: 'attr', name: n.slice(1), expr: v });
    else if (n === 'data-if') out.push({ kind: 'if', expr: v });
    else if (n === 'data-each') out.push({ kind: 'each', path: v, as: el.dataset.as || 'item', key: el.dataset.key });
    else if (n === 'data-model') out.push({ kind: 'model', path: v });
    else if (n === 'data-ref') out.push({ kind: 'ref', name: v });
    else if (n === 'data-intent') out.push({ kind: 'intent', name: v });
    else if (n === 'data-action') out.push({ kind: 'action', event: v, fn: el.dataset.fn, id: el.dataset.id });
  }
  for (const node of el.childNodes) {
    if (node.nodeType === 3 && node.textContent.includes('{{')) {
      for (const m of node.textContent.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
        out.push({ kind: 'text', expr: m[1].trim() });
      }
    }
  }
  return out;
};

const findLoopContext = (el) => {
  let cur = el.parentElement;
  while (cur) {
    if (cur.dataset?.each) return { path: cur.dataset.each, as: cur.dataset.as || 'item' };
    cur = cur.parentElement;
  }
  return null;
};

/** Systems currently subscribed to a path or any path that overlaps it. */
export const whoSubscribesTo = (spektrum, path) =>
  spektrum.describe().systems
    .filter(s => s.paths.some(p =>
      p === path || path.startsWith(p + '.') || p.startsWith(path + '.')))
    .map(s => s.name || '(anon)');

/** One-shot static lint pass. Returns `{ kind, msg, el }` findings. */
export const lint = (spektrum, root = document.body) => {
  const out = [];
  const fnNames = new Set(spektrum.describe().fns.map(f => f.name));
  for (const el of root.querySelectorAll('*')) {
    if (el.closest('[data-spektrum-inspect],[data-spektrum-devtools]')) continue;
    for (const a of el.attributes) {
      if (a.name[0] !== ':' && !a.name.startsWith('data-') && a.value.includes('{{')) {
        out.push({ kind: 'warn', msg: `{{…}} in "${a.name}" — mustache works in text nodes only; use :${a.name}="…"`, el });
      }
    }
    if (el.dataset.fn && el.dataset.action && !fnNames.has(el.dataset.fn)) {
      out.push({ kind: 'warn', msg: `data-fn="${el.dataset.fn}" is not registered`, el });
    }
  }
  return out;
};

/** Pick a corner not already taken by a devtools / inspect panel. */
const pickCorner = () => {
  const taken = new Set();
  for (const p of document.querySelectorAll('[data-spektrum-devtools],[data-spektrum-inspect]')) {
    const s = p.style;
    if (s.top && s.left)     taken.add('top-left');
    if (s.top && s.right)    taken.add('top-right');
    if (s.bottom && s.left)  taken.add('bottom-left');
    if (s.bottom && s.right) taken.add('bottom-right');
  }
  return Object.keys(CORNERS).find(c => !taken.has(c)) || 'top-left';
};

// DOM-based dedupe instead of a module flag — survives `document.head`
// resets in test setups and lets users remove + re-inject manually.
const injectCss = () => {
  if (document.querySelector('[data-spektrum-inspect-css]')) return;
  const s = document.createElement('style');
  s.setAttribute('data-spektrum-inspect-css', '');
  s.textContent = CSS;
  document.head.appendChild(s);
};

const formatBinding = (b, state) => {
  if (b.kind === 'attr')   return `  :${escapeHtml(b.name)}  →  ${escapeHtml(b.expr)}${evalSuffix(b.expr, state)}`;
  if (b.kind === 'if')     return `  data-if  →  ${escapeHtml(b.expr)}${evalSuffix(b.expr, state)}`;
  if (b.kind === 'each')   { const v = tryEval(b.path, state); return `  data-each  →  ${escapeHtml(b.path)}  (length: ${Array.isArray(v) ? v.length : '?'}${b.key ? `, key: ${escapeHtml(b.key)}` : ''})`; }
  if (b.kind === 'model')  return `  data-model  →  ${escapeHtml(b.path)}  = ${escapeHtml(truncate(tryEval(b.path, state)))}`;
  if (b.kind === 'ref')    return `  data-ref  →  ${escapeHtml(b.name)}`;
  if (b.kind === 'intent') return `  data-intent  →  ${escapeHtml(b.name)}`;
  if (b.kind === 'action') return `  data-action="${escapeHtml(b.event)}" data-fn="${escapeHtml(b.fn || '?')}"${b.id ? ` data-id="${escapeHtml(b.id)}"` : ''}`;
  return `  {{${escapeHtml(b.expr)}}}${evalSuffix(b.expr, state)}`;
};

const formatElement = (el, state) => {
  const bs = readBindings(el);
  const loop = findLoopContext(el);
  const cls = (el.className && typeof el.className === 'string') ? el.className : '';
  const tag = `<em>&lt;${el.tagName.toLowerCase()}${el.id ? ` id="${escapeHtml(el.id)}"` : ''}${cls ? ` class="${escapeHtml(cls)}"` : ''}&gt;</em>`;
  let s = tag + '\n';
  s += bs.length
    ? `<s>bindings:</s>\n${bs.map(b => formatBinding(b, state)).join('\n')}`
    : `<s>  (no bindings)</s>`;
  if (loop) s += `\n<s>inside loop:</s>\n  data-each  →  ${escapeHtml(loop.path)}  (as ${escapeHtml(loop.as)})`;
  return s;
};

/**
 * Mount the inspector for the given Spektrum instance.
 *
 * @param {object} spektrum - instance from `createSpektrum()` or default
 * @param {object} [opts]
 * @param {'top-left'|'top-right'|'bottom-left'|'bottom-right'} [opts.position]
 *   Defaults to the first free corner (avoids existing devtools / inspect).
 * @param {Element} [opts.parent=document.body]
 * @param {Array<'elements'|'mutations'|'lint'>} [opts.features]
 *   Subset of tabs to render. Defaults to all three.
 * @returns {() => void} unmount
 */
export const mount = (spektrum, opts = {}) => {
  injectCss();
  const parent = opts.parent || document.body;
  const features = opts.features || ['elements', 'mutations', 'lint'];

  // Dock integration: when a dock is mounted, register as a tab and
  // skip our own fixed-position chrome (the dock owns positioning).
  // The tooltip + outline overlays stay free-floating since they
  // need to anchor to arbitrary elements on the page.
  const dock = document.querySelector('[data-spektrum-dock]')?._spektrumDock;
  let dockPanel = null;
  const root = document.createElement('div');
  root.setAttribute('data-spektrum-inspect', '');
  if (dock) {
    dockPanel = dock.registerPanel({ id: 'inspect', label: 'Inspect', onClose: () => unmount() });
    // Inside the dock we use a flat layout — fill the container, no
    // outer border/shadow (the dock provides them).
    root.style.cssText = 'position:static;width:auto;max-height:none;height:100%;border:0;border-radius:0;background:transparent;box-shadow:none;';
    dockPanel.container.appendChild(root);
  } else {
    const position = opts.position || pickCorner();
    root.style.cssText = CORNERS[position] || CORNERS['top-left'];
    parent.appendChild(root);
  }

  const tabBtn = (id, label) => `<button data-tab="${id}">${label}</button>`;
  const pane = (id, html) => `<div class="p" data-pane="${id}">${html}</div>`;

  root.innerHTML = `
    <div class="h">
      ${dock ? '' : '<b>inspect</b>'}
      ${features.includes('elements')  ? tabBtn('el',   'Elements')  : ''}
      ${features.includes('mutations') ? tabBtn('mut',  'Mutations') : ''}
      ${features.includes('lint')      ? tabBtn('lint', 'Lint')      : ''}
      <i></i>
      ${dock ? '' : '<button data-act="close">×</button>'}
    </div>
    ${features.includes('elements')  ? pane('el',   `<button class="x" data-act="inspect-mode">🎯 inspect element</button><div class="info" data-content="info">Click <em>inspect element</em>, then hover anything. Click an element to pin it. Esc to exit.</div>`) : ''}
    ${features.includes('mutations') ? pane('mut',  `<div class="bar"><button class="x" data-act="pause">⏸ pause</button><input data-filter placeholder="filter path…"><button class="x" data-act="clear">clear</button></div><div data-log></div>`) : ''}
    ${features.includes('lint')      ? pane('lint', `<button class="x" data-act="re-lint">re-run lint</button><div data-findings></div>`) : ''}
  `;

  const tabs = [...root.querySelectorAll('[data-tab]')];
  const panes = [...root.querySelectorAll('[data-pane]')];
  const setTab = (id) => {
    for (const b of tabs) b.classList.toggle('a', b.dataset.tab === id);
    for (const p of panes) p.classList.toggle('a', p.dataset.pane === id);
  };
  if (tabs[0]) setTab(tabs[0].dataset.tab);

  // === Element Inspector ===

  let inspectMode = false;
  let pinned = null;
  const tip = document.createElement('div');
  tip.setAttribute('data-spektrum-inspect-tip', '');
  tip.style.display = 'none';
  parent.appendChild(tip);
  const outline = document.createElement('div');
  outline.setAttribute('data-spektrum-inspect-outline', '');
  outline.style.display = 'none';
  parent.appendChild(outline);

  const infoEl = root.querySelector('[data-content="info"]');
  const inspectBtn = root.querySelector('[data-act="inspect-mode"]');
  const refreshBtn = () => inspectBtn?.classList.toggle('on', inspectMode);

  const showFor = (el, x, y) => {
    const html = formatElement(el, spektrum.appState);
    tip.innerHTML = html;
    tip.style.display = 'block';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(x + 12, innerWidth - w - 8) + 'px';
    tip.style.top  = Math.min(y + 12, innerHeight - h - 8) + 'px';
    const r = el.getBoundingClientRect();
    outline.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;display:block`;
    if (infoEl) infoEl.innerHTML = html;
  };
  const hideFloaters = () => { if (!pinned) { tip.style.display = 'none'; outline.style.display = 'none'; } };

  const isOwn = (el) => !(el instanceof Element) || el.closest('[data-spektrum-inspect],[data-spektrum-inspect-tip],[data-spektrum-inspect-outline],[data-spektrum-devtools]');

  const onMove = (ev) => {
    if (!inspectMode || pinned) return;
    if (isOwn(ev.target)) return hideFloaters();
    showFor(ev.target, ev.clientX, ev.clientY);
  };
  const onClick = (ev) => {
    if (!inspectMode || isOwn(ev.target)) return;
    ev.preventDefault(); ev.stopPropagation();
    pinned = ev.target;
    showFor(pinned, ev.clientX, ev.clientY);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { pinned = null; inspectMode = false; hideFloaters(); refreshBtn(); } };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click',     onClick, true);
  document.addEventListener('keydown',   onKey);

  // === Mutation Tracer ===

  const ring = [];
  let paused = false;
  let filterRe = null;
  const logEl = root.querySelector('[data-log]');
  const renderLog = () => {
    if (!logEl) return;
    const rows = (filterRe ? ring.filter(r => filterRe.test(r.path || '')) : ring).slice(-100).reverse();
    logEl.innerHTML = rows.map(r => {
      const isCp = r.op === 'checkpoint';
      const op = isCp ? `◆ ${escapeHtml(r.id)}` : (r.op === 'add' ? '+' : '=') + escapeHtml(truncate(r.value, 20));
      const cls = isCp ? 'row cp' : 'row';
      return `<div class="${cls}"><em>${escapeHtml(r.path)}</em> ${op}${r.triggers.length ? `<q>  →  ${r.triggers.map(escapeHtml).join(', ')}</q>` : ''}</div>`;
    }).join('');
  };
  const stopRecord = spektrum.onRecord(entry => {
    if (paused) return;
    ring.push({ ...entry, triggers: entry.op === 'checkpoint' ? [] : whoSubscribesTo(spektrum, entry.path) });
    if (ring.length > 500) ring.shift();
    renderLog();
  });

  // === Lint ===

  const findingsEl = root.querySelector('[data-findings]');
  // runLint is only invoked when findingsEl exists (initial mount gated
  // by `features.includes('lint')`, re-lint button only present in the
  // lint pane). No null-guard needed.
  const runLint = () => {
    const res = lint(spektrum, document.body);
    findingsEl.innerHTML = res.length
      ? res.map(f => `<div class="f">${escapeHtml(f.msg)}<i>&lt;${escapeHtml(f.el.tagName.toLowerCase())}${f.el.id ? ` id="${escapeHtml(f.el.id)}"` : ''}&gt;</i></div>`).join('')
      : `<div class="ok">✓ no findings</div>`;
  };

  // === Wire panel buttons ===

  root.addEventListener('click', (ev) => {
    // Defense-in-depth — the DOM spec gives Elements for mouse-event
    // targets, but synthetic events (tests, dev tools, future Shadow
    // DOM) can break that. Bail before `t.dataset.tab` throws.
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.dataset.tab) setTab(t.dataset.tab);
    else if (t.dataset.act === 'close')        unmount();
    else if (t.dataset.act === 'inspect-mode') { inspectMode = !inspectMode; pinned = null; if (!inspectMode) hideFloaters(); refreshBtn(); }
    else if (t.dataset.act === 'pause')        { paused = !paused; t.textContent = paused ? '▶ resume' : '⏸ pause'; }
    else if (t.dataset.act === 'clear')        { ring.length = 0; renderLog(); }
    else if (t.dataset.act === 're-lint')      runLint();
  });
  const filterInput = root.querySelector('[data-filter]');
  if (filterInput) filterInput.addEventListener('input', () => {
    const v = filterInput.value.trim();
    try { filterRe = v ? new RegExp(v) : null; } catch { filterRe = null; }
    renderLog();
  });

  if (features.includes('lint')) runLint();

  const unmount = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click',     onClick, true);
    document.removeEventListener('keydown',   onKey);
    stopRecord();
    root.remove();
    tip.remove();
    outline.remove();
    dockPanel?.detach();
  };
  return unmount;
};

/*
  Tests for spektrum/dock — the shared container for dev companions —
  plus the dock-aware integration in spektrum/devtools and
  spektrum/inspect. Agent has the same integration pattern; we trust
  parity (its mount() body is exercised by the demo).
*/

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSpektrum } from '../spektrum.js';
import { mount as mountDock, findDock } from '../companions/spektrum-dock.js';
import { mount as mountDevtools } from '../companions/spektrum-devtools.js';
import { mount as mountInspect } from '../companions/spektrum-inspect.js';

let s;
beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  s = createSpektrum();
});

// === Dock lifecycle ===

test('mount creates the dock element and findDock returns its API', () => {
  const dock = mountDock();
  assert.ok(document.querySelector('[data-spektrum-dock]'));
  assert.equal(findDock(), dock);
  assert.equal(typeof dock.registerPanel, 'function');
  assert.equal(typeof dock.expand, 'function');
  assert.equal(typeof dock.collapse, 'function');
  dock.unmount();
  assert.equal(document.querySelector('[data-spektrum-dock]'), null);
  assert.equal(findDock(), undefined);
});

test('dock injects its stylesheet exactly once across mounts', () => {
  const d1 = mountDock();
  const d2 = mountDock({ side: 'bottom' });
  assert.equal(document.querySelectorAll('[data-spektrum-dock-css]').length, 1);
  d1.unmount(); d2.unmount();
});

test('registerPanel returns a handle with a container Element', () => {
  const dock = mountDock();
  const panel = dock.registerPanel({ id: 'foo', label: 'Foo' });
  assert.ok(panel.container instanceof Element);
  assert.equal(panel.container.dataset.panel, 'foo');
  assert.equal(panel.id, 'foo');
  dock.unmount();
});

test('registering two panels creates two tab buttons; first is active', () => {
  const dock = mountDock();
  dock.registerPanel({ id: 'a', label: 'A' });
  dock.registerPanel({ id: 'b', label: 'B' });
  const buttons = document.querySelectorAll('[data-spektrum-dock] [data-panel-tab]');
  assert.equal(buttons.length, 2);
  const active = [...buttons].filter(b => b.classList.contains('a'));
  assert.equal(active.length, 1);
  assert.equal(active[0].dataset.panelTab, 'a');
  dock.unmount();
});

test('panel.detach removes tab + container without firing onClose', () => {
  const dock = mountDock();
  let closed = false;
  const panel = dock.registerPanel({ id: 'x', label: 'X', onClose: () => { closed = true; } });
  panel.detach();
  assert.equal(closed, false, 'detach() is for proactive removal — no onClose');
  assert.equal(document.querySelector('[data-panel="x"]'), null);
  assert.equal(document.querySelector('[data-panel-tab="x"]'), null);
  dock.unmount();
});

test('panel.close fires onClose (companions tear down their listeners)', () => {
  const dock = mountDock();
  let closed = false;
  const panel = dock.registerPanel({ id: 'x', label: 'X', onClose: () => { closed = true; } });
  panel.close();
  assert.equal(closed, true);
  assert.equal(document.querySelector('[data-panel="x"]'), null);
  dock.unmount();
});

test('re-registering the same id replaces the prior panel (no stacking)', () => {
  const dock = mountDock();
  dock.registerPanel({ id: 'x', label: 'X' });
  dock.registerPanel({ id: 'x', label: 'X2' });
  const tabs = document.querySelectorAll('[data-panel-tab="x"]');
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].textContent.trim().replace(/×$/, '').trim(), 'X2');
  dock.unmount();
});

test('collapse hides the tab strip and content; expand restores', () => {
  const dock = mountDock();
  dock.registerPanel({ id: 'x', label: 'X' });
  const root = document.querySelector('[data-spektrum-dock]');
  dock.collapse();
  assert.ok(root.classList.contains('c'), 'collapsed class applied');
  dock.expand();
  assert.equal(root.classList.contains('c'), false);
  dock.unmount();
});

test('dock.unmount cascades close to every registered panel', () => {
  const dock = mountDock();
  let aClosed = false, bClosed = false;
  dock.registerPanel({ id: 'a', label: 'A', onClose: () => { aClosed = true; } });
  dock.registerPanel({ id: 'b', label: 'B', onClose: () => { bClosed = true; } });
  dock.unmount();
  assert.ok(aClosed, 'panel A onClose fired');
  assert.ok(bClosed, 'panel B onClose fired');
});

// === Devtools integration ===

test('devtools mounted alongside a dock renders inside it (no free-floating panel)', () => {
  const dock = mountDock();
  const stop = mountDevtools(s);
  // Tab registered.
  assert.ok(document.querySelector('[data-spektrum-dock] [data-panel-tab="devtools"]'),
    'devtools tab appears in dock');
  // No free-floating devtools panel.
  const dt = document.querySelectorAll('[data-spektrum-devtools]');
  // Exactly one element (the inner one), and it lives inside the dock.
  assert.equal(dt.length, 1);
  assert.ok(dt[0].closest('[data-spektrum-dock]'));
  stop(); dock.unmount();
});

test('devtools mounted without a dock keeps its free-floating panel (backward compat)', () => {
  const stop = mountDevtools(s);
  const dt = document.querySelector('[data-spektrum-devtools]');
  // Standalone panel sits directly in body, not inside any dock.
  assert.ok(dt);
  assert.equal(dt.closest('[data-spektrum-dock]'), null);
  // Has its corner positioning applied.
  assert.ok(dt.style.position === 'fixed' || dt.style.bottom || dt.style.right);
  stop();
});

test('devtools unmount inside dock removes its tab', () => {
  const dock = mountDock();
  const stop = mountDevtools(s);
  assert.ok(document.querySelector('[data-panel-tab="devtools"]'));
  stop();
  assert.equal(document.querySelector('[data-panel-tab="devtools"]'), null);
  dock.unmount();
});

// === Inspect integration ===

test('inspect mounted alongside a dock renders inside it', () => {
  const dock = mountDock();
  const stop = mountInspect(s);
  assert.ok(document.querySelector('[data-spektrum-dock] [data-panel-tab="inspect"]'),
    'inspect tab appears in dock');
  // Inspect's panel is now inside the dock; the tooltip + outline
  // overlays stay free-floating (they need to anchor anywhere).
  const panel = document.querySelector('[data-spektrum-inspect]');
  assert.ok(panel?.closest('[data-spektrum-dock]'), 'inspect panel lives inside dock');
  assert.ok(document.querySelector('[data-spektrum-inspect-tip]'), 'tooltip stays standalone');
  assert.ok(document.querySelector('[data-spektrum-inspect-outline]'), 'outline stays standalone');
  stop(); dock.unmount();
});

test('inspect mounted without a dock keeps its free-floating panel', () => {
  const stop = mountInspect(s);
  const panel = document.querySelector('[data-spektrum-inspect]');
  assert.ok(panel);
  assert.equal(panel.closest('[data-spektrum-dock]'), null);
  stop();
});

// === Multi-tool coexistence ===

test('devtools + inspect mounted into the same dock both register as tabs', () => {
  const dock = mountDock();
  const stopDt = mountDevtools(s);
  const stopIn = mountInspect(s);
  const tabs = [...document.querySelectorAll('[data-spektrum-dock] [data-panel-tab]')];
  const ids = tabs.map(t => t.dataset.panelTab).sort();
  assert.deepEqual(ids, ['devtools', 'inspect']);
  stopDt(); stopIn(); dock.unmount();
});

test('dock.unmount tears down companions via onClose', () => {
  const dock = mountDock();
  mountDevtools(s);
  mountInspect(s);
  dock.unmount();
  // Companions' panels gone from the page.
  assert.equal(document.querySelector('[data-spektrum-devtools]'), null);
  assert.equal(document.querySelector('[data-spektrum-inspect]'), null);
  // Inspect's standalone overlays gone too.
  assert.equal(document.querySelector('[data-spektrum-inspect-tip]'), null);
  assert.equal(document.querySelector('[data-spektrum-inspect-outline]'), null);
});

test('mount order is independent — companion before dock works the standalone way', () => {
  // No dock at mount time → standalone. Mounting a dock afterwards
  // does NOT retroactively absorb existing companions; they remain
  // free-floating. Documented behavior (we don't observe DOM mutations).
  const stopDt = mountDevtools(s);
  const dock = mountDock();
  assert.ok(document.querySelector('[data-spektrum-devtools]:not([data-spektrum-dock] [data-spektrum-devtools])'),
    'pre-dock devtools stays standalone');
  assert.equal(document.querySelector('[data-panel-tab="devtools"]'), null,
    'no dock tab for the pre-existing devtools');
  stopDt(); dock.unmount();
});

// === Interaction coverage ===

test('clicking × on a tab fires onClose and removes the tab', () => {
  // Hits the data-x branch in the tab-button click handler — without
  // this test, panel.close() via UI is unexercised.
  const dock = mountDock();
  let closed = false;
  const panel = dock.registerPanel({ id: 'x', label: 'X', onClose: () => { closed = true; } });
  const xButton = panel.button.querySelector('[data-x]');
  assert.ok(xButton, 'tab has an × child');
  xButton.click();
  assert.ok(closed, 'onClose fired');
  assert.equal(document.querySelector('[data-panel-tab="x"]'), null);
  dock.unmount();
});

test('clicking the dock side button toggles right ⇆ bottom', () => {
  const dock = mountDock({ side: 'right' });
  const root = document.querySelector('[data-spektrum-dock]');
  assert.ok(root.classList.contains('r'));
  root.querySelector('[data-act="side"]').click();
  assert.ok(root.classList.contains('b'), 'switched to bottom');
  root.querySelector('[data-act="side"]').click();
  assert.ok(root.classList.contains('r'), 'switched back to right');
  dock.unmount();
});

test('clicking the chip expands the dock', () => {
  // The chip is only visible while collapsed; clicking it expands.
  const dock = mountDock({ collapsed: true });
  const root = document.querySelector('[data-spektrum-dock]');
  assert.ok(root.classList.contains('c'), 'starts collapsed');
  root.querySelector('[data-chip]').click();
  assert.equal(root.classList.contains('c'), false, 'chip click expanded');
  dock.unmount();
});

test('clicking the header toggle collapses and re-expands the dock', () => {
  const dock = mountDock();
  const root = document.querySelector('[data-spektrum-dock]');
  const toggle = root.querySelector('[data-act="toggle"]');
  toggle.click();
  assert.ok(root.classList.contains('c'), 'toggle collapsed');
  toggle.click();
  assert.equal(root.classList.contains('c'), false, 'toggle re-expanded');
  dock.unmount();
});

test('setActive switches the visible tab', () => {
  const dock = mountDock();
  dock.registerPanel({ id: 'a', label: 'A' });
  const b = dock.registerPanel({ id: 'b', label: 'B' });
  dock.setActive('b');
  assert.ok(b.container.classList.contains('a'), 'panel B is active');
  assert.ok(b.button.classList.contains('a'), 'tab B is active');
  dock.unmount();
});

test('setActive is a no-op for an unregistered id', () => {
  const dock = mountDock();
  dock.registerPanel({ id: 'a', label: 'A' });
  dock.setActive('nope');                 // does not throw, does not change state
  const a = document.querySelector('[data-panel-tab="a"]');
  assert.ok(a.classList.contains('a'), 'A remains active');
  dock.unmount();
});

test('setSide changes the dock side at runtime', () => {
  const dock = mountDock({ side: 'right' });
  const root = document.querySelector('[data-spektrum-dock]');
  dock.setSide('bottom');
  assert.ok(root.classList.contains('b'));
  dock.setSide('right');
  assert.ok(root.classList.contains('r'));
  dock.setSide('nope');                   // unknown side is a no-op
  assert.ok(root.classList.contains('r'));
  dock.unmount();
});

test('detaching the active panel surfaces the next one (or renders empty)', () => {
  // Exercises the activeId-rollover branch in panel.detach().
  const dock = mountDock();
  const a = dock.registerPanel({ id: 'a', label: 'A' });
  const b = dock.registerPanel({ id: 'b', label: 'B' });
  a.activate();
  a.detach();
  assert.ok(b.button.classList.contains('a'), 'B promoted to active');
  b.detach();
  assert.ok(document.querySelector('[data-spektrum-dock] .empty'),
    'empty state rendered after all panels gone');
  dock.unmount();
});

test('onClose throwing does not crash the dock; tab is still removed', () => {
  const dock = mountDock();
  const calls = [];
  const origErr = console.error;
  console.error = (...a) => calls.push(a);
  try {
    const panel = dock.registerPanel({ id: 'boom', label: 'Boom', onClose: () => { throw new Error('oops'); } });
    panel.close();
  } finally { console.error = origErr; }
  assert.equal(document.querySelector('[data-panel-tab="boom"]'), null, 'tab gone despite throw');
  assert.ok(calls.some(c => String(c[0]).includes('[spektrum.dock] onClose threw')),
    'failure logged to console.error');
  dock.unmount();
});

test('clicking the header close-equivalent (tab × on last panel) restores empty state', () => {
  const dock = mountDock();
  const p = dock.registerPanel({ id: 'only', label: 'Only' });
  p.close();
  assert.ok(document.querySelector('[data-spektrum-dock] .empty'),
    'empty state restored after closing the last panel');
  dock.unmount();
});

test('escapeHtml handles missing label via registerPanel without a label', () => {
  // L66 — `String(s ?? '')` nullish branch. Pass undefined label.
  const dock = mountDock();
  const panel = dock.registerPanel({ id: 'no-label' });    // label intentionally missing
  // Panel renders with empty label text — no throw.
  assert.equal(panel.button.querySelector('span').textContent, '');
  dock.unmount();
});

test('clicking the label-span inside a tab activates the panel (not closes)', () => {
  // L161 — the dataset.x === undefined branch (clicked the label, not ×).
  const dock = mountDock();
  const a = dock.registerPanel({ id: 'a', label: 'A' });
  const b = dock.registerPanel({ id: 'b', label: 'B' });
  // Click the label span on tab A (not the × child).
  const labelSpan = a.button.querySelector('span:not([data-x])');
  labelSpan.click();
  assert.ok(a.button.classList.contains('a'), 'A is active after label click');
  assert.equal(b.button.classList.contains('a'), false);
  dock.unmount();
});

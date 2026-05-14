/*
  Tests for spektrum/inspect. Covers the programmatic helpers
  (readBindings, lint, whoSubscribesTo) and the mount/unmount
  lifecycle, including devtools-coexistence corner detection.
*/

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSpektrum } from '../spektrum.js';
import { mount as mountDevtools } from '../companions/spektrum-devtools.js';
import { mount, readBindings, whoSubscribesTo, lint } from '../companions/spektrum-inspect.js';

let s;
beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  s = createSpektrum();
});

// === readBindings ===

test('readBindings extracts every binding kind on an element', () => {
  document.body.innerHTML = `<button :class="theme" data-if="show" data-action="click" data-fn="hit" data-id="x" data-ref="btn" data-intent="cart.submit">{{label}}</button>`;
  const el = document.body.firstElementChild;
  const bs = readBindings(el);
  const kinds = bs.map(b => b.kind);
  assert.deepEqual(kinds.sort(), ['action', 'attr', 'if', 'intent', 'ref', 'text'].sort());
  const attr = bs.find(b => b.kind === 'attr');
  assert.equal(attr.name, 'class');
  assert.equal(attr.expr, 'theme');
  const text = bs.find(b => b.kind === 'text');
  assert.equal(text.expr, 'label');
});

test('readBindings parses data-each into path/as/key', () => {
  document.body.innerHTML = `<ul data-each="items" data-as="row" data-key="row.id"><li>{{row.name}}</li></ul>`;
  const bs = readBindings(document.body.firstElementChild);
  const each = bs.find(b => b.kind === 'each');
  assert.equal(each.path, 'items');
  assert.equal(each.as, 'row');
  assert.equal(each.key, 'row.id');
});

test('readBindings returns empty array for plain elements', () => {
  document.body.innerHTML = `<div class="static">hello</div>`;
  assert.deepEqual(readBindings(document.body.firstElementChild), []);
});

test('readBindings extracts multiple {{expressions}} from one text node', () => {
  document.body.innerHTML = `<p>{{a}} / {{b.c}} ({{d}})</p>`;
  const bs = readBindings(document.body.firstElementChild);
  assert.deepEqual(bs.map(b => b.expr), ['a', 'b.c', 'd']);
});

// === whoSubscribesTo ===

test('whoSubscribesTo returns systems with intersecting paths', () => {
  s.addSystem(['cart.items'], function renderCart() {});
  s.addSystem(['cart'],       function recompute() {});
  s.addSystem(['other'],      function unrelated() {});
  const names = whoSubscribesTo(s, 'cart.items.0.price').sort();
  assert.deepEqual(names, ['recompute', 'renderCart']);
});

test('whoSubscribesTo handles overlap in either direction', () => {
  // System subscribed to a child path also fires when an ancestor changes
  // (because the engine re-runs systems whose top key intersects the delta).
  s.addSystem(['user.profile.email'], function renderEmail() {});
  // Mutating 'user' would re-fire; whoSubscribesTo flags this.
  assert.ok(whoSubscribesTo(s, 'user').includes('renderEmail'));
});

// === lint ===

test('lint flags stray {{…}} in plain attributes', () => {
  document.body.innerHTML = `<a href="{{user.url}}">x</a>`;
  const findings = lint(s, document.body);
  assert.equal(findings.length, 1);
  assert.match(findings[0].msg, /\{\{…\}\}.*"href".*mustache/);
  assert.equal(findings[0].el.tagName, 'A');
});

test('lint does NOT flag {{…}} in : or data- attributes', () => {
  // :attr is full-expression (no mustache anyway); data- attrs are
  // out of scope for this footgun (they are directive metadata).
  document.body.innerHTML = `<a :href="user.url" data-name="{{foo}}">x</a>`;
  assert.deepEqual(lint(s, document.body), []);
});

test('lint flags data-fn references to unregistered handlers', () => {
  s.defineFn('known', () => {});
  document.body.innerHTML = `
    <button data-action="click" data-fn="known">ok</button>
    <button data-action="click" data-fn="ghost">bad</button>`;
  const findings = lint(s, document.body).filter(f => f.msg.includes('not registered'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].el.textContent, 'bad');
});

test('lint skips elements inside other inspect / devtools panels', () => {
  // Avoid recursing on our own UI — these are dev panels, not app code.
  document.body.innerHTML = `
    <div data-spektrum-inspect><a href="{{x}}">should-not-flag</a></div>
    <div data-spektrum-devtools><a href="{{y}}">should-not-flag</a></div>
    <a href="{{z}}">should-flag</a>`;
  const findings = lint(s, document.body);
  assert.equal(findings.length, 1);
  assert.match(findings[0].msg, /\{\{…\}\}.*"href"/);
});

// === mount lifecycle ===

test('mount renders a panel and unmount removes it', () => {
  const unmount = mount(s);
  // Three separate attributes: panel, floating tooltip, hover outline.
  assert.equal(document.querySelectorAll('[data-spektrum-inspect]').length, 1, 'panel');
  assert.equal(document.querySelectorAll('[data-spektrum-inspect-tip]').length, 1, 'tooltip');
  assert.equal(document.querySelectorAll('[data-spektrum-inspect-outline]').length, 1, 'outline');
  unmount();
  assert.equal(document.querySelectorAll('[data-spektrum-inspect]').length, 0);
  assert.equal(document.querySelectorAll('[data-spektrum-inspect-tip]').length, 0);
  assert.equal(document.querySelectorAll('[data-spektrum-inspect-outline]').length, 0);
});

test('mount injects its stylesheet exactly once across multiple mounts', () => {
  const u1 = mount(s);
  const u2 = mount(s, { position: 'top-right' });
  assert.equal(document.querySelectorAll('[data-spektrum-inspect-css]').length, 1,
    'stylesheet de-duped between instances');
  u1(); u2();
});

test('mount auto-picks a corner not occupied by an existing devtools panel', () => {
  // devtools defaults to bottom-right; inspect should pick something else.
  const stopDevtools = mountDevtools(s);
  const unmount = mount(s);
  const panel = document.querySelector('[data-spektrum-inspect]:not([data-spektrum-inspect-tip]):not([data-spektrum-inspect-outline])');
  // bottom-right means dt.style.bottom + dt.style.right; we picked
  // anything else, so the panel should NOT have BOTH bottom and right.
  const hasBottom = !!panel.style.bottom, hasRight = !!panel.style.right;
  assert.ok(!(hasBottom && hasRight),
    `inspect picked bottom-right (collides with devtools); style: ${panel.style.cssText}`);
  unmount(); stopDevtools();
});

test('mount opts.position overrides auto-detection', () => {
  // Even with devtools present, explicit position wins.
  const stopDevtools = mountDevtools(s);
  const unmount = mount(s, { position: 'bottom-right' });
  const panel = document.querySelector('[data-spektrum-inspect]:not([data-spektrum-inspect-tip]):not([data-spektrum-inspect-outline])');
  assert.ok(panel.style.bottom && panel.style.right,
    `expected bottom-right; got: ${panel.style.cssText}`);
  unmount(); stopDevtools();
});

test('mount features:[] subsets the rendered tabs', () => {
  const unmount = mount(s, { features: ['lint'] });
  const tabs = document.querySelectorAll('[data-spektrum-inspect] [data-tab]');
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].dataset.tab, 'lint');
  unmount();
});

test('unmount detaches the onRecord subscription', () => {
  // After unmount, mutating state should not re-render the (gone) log.
  // We test this indirectly: the panel is removed and no errors fire
  // when we mutate post-unmount.
  const unmount = mount(s);
  unmount();
  s.setValue('x', 1);
  s.tick();
  assert.equal(s.appState.x, 1);   // mutation succeeded; no thrown errors
});

test('unmount removes the tooltip and outline overlays', () => {
  const unmount = mount(s);
  assert.equal(document.querySelectorAll('[data-spektrum-inspect-tip]').length, 1);
  assert.equal(document.querySelectorAll('[data-spektrum-inspect-outline]').length, 1);
  unmount();
  assert.equal(document.querySelectorAll('[data-spektrum-inspect-tip]').length, 0);
  assert.equal(document.querySelectorAll('[data-spektrum-inspect-outline]').length, 0);
});

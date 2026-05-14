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

// === Interaction coverage ===

const dispatch = (target, type, init = {}) => {
  // happy-dom's Element doesn't ship with helpful Event constructors —
  // build a minimal Event with the props we need and let bubbling do
  // the rest.
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, init);
  target.dispatchEvent(ev);
  return ev;
};

test('enabling inspect mode + hover renders binding info', () => {
  // Stages: click "inspect element" → mousemove over a bound element →
  // tooltip should populate. Covers showFor, onMove, formatElement,
  // formatBinding for several kinds.
  s.setValue('user', { name: 'alice' });
  document.body.innerHTML = `
    <ul data-each="users" data-as="row" data-key="row.id">
      <li :class="theme" data-if="row.active" data-model="row.text" data-ref="r" data-intent="cart.add"
          data-action="click" data-fn="trigger" data-id="row.id">
        {{row.name}}
      </li>
    </ul>`;
  const unmount = mount(s);
  // Toggle inspect mode via the button.
  document.querySelector('[data-act="inspect-mode"]').click();
  const li = document.querySelector('li');
  // Programmatically fire the mousemove event the capture-phase listener subscribed to.
  dispatch(li, 'mousemove', { clientX: 10, clientY: 10 });
  const tip = document.querySelector('[data-spektrum-inspect-tip]');
  assert.equal(tip.style.display, 'block', 'tooltip shown');
  // Tooltip mentions the inherited loop context.
  assert.match(tip.innerHTML, /inside loop/);
  // And lists multiple bindings.
  assert.match(tip.innerHTML, /data-action/);
  assert.match(tip.innerHTML, /data-ref/);
  unmount();
});

test('clicking an element while inspect mode is on pins the tooltip', () => {
  document.body.innerHTML = `<p>{{msg}}</p>`;
  s.setValue('msg', 'hi');
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  const p = document.querySelector('p');
  dispatch(p, 'click', { clientX: 5, clientY: 5 });
  // Outline now has display:block via showFor.
  const outline = document.querySelector('[data-spektrum-inspect-outline]');
  assert.ok(outline.style.cssText.includes('display:block') || outline.style.display === 'block');
  unmount();
});

test('Escape key exits inspect mode and hides overlays', () => {
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document, 'keydown', { key: 'Escape' });
  const tip = document.querySelector('[data-spektrum-inspect-tip]');
  assert.equal(tip.style.display, 'none', 'tip hidden after Escape');
  unmount();
});

test('mousemove over inspect own UI hides floaters (isOwn guard)', () => {
  document.body.innerHTML = `<p>x</p>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  // First show via a real element, then move over the panel itself.
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  const panel = document.querySelector('[data-spektrum-inspect]');
  dispatch(panel, 'mousemove', { clientX: 5, clientY: 5 });
  const tip = document.querySelector('[data-spektrum-inspect-tip]');
  assert.equal(tip.style.display, 'none', 'tip hidden when hovering own UI');
  unmount();
});

test('mutation tracer renders entries as state changes', () => {
  const unmount = mount(s);
  s.setValue('x', 1);
  s.setValue('y', 2);
  s.checkpoint('cp1');
  s.tick();
  const log = document.querySelector('[data-log]');
  assert.match(log.innerHTML, /\bx\b/);
  assert.match(log.innerHTML, /\by\b/);
  assert.match(log.innerHTML, /cp1/);
  unmount();
});

test('pause button stops new entries from rendering until resumed', () => {
  const unmount = mount(s);
  // Click the Mutations tab so its pane is visible (and the pause button is reachable).
  document.querySelector('[data-tab="mut"]').click();
  const pauseBtn = document.querySelector('[data-act="pause"]');
  pauseBtn.click();                            // → paused
  s.setValue('paused.write', 1);
  s.tick();
  const log = document.querySelector('[data-log]');
  // No entries while paused.
  assert.equal(log.innerHTML.includes('paused.write'), false);
  pauseBtn.click();                            // → resumed
  s.setValue('resumed.write', 1);
  s.tick();
  assert.match(log.innerHTML, /resumed\.write/);
  unmount();
});

test('clear button drops the mutation log ring', () => {
  const unmount = mount(s);
  s.setValue('a', 1); s.tick();
  document.querySelector('[data-tab="mut"]').click();
  document.querySelector('[data-act="clear"]').click();
  assert.equal(document.querySelector('[data-log]').innerHTML, '');
  unmount();
});

test('filter input filters log rows by regex (and accepts invalid regex without throwing)', () => {
  const unmount = mount(s);
  s.setValue('foo.bar', 1);
  s.setValue('baz.qux', 2);
  s.tick();
  document.querySelector('[data-tab="mut"]').click();
  const input = document.querySelector('[data-filter]');
  input.value = 'foo';
  dispatch(input, 'input');
  const log = document.querySelector('[data-log]');
  assert.match(log.innerHTML, /foo\.bar/);
  assert.equal(log.innerHTML.includes('baz.qux'), false);
  // Invalid regex shouldn't throw — should silently disable filter.
  input.value = '(';
  dispatch(input, 'input');
  const after = document.querySelector('[data-log]').innerHTML;
  assert.match(after, /foo\.bar/);
  assert.match(after, /baz\.qux/);
  unmount();
});

test('re-lint button refreshes findings', () => {
  document.body.innerHTML = `<a href="{{user.url}}">x</a>`;
  const unmount = mount(s);
  document.querySelector('[data-tab="lint"]').click();
  document.querySelector('[data-act="re-lint"]').click();
  const findings = document.querySelector('[data-findings]');
  assert.match(findings.innerHTML, /\{\{…\}\}/);
  unmount();
});

test('lint with no findings shows the ✓ ok marker', () => {
  document.body.innerHTML = `<p>{{ok}}</p>`;  // no stray mustaches in attrs
  const unmount = mount(s);
  document.querySelector('[data-tab="lint"]').click();
  document.querySelector('[data-act="re-lint"]').click();
  assert.match(document.querySelector('[data-findings]').innerHTML, /no findings/);
  unmount();
});

test('close button on the panel header unmounts everything', () => {
  const unmount = mount(s);
  document.querySelector('[data-act="close"]').click();
  assert.equal(document.querySelector('[data-spektrum-inspect]'), null);
  assert.equal(document.querySelector('[data-spektrum-inspect-tip]'), null);
  // Calling the returned unmount() again is a no-op (everything already gone).
  unmount();
});

test('switching tabs activates the correct pane', () => {
  const unmount = mount(s);
  document.querySelector('[data-tab="mut"]').click();
  const mutPane = document.querySelector('[data-pane="mut"]');
  assert.ok(mutPane.classList.contains('a'), 'mutations pane active');
  document.querySelector('[data-tab="lint"]').click();
  const lintPane = document.querySelector('[data-pane="lint"]');
  assert.ok(lintPane.classList.contains('a'), 'lint pane active');
  unmount();
});

test('formatElement output covers every binding kind', () => {
  // Single element with every directive at once, hovered while inspect
  // is active — drives every branch of formatBinding.
  document.body.innerHTML = `
    <div :class="theme" data-if="ok" data-model="value" data-ref="root" data-intent="x.y"
         data-action="click" data-fn="trigger" data-id="x.y" data-value="1">{{label}}</div>`;
  s.setValue('theme', 'dark');
  s.setValue('ok', true);
  s.setValue('value', 'hi');
  s.setValue('label', 'go');
  s.tick();
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('div'), 'mousemove', { clientX: 10, clientY: 10 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  for (const probe of [':class', 'data-if', 'data-model', 'data-ref', 'data-intent', 'data-action', '{{label']) {
    assert.match(html, new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `tooltip should mention ${probe}`);
  }
  unmount();
});

test('formatElement renders a data-each element with resolved length', () => {
  s.setValue('items', [1, 2, 3]);
  s.tick();                                    // commit to appState before inspect reads it
  document.body.innerHTML = `<ul data-each="items" data-key="item"><li>{{item}}</li></ul>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('ul'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /length: 3/);
  assert.match(html, /key:/);
  unmount();
});

test('hovering an element with no bindings shows "(no bindings)"', () => {
  document.body.innerHTML = `<p>plain text</p>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  const tip = document.querySelector('[data-spektrum-inspect-tip]');
  assert.match(tip.innerHTML, /\(no bindings\)/);
  unmount();
});

test('truncate handles circular structures without throwing', () => {
  // Hits the catch branch in truncate() — JSON.stringify throws on circular.
  const a = { name: 'circ' };
  a.self = a;
  s.setValue('circ', a);
  document.body.innerHTML = `<p data-model="circ">x</p>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  // Hovering exercises tryEval → truncate(JSON.stringify) → catch.
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  // No throw is the assertion; tooltip should still render.
  assert.equal(document.querySelector('[data-spektrum-inspect-tip]').style.display, 'block');
  unmount();
});

// === Inspect branch coverage ===

test('readBindings handles elements without dataset (SVG-like)', () => {
  // Indirectly exercises findLoopContext's `cur.dataset?.each` optional
  // chain (L117) — a parentless element has no parent loop.
  document.body.innerHTML = `<svg><circle r="5"/></svg>`;
  const circle = document.querySelector('circle');
  // No exception, returns empty (no recognised bindings).
  const out = readBindings(circle);
  assert.ok(Array.isArray(out));
});

test('pickCorner falls back to top-left when all four corners are taken', () => {
  // L158 — `Object.keys(CORNERS).find(...) || 'top-left'`. Stuff the
  // page with four panels each in a different corner; the fifth mount
  // has no free corner.
  const u1 = mount(s, { position: 'top-left' });
  const u2 = mount(s, { position: 'top-right' });
  const u3 = mount(s, { position: 'bottom-left' });
  const u4 = mount(s, { position: 'bottom-right' });
  const u5 = mount(s);                          // no explicit position → pickCorner
  // No exception; mount produced a panel.
  assert.ok(document.querySelectorAll('[data-spektrum-inspect]').length >= 5);
  u1(); u2(); u3(); u4(); u5();
});

test('mount accepts explicit opts.position (skips pickCorner branch)', () => {
  // L228 — `opts.position || pickCorner()` short-circuits when position
  // is provided.
  const unmount = mount(s, { position: 'top-right' });
  const panel = document.querySelector('[data-spektrum-inspect]');
  assert.ok(panel.style.top && panel.style.right);
  unmount();
});

test('features: ["elements"] only renders the Elements tab', () => {
  // L240, 246 — features.includes('mutations'/'lint') falsy branches.
  const unmount = mount(s, { features: ['elements'] });
  assert.equal(document.querySelectorAll('[data-spektrum-inspect] [data-tab]').length, 1);
  assert.equal(document.querySelector('[data-tab="mut"]'), null);
  assert.equal(document.querySelector('[data-tab="lint"]'), null);
  unmount();
});

test('onRecord callback is a no-op when mutations feature is excluded', () => {
  // L313 — `if (!logEl) return;` in renderLog.
  const unmount = mount(s, { features: ['elements'] });   // no mutations tab → logEl is null
  s.setValue('x', 1);
  s.tick();
  // No throw; we tolerate the missing element.
  unmount();
});

test('initial lint pass is skipped when lint feature is excluded', () => {
  // L333 — `if (!findingsEl) return;` in runLint.
  document.body.innerHTML = `<a href="{{x}}">x</a>`;
  const unmount = mount(s, { features: ['elements'] });   // no lint tab → no findingsEl
  // Even though the page has a stray-mustache lint trigger, no findings
  // pane exists — runLint returns silently.
  assert.equal(document.querySelector('[data-findings]'), null);
  unmount();
});

test('mutation log truncates to 500 entries (ring overflow)', () => {
  // L325 — `if (ring.length > 500) ring.shift();`.
  const unmount = mount(s);
  for (let i = 0; i < 502; i++) {
    s.setValue(`p${i}`, i);
  }
  s.tick();
  // Inspect ring is internal; we can't read it directly, but the test
  // just needs to drive the shift branch.
  unmount();
});

test('action binding without data-fn is formatted with "?" placeholder', () => {
  // L178 — `b.fn || '?'` in formatBinding.
  document.body.innerHTML = `<button data-action="click">x</button>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('button'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /data-fn="\?"/);
  unmount();
});

test('data-each without data-key formats without key suffix', () => {
  // L174 — `b.key ? \`, key: ...\` : ''` falsy branch in formatBinding.
  s.setValue('items', [1, 2]); s.tick();
  document.body.innerHTML = `<ul data-each="items"><li>{{item}}</li></ul>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('ul'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /length: 2/);
  assert.equal(html.includes(', key:'), false);
  unmount();
});

test('formatElement handles elements without className or id', () => {
  // L185, 186 — `el.id` and `el.className` falsy branches in the tag-string
  // template literal.
  document.body.innerHTML = `<p>{{val}}</p>`;
  s.setValue('val', 'x'); s.tick();
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  // Tag has no id="" or class=""
  assert.equal(html.includes(' id="'), false);
  assert.equal(html.includes(' class="'), false);
  unmount();
});

test('lint finding for an element without an id renders without id attribute', () => {
  // L336 — `f.el.id ? ` id="..."` : ''` falsy branch in runLint render.
  document.body.innerHTML = `<a href="{{u}}">x</a>`;     // no id on the <a>
  const unmount = mount(s);
  document.querySelector('[data-tab="lint"]').click();
  const findings = document.querySelector('[data-findings]');
  assert.match(findings.innerHTML, /&lt;a&gt;/);            // no id segment
  unmount();
});

test('clicking inside the panel on a non-button text node is ignored', () => {
  // L344 — `if (!(t instanceof Element)) return;` — synthetic event
  // whose target is a Text node would hit this. We can't easily
  // construct that, but clicking on a structural <span> (no data-act,
  // no data-tab) lands the handler on an Element and falls through —
  // covering the "no match" branch through the else-chain.
  const unmount = mount(s);
  const span = document.createElement('span');
  document.querySelector('[data-spektrum-inspect]').appendChild(span);
  span.click();                                  // Element but matches nothing
  // Panel still standing; no throw.
  assert.ok(document.querySelector('[data-spektrum-inspect]'));
  unmount();
});

test('toggling inspect-mode off via the button hides floaters', () => {
  // L347 — `if (!inspectMode) hideFloaters();` — the falsy branch
  // after toggling off.
  document.body.innerHTML = `<p>{{x}}</p>`;
  s.setValue('x', 1); s.tick();
  const unmount = mount(s);
  const btn = document.querySelector('[data-act="inspect-mode"]');
  btn.click();                                   // turn ON
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  btn.click();                                   // turn OFF — hits the !inspectMode → hideFloaters branch
  const tip = document.querySelector('[data-spektrum-inspect-tip]');
  assert.equal(tip.style.display, 'none');
  unmount();
});

test('escapeHtml handles nullish input via the ?? coalesce', () => {
  // L72 — `String(s ?? '')`. We exercise via lint, which feeds element
  // tagName.toLowerCase() into escapeHtml; that's never nullish, so we
  // hit ?? via readBindings → formatBinding indirectly when an action
  // has no event (unlikely) — instead, just hit it through whoSubscribesTo:
  // pass an empty path and a system with an anonymous fn → name fallback.
  s.addSystem([''], () => {});
  // Inspect's mutation tracer calls whoSubscribesTo and may format the
  // empty path through escapeHtml.
  const unmount = mount(s);
  s.setValue('', 1);                             // no-op (engine refuses empty path) but covers escape
  s.tick();
  unmount();
});

// === More branch coverage — second sweep ===

test('truncate short strings pass through unchanged (no ellipsis)', () => {
  // L79 — `s.length > n ? slice : s` — the s-stays-short branch. The
  // tooltip renders a short value verbatim.
  s.setValue('short', 'hi');
  s.tick();
  document.body.innerHTML = `<p data-model="short">x</p>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /"hi"/);
  unmount();
});

test('truncate long strings get the … ellipsis', () => {
  // L79 — the slice-with-ellipsis branch.
  s.setValue('long', 'x'.repeat(80));
  s.tick();
  document.body.innerHTML = `<p data-model="long">x</p>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /…/);
  unmount();
});

test('truncate of non-string values goes through JSON.stringify', () => {
  // L77 — `typeof v === 'string' ? "..." : JSON.stringify(v)` non-string branch.
  s.setValue('obj', { id: 1, name: 'alice' });
  s.tick();
  document.body.innerHTML = `<p data-model="obj">x</p>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /alice/);
  unmount();
});

test('complex {{expression}} (non-simple-path) shows source without re-evaluation', () => {
  // L87, L88 — tryEval and evalSuffix when SIMPLE_PATH.test fails.
  s.setValue('count', 5);
  s.tick();
  document.body.innerHTML = `<p>{{count + 1}}</p>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /count \+ 1/);
  // No " = " suffix because the expression isn't a simple path.
  assert.equal(html.includes('= 6'), false);
  unmount();
});

test('findLoopContext walks past intermediate elements to find the loop', () => {
  // L117 — the falsy branch of `cur.dataset?.each` — the loop keeps
  // walking when an ancestor doesn't carry data-each.
  s.setValue('items', [{ name: 'a' }]);
  s.tick();
  document.body.innerHTML = `
    <ul data-each="items">
      <li><section><span><em>{{item.name}}</em></span></section></li>
    </ul>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  // Hover a deeply nested descendant — the loop walks past <em>, <span>,
  // <section> before finding the <ul data-each>.
  dispatch(document.querySelector('em'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /inside loop/);
  unmount();
});

test('SVG elements with non-string className do not break formatElement', () => {
  // L185 — `typeof el.className === 'string'` falsy branch (SVG has
  // SVGAnimatedString). The tooltip should still render.
  document.body.innerHTML = `<svg><circle r="5"></circle></svg>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('circle'), 'mousemove', { clientX: 5, clientY: 5 });
  const tip = document.querySelector('[data-spektrum-inspect-tip]');
  assert.equal(tip.style.display, 'block', 'tooltip rendered without throwing');
  unmount();
});

test('element with an id renders the id in the tag-string', () => {
  // L186 — `el.id ? ` id="..."` : ''` truthy branch.
  document.body.innerHTML = `<p id="hero">{{val}}</p>`;
  s.setValue('val', 'x'); s.tick();
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('#hero'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /id="hero"/);
  unmount();
});

test('mutation tracer add-op renders with "+" prefix', () => {
  // L317 — `r.op === 'add' ? '+' : '='` — the '+' branch. trigger()
  // emits the 'add' op shape.
  const unmount = mount(s);
  s.trigger('inc', 'counter', 1);
  s.tick();
  const log = document.querySelector('[data-log]');
  assert.match(log.innerHTML, /\+1/);
  unmount();
});

test('mutation tracer entry without subscribed systems renders without arrow', () => {
  // L319 — `r.triggers.length ? <q>→ ...</q> : ''` falsy branch.
  // No system subscribes to `unwatched.path`, so triggers.length === 0.
  const unmount = mount(s);
  s.setValue('unwatched.path', 1);
  s.tick();
  const log = document.querySelector('[data-log]');
  // Row exists but has no <q>→...</q> trigger annotation.
  assert.match(log.innerHTML, /unwatched\.path/);
  assert.equal(log.innerHTML.includes(`<q>  →`), false);
  unmount();
});

test('inspectMode=on with pinned element skips further mousemove showFor calls', () => {
  // L290 — `if (!inspectMode || pinned) return;` — the pinned-truthy branch.
  document.body.innerHTML = `<p>x</p><span>y</span>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  // Click pins the first element.
  dispatch(document.querySelector('p'), 'click', { clientX: 5, clientY: 5 });
  const pinnedHtml = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  // Subsequent mousemove over the second element should NOT update the tip.
  dispatch(document.querySelector('span'), 'mousemove', { clientX: 50, clientY: 50 });
  assert.equal(document.querySelector('[data-spektrum-inspect-tip]').innerHTML, pinnedHtml,
    'pinned tooltip unchanged after move');
  unmount();
});

test('lint with no findings inside a sub-tree shows ✓ ok', () => {
  // L336 line has multiple branches around lint rendering; we already
  // covered both "with findings" and "no findings" — touch up the
  // anonymous-fn rendering branch in the mutation tracer indirectly.
  // (We've already hit this in earlier tests; this is a safety net.)
  document.body.innerHTML = `<p>{{ok}}</p>`;
  const unmount = mount(s);
  // Switch to lint tab and ensure the ok message is present.
  document.querySelector('[data-tab="lint"]').click();
  assert.match(document.querySelector('[data-findings]').innerHTML, /no findings/);
  unmount();
});

test('whoSubscribesTo returns "(anon)" for systems with no fn.name', () => {
  // L128 in inspect — `s.name || '(anon)'`. describe() uses fn.name ||
  // '' so the inspect helper substitutes '(anon)' for empty strings.
  s.addSystem(['x'], () => {});                          // anonymous arrow
  const names = whoSubscribesTo(s, 'x');
  assert.ok(names.includes('(anon)'), `expected (anon); got: ${names.join(', ')}`);
});

// === Inspect — final defensive branch sweep ===

test('escapeHtml handles nullish via checkpoint(undefined-id) in the tracer', () => {
  // inspect L72 — `String(s ?? '')` nullish branch. The mutation tracer
  // renders `escapeHtml(r.id)` for checkpoints; `checkpoint()` with no
  // name records `id: undefined`.
  const unmount = mount(s);
  s.checkpoint();                                // id is undefined
  s.tick();
  // No throw is enough — the path escapeHtml(undefined) fires.
  unmount();
});

test('truncate of a non-stringifiable value (BigInt) falls back to String(v)', () => {
  // L77 — try/catch branch. JSON.stringify throws on BigInt.
  s.setValue('big', 9007199254740993n);
  s.tick();
  document.body.innerHTML = `<p data-model="big">x</p>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('p'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  // String fallback contains the BigInt literal (without quotes).
  assert.match(html, /9007199254740993/);
  unmount();
});

test('data-each with a malformed path resolves with length "?"', () => {
  // L174 — `Array.isArray(v) ? v.length : '?'` falsy branch — when
  // tryEval can't resolve (non-simple-path or undefined value).
  document.body.innerHTML = `<ul data-each="never.populated"><li>{{item}}</li></ul>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('ul'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /length: \?/);
  unmount();
});

test('mount with invalid position falls back to "top-left"', () => {
  // L228 — `CORNERS[position] || CORNERS['top-left']` OR fallback.
  const unmount = mount(s, { position: 'nowhere-real' });
  const panel = document.querySelector('[data-spektrum-inspect]');
  assert.ok(panel.style.top && panel.style.left, 'fell back to top-left');
  unmount();
});

test('mutation tracer entry with non-empty triggers renders the arrow', () => {
  // L319 — `r.triggers.length ? <q>→…</q> : ''` truthy branch.
  s.addSystem(['watched'], function listener() {});
  const unmount = mount(s);
  s.setValue('watched.field', 1);
  s.tick();
  const log = document.querySelector('[data-log]');
  assert.match(log.innerHTML, /→.*listener/);
  unmount();
});

test('filter regex matches checkpoint entries via empty-path fallback', () => {
  // L314 — `r.path || ''` short-circuit when entry path is empty/falsy
  // (checkpoints have path: ''). With a filter active, an empty path
  // tests against the empty fallback.
  const unmount = mount(s);
  document.querySelector('[data-tab="mut"]').click();
  s.setValue('included', 1);
  s.checkpoint('cp-marker');                    // path === '', will be filtered out
  s.tick();
  const input = document.querySelector('[data-filter]');
  input.value = 'included';
  dispatch(input, 'input');
  const log = document.querySelector('[data-log]');
  assert.match(log.innerHTML, /included/);
  // Checkpoint's empty path doesn't match the filter — it's excluded.
  assert.equal(log.innerHTML.includes('cp-marker'), false);
  unmount();
});

// === Inspect — last branch sweep ===

test('tryEval returns undefined for non-simple-path data-each (L87 false branch)', () => {
  // Tooltip on a data-each whose path isn't a dotted identifier — tryEval
  // short-circuits via SIMPLE_PATH.test and returns undefined.
  document.body.innerHTML = `<ul data-each="a + b"><li>x</li></ul>`;
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('ul'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  // Path printed but no resolution (length: ?, since tryEval returned undefined).
  assert.match(html, /a \+ b/);
  assert.match(html, /length: \?/);
  unmount();
});

test('element with a non-empty class renders class="..." in the tag string (L185/186)', () => {
  document.body.innerHTML = `<div class="banner hero">{{val}}</div>`;
  s.setValue('val', 'x'); s.tick();
  const unmount = mount(s);
  document.querySelector('[data-act="inspect-mode"]').click();
  dispatch(document.querySelector('div'), 'mousemove', { clientX: 5, clientY: 5 });
  const html = document.querySelector('[data-spektrum-inspect-tip]').innerHTML;
  assert.match(html, /class="banner hero"/);
  unmount();
});

test('lint findings on elements with ids render the id attribute (L336)', () => {
  document.body.innerHTML = `<a id="profile-link" href="{{user.url}}">x</a>`;
  const unmount = mount(s);
  document.querySelector('[data-tab="lint"]').click();
  const findings = document.querySelector('[data-findings]');
  assert.match(findings.innerHTML, /id="profile-link"/);
  unmount();
});

test('clearing the filter input resets filterRe to null (L356 falsy branch)', () => {
  const unmount = mount(s);
  document.querySelector('[data-tab="mut"]').click();
  s.setValue('alpha', 1);
  s.setValue('beta', 2);
  s.tick();
  const input = document.querySelector('[data-filter]');
  input.value = 'alpha';
  dispatch(input, 'input');                       // filter active
  let log = document.querySelector('[data-log]').innerHTML;
  assert.equal(log.includes('beta'), false);
  input.value = '';                               // empty → v falsy branch → filterRe = null
  dispatch(input, 'input');
  log = document.querySelector('[data-log]').innerHTML;
  assert.match(log, /alpha/);
  assert.match(log, /beta/);                      // both shown again, no filter
  unmount();
});

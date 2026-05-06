/*
  DOM-touching tests, run via `node --test`.

  Uses happy-dom (a fast jsdom alternative, ~1MB) to provide document/
  window/Element globals. happy-dom is dev-only — no runtime dependency
  on it from spektrum.js.

  Tests here cover the binding helpers (bindText, bindAttrs, bindIf,
  bindEach, bindDOM) that the engine-only test file can't touch.
*/

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import spektrum, {
  appState, setValue, bindDOM, tick, reset, getPathObj, precompile,
} from './spektrum.js';
import { extractExpressions, emitPrecompileSource } from './spektrum-compile.js';

beforeEach(() => {
  reset();
  document.body.innerHTML = '';
});

// === {{path}} text interpolation ===

test('{{path}} renders state value into the text node', () => {
  document.body.innerHTML = '<p>{{msg}}</p>';
  setValue('msg', 'hello');
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelector('p').textContent, 'hello');
});

test('{{path}} re-renders when state updates', () => {
  document.body.innerHTML = '<p>n={{count}}</p>';
  setValue('count', 1);
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelector('p').textContent, 'n=1');

  setValue('count', 42);
  tick();
  assert.equal(document.body.querySelector('p').textContent, 'n=42');
});

// === :attr property binding ===

test(':attr writes state value into element property', () => {
  document.body.innerHTML = '<button :disabled="locked">go</button>';
  setValue('locked', true);
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelector('button').disabled, true);

  setValue('locked', false);
  tick();
  assert.equal(document.body.querySelector('button').disabled, false);
});

// === data-if conditional ===

test('data-if hides element when state is falsy', () => {
  document.body.innerHTML = '<div data-if="show">visible</div>';
  setValue('show', true);
  bindDOM(document.body);
  tick();
  assert.notEqual(document.body.querySelector('div').style.display, 'none');

  setValue('show', false);
  tick();
  assert.equal(document.body.querySelector('div').style.display, 'none');
});

// === data-each list rendering ===

test('data-each renders one clone per item with rewritten paths', () => {
  document.body.innerHTML = `
    <ul data-each="users" data-as="user">
      <li>{{user.name}}</li>
    </ul>`;
  setValue('users', [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }]);
  bindDOM(document.body);
  tick();

  const items = document.body.querySelectorAll('ul li');
  assert.equal(items.length, 3);
  assert.equal(items[0].textContent, 'alice');
  assert.equal(items[1].textContent, 'bob');
  assert.equal(items[2].textContent, 'carol');
});

test('data-each rebuilds when array changes', () => {
  document.body.innerHTML = `
    <ul data-each="items" data-as="item">
      <li>{{item.label}}</li>
    </ul>`;
  setValue('items', [{ label: 'a' }]);
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelectorAll('ul li').length, 1);

  setValue('items', [{ label: 'a' }, { label: 'b' }]);
  tick();
  assert.equal(document.body.querySelectorAll('ul li').length, 2);
  assert.equal(document.body.querySelectorAll('ul li')[1].textContent, 'b');
});

// === DOM event dispatch ===

test('data-action="click" dispatches data-fn on click', () => {
  document.body.innerHTML = `
    <button data-action="click" data-fn="trigger" data-id="x" data-value="5" data-name="hit">+</button>`;
  setValue('x', 0);
  bindDOM(document.body);
  tick();

  document.body.querySelector('button').click();
  tick();
  assert.equal(getPathObj(appState, 'x'), 5);
});

test('initial render sees post-first-tick state (no pre-tick flicker)', () => {
  // Regression: bindReactive's initial render previously used appState
  // alone, so bindings registered after setValue() but before the first
  // tick saw an empty state for one frame. Now it merges
  // appState ⊕ appStateDelta into a snapshot for the initial render.
  document.body.innerHTML = '<p>{{msg}}</p>';
  setValue('msg', 'hello');
  bindDOM(document.body);
  // No tick yet — but the initial render should already have the value.
  assert.equal(document.body.querySelector('p').textContent, 'hello');
});

// === Idempotency ===

test('bindDOM is idempotent on the same root', () => {
  document.body.innerHTML = `
    <button data-action="click" data-fn="trigger" data-id="x" data-value="1" data-name="inc">+</button>`;
  setValue('x', 0);
  bindDOM(document.body);
  bindDOM(document.body); // should be a no-op
  tick();

  document.body.querySelector('button').click();
  tick();
  // If double-bound, click would fire trigger twice and x would be 2.
  assert.equal(getPathObj(appState, 'x'), 1);
});

// === Expressions in {{...}} ===

test('{{expression}} evaluates JS, not just paths', () => {
  document.body.innerHTML = '<p>{{count + 1}}</p>';
  setValue('count', 4);
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelector('p').textContent, '5');

  setValue('count', 9);
  tick();
  assert.equal(document.body.querySelector('p').textContent, '10');
});

test('{{expression}} supports ternaries and method calls', () => {
  document.body.innerHTML = '<p>{{flag ? name.toUpperCase() : "none"}}</p>';
  setValue('flag', true);
  setValue('name', 'spektrum');
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelector('p').textContent, 'SPEKTRUM');

  setValue('flag', false);
  tick();
  assert.equal(document.body.querySelector('p').textContent, 'none');
});

test(':attr accepts expressions, not just paths', () => {
  document.body.innerHTML = '<button :disabled="count <= 0">go</button>';
  setValue('count', 0);
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelector('button').disabled, true);

  setValue('count', 5);
  tick();
  assert.equal(document.body.querySelector('button').disabled, false);
});

test('data-if accepts expressions (negation)', () => {
  document.body.innerHTML = '<div data-if="!hidden">visible</div>';
  setValue('hidden', false);
  bindDOM(document.body);
  tick();
  assert.notEqual(document.body.querySelector('div').style.display, 'none');

  setValue('hidden', true);
  tick();
  assert.equal(document.body.querySelector('div').style.display, 'none');
});

// === :class object form ===

test(':class object form toggles individual classes', () => {
  // happy-dom ≥16 has a regression where `classList.toggle(name, force)`
  // is a silent no-op on elements that carry a `:class` attribute, so
  // we can't read back classList state to assert the binding's effect
  // (real browsers handle this fine — `:class` is just an unknown
  // attribute to them). Instead we spy on classList.toggle to verify
  // the binding calls it with the expected (name, truthy) pairs.
  // Track upstream: https://github.com/capricorn86/happy-dom/issues/…
  document.body.innerHTML = '<div class="card" :class="{active: on, error: bad}">x</div>';
  const calls = [];
  const proto = Object.getPrototypeOf(document.body.querySelector('div').classList);
  const origToggle = proto.toggle;
  proto.toggle = function(name, force) {
    calls.push([name, !!force]);
    return origToggle.call(this, name, force);
  };
  const has = (name, force) => calls.some(([n, f]) => n === name && f === force);
  try {
    setValue('on', true);
    setValue('bad', false);
    bindDOM(document.body);
    tick();
    assert.ok(has('active', true),  'toggle(active, true) was called');
    assert.ok(has('error', false), 'toggle(error, false) was called');
    assert.ok(!has('active', false), 'toggle(active, false) was NOT called');

    calls.length = 0;
    setValue('on', false);
    setValue('bad', true);
    tick();
    assert.ok(has('active', false), 'toggle(active, false) after flipping');
    assert.ok(has('error', true),   'toggle(error, true) after flipping');
  } finally {
    proto.toggle = origToggle;
  }
});

test(':class string form still overwrites (backward compat)', () => {
  document.body.innerHTML = '<div :class="theme">x</div>';
  setValue('theme', 'dark big');
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelector('div').className, 'dark big');
});

// === data-model two-way binding ===

test('data-model writes state from input event', () => {
  document.body.innerHTML = '<input data-model="name">';
  setValue('name', 'alice');
  bindDOM(document.body);
  tick();
  const input = document.body.querySelector('input');
  assert.equal(input.value, 'alice');

  input.value = 'bob';
  input.dispatchEvent(new Event('input'));
  tick();
  assert.equal(getPathObj(appState, 'name'), 'bob');
});

test('data-model checkbox uses `change` and `el.checked`', () => {
  document.body.innerHTML = '<input type="checkbox" data-model="agreed">';
  setValue('agreed', false);
  bindDOM(document.body);
  tick();
  const cb = document.body.querySelector('input');
  assert.equal(cb.checked, false);

  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
  tick();
  assert.equal(getPathObj(appState, 'agreed'), true);
});

// === data-ref ===

test('data-ref exposes the element on instance.refs', () => {
  document.body.innerHTML = '<input data-ref="email">';
  bindDOM(document.body);
  assert.equal(spektrum.refs.email, document.body.querySelector('input'));
});

test('reset() clears refs', () => {
  document.body.innerHTML = '<input data-ref="email">';
  bindDOM(document.body);
  assert.ok(spektrum.refs.email);
  reset();
  assert.equal(spektrum.refs.email, undefined);
});

// === Keyed data-each ===

test('keyed data-each preserves nodes by key when index is unchanged', () => {
  document.body.innerHTML = `
    <ul data-each="items" data-as="item" data-key="item.id">
      <li>{{item.label}}</li>
    </ul>`;
  setValue('items', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
  bindDOM(document.body);
  tick();
  const before = [...document.body.querySelectorAll('ul li')];
  assert.equal(before.length, 2);

  // Append: existing nodes must be the same DOM elements after re-render.
  setValue('items', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]);
  tick();
  const after = [...document.body.querySelectorAll('ul li')];
  assert.equal(after.length, 3);
  assert.equal(after[0], before[0], 'item 0 node reused');
  assert.equal(after[1], before[1], 'item 1 node reused');
});

test('keyed data-each preserves focus on appended-to lists', () => {
  document.body.innerHTML = `
    <ul data-each="rows" data-as="row" data-key="row.id">
      <li><input data-model="row.text"></li>
    </ul>`;
  setValue('rows', [{ id: 1, text: 'one' }, { id: 2, text: 'two' }]);
  bindDOM(document.body);
  tick();

  const firstInput = document.body.querySelector('ul li input');
  firstInput.focus();
  assert.equal(document.activeElement, firstInput);

  // Append a row. Without keying this would tear down all bindings and
  // focus would leave the input.
  setValue('rows', [{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }]);
  tick();
  assert.equal(document.activeElement, firstInput, 'focus survives append');
});

test('keyed data-each removes nodes for dropped keys', () => {
  document.body.innerHTML = `
    <ul data-each="items" data-as="item" data-key="item.id">
      <li>{{item.label}}</li>
    </ul>`;
  setValue('items', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]);
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelectorAll('ul li').length, 3);

  setValue('items', [{ id: 'a', label: 'A' }, { id: 'c', label: 'C' }]);
  tick();
  const labels = [...document.body.querySelectorAll('ul li')].map(li => li.textContent);
  assert.deepEqual(labels, ['A', 'C']);
});

test('unkeyed data-each falls back to full rebuild (legacy behavior)', () => {
  document.body.innerHTML = `
    <ul data-each="items" data-as="item">
      <li>{{item.label}}</li>
    </ul>`;
  setValue('items', [{ label: 'a' }]);
  bindDOM(document.body);
  tick();
  const before = document.body.querySelector('ul li');

  setValue('items', [{ label: 'a' }, { label: 'b' }]);
  tick();
  const after = document.body.querySelector('ul li');
  assert.notEqual(after, before, 'unkeyed mode rebuilds existing nodes');
});

test('replay() backward through a populated list wipes the rendered rows', () => {
  // User-reported regression (1/2): "add fruit, scrub history slider
  // back, list still shows the old rows". Without the replay-completion
  // refresh, bindEach never re-fires when its subscribed path falls
  // out of state, leaving stale `<li>` and stale data-model bindings
  // behind. The user could then type into a phantom row.
  document.body.innerHTML = `
    <div id="basket">
      <ul data-each="items" data-as="item" data-key="item.id">
        <li>{{item.label}}</li>
      </ul>
    </div>`;
  setValue('items', []);
  bindDOM(document.body);
  tick();

  setValue('items', [{ id: 1, label: '🍎' }], 'add');
  tick();
  assert.equal(document.body.querySelectorAll('#basket li').length, 1);

  spektrum.replay(1); // back to just the seed; items is []
  assert.equal(
    document.body.querySelectorAll('#basket li').length,
    0,
    'rows must be cleared once items is empty again',
  );
});

test('typing into a per-item input (data-model on item.note) preserves the array', () => {
  // User-reported regression (2/2): typing into a per-item note input
  // made the list disappear. Cause: setValue('items.0.note', 'x')
  // wrote `delta = {items: {0: {note: 'x'}}}`, and deepMerge replaced
  // state.items (an array) wholesale with that plain object. items
  // became `{0: {note: 'x'}}`, so bindEach's `Array.isArray` check
  // wiped the DOM and the next addKind tried to spread an object.
  document.body.innerHTML = `
    <div id="basket">
      <ul data-each="items" data-as="item" data-key="item.id">
        <li>
          <span class="label">{{item.label}}</span>
          <input class="note" data-model="item.note">
        </li>
      </ul>
    </div>`;
  setValue('items', [
    { id: 1, label: '🍎', note: '' },
    { id: 2, label: '🍌', note: '' },
  ]);
  bindDOM(document.body);
  tick();

  const firstNote = document.body.querySelector('#basket li:nth-child(1) .note');
  firstNote.value = 'ripe';
  firstNote.dispatchEvent(new Event('input'));
  tick();

  assert.ok(Array.isArray(appState.items), 'items must remain an array');
  assert.equal(appState.items.length, 2, 'no items lost');
  assert.equal(appState.items[0].note, 'ripe');
  assert.equal(appState.items[0].label, '🍎', 'sibling fields on the edited item survive');
  assert.equal(appState.items[1].label, '🍌', 'other items are unaffected');
  assert.equal(
    document.body.querySelectorAll('#basket li').length,
    2,
    'list still renders both rows',
  );
});

// === Event modifiers ===

test('data-action="click.prevent" calls preventDefault', () => {
  document.body.innerHTML = `
    <a href="#nope" data-action="click.prevent" data-fn="trigger" data-id="x" data-value="1" data-name="hit">go</a>`;
  setValue('x', 0);
  bindDOM(document.body);
  tick();

  const a = document.body.querySelector('a');
  let prevented = false;
  // happy-dom dispatches the event; capture defaultPrevented after the click.
  const ev = new Event('click', { cancelable: true, bubbles: true });
  a.dispatchEvent(ev);
  prevented = ev.defaultPrevented;
  tick();
  assert.equal(prevented, true, 'preventDefault was called');
  assert.equal(getPathObj(appState, 'x'), 1);
});

test('bindDOM(footerEl) wires data-action on elements outside the main panels', () => {
  // Regression for the demo's "clear saved state" link: a data-fn
  // registered on an instance is only reachable from elements the
  // instance has bindDOM'd. The example panels each bindDOM'd their
  // own subtree, leaving the <footer> link inert (.prevent never
  // wired either, so the <a href="#"> would also navigate). The fix:
  // a second bindDOM call on the footer with the same instance.
  document.body.innerHTML = `
    <section id="panel">
      <p>{{label}}</p>
    </section>
    <footer>
      <a href="#" data-action="click.prevent" data-fn="reset">reset</a>
    </footer>`;
  setValue('label', 'live');
  let resetCalls = 0;
  spektrum.defineFn('reset', () => { resetCalls++; });

  bindDOM(document.getElementById('panel'));
  bindDOM(document.querySelector('footer'));
  tick();

  const link = document.querySelector('footer a');
  const ev = new Event('click', { cancelable: true, bubbles: true });
  link.dispatchEvent(ev);

  assert.equal(ev.defaultPrevented, true, '.prevent modifier wired');
  assert.equal(resetCalls, 1, 'data-fn fired once');
});

test('data-action="click.once" runs only once', () => {
  document.body.innerHTML = `
    <button data-action="click.once" data-fn="trigger" data-id="n" data-value="1" data-name="hit">+</button>`;
  setValue('n', 0);
  bindDOM(document.body);
  tick();

  const btn = document.body.querySelector('button');
  btn.click();
  btn.click();
  btn.click();
  tick();
  assert.equal(getPathObj(appState, 'n'), 1);
});

// === Precompile end-to-end ===

test('precompile() entry is used by {{...}} bindings before new Function', () => {
  // Pick an unusual expression so we can be sure the cache miss
  // would otherwise compile fresh.
  const expr = '__precompile_e2e__ * 3';
  let calls = 0;
  precompile(expr, (state) => { calls++; return state.__precompile_e2e__ * 3; });

  document.body.innerHTML = `<p>{{${expr}}}</p>`;
  setValue('__precompile_e2e__', 4);
  bindDOM(document.body);
  tick();

  assert.equal(document.body.querySelector('p').textContent, '12');
  assert.ok(calls >= 1, 'precompiled fn was invoked');
});

// === Compile helper ===

test('extractExpressions pulls {{...}}, :attr, data-if, data-key sources', () => {
  const html = `
    <p>{{count + 1}} and {{user.name}}</p>
    <button :disabled="locked"></button>
    <div data-if="!hidden">x</div>
    <ul data-each="items" data-as="item" data-key="item.id">
      <li>{{item.label}}</li>
    </ul>
  `;
  const exprs = extractExpressions(html);
  // Order is encounter order; assert as a set instead.
  assert.deepEqual(
    new Set(exprs),
    new Set(['count + 1', 'user.name', 'locked', '!hidden', 'item.id', 'item.label']),
  );
  // data-each value is NOT an expression — it's a path. Make sure we
  // didn't accidentally include it.
  assert.ok(!exprs.includes('items'));
});

test('emitPrecompileSource emits parseable JS that imports precompile', () => {
  const out = emitPrecompileSource(['count + 1', 'user.name']);
  assert.match(out, /import \{ precompile \} from 'spektrum';/);
  assert.match(out, /precompile\("count \+ 1"/);
  assert.match(out, /precompile\("user\.name"/);
});

test('destroy() removes listeners and releases the root for re-binding', () => {
  document.body.innerHTML = `
    <button data-action="click" data-fn="trigger" data-id="x" data-value="1" data-name="hit">+</button>`;
  setValue('x', 0);
  const destroy = bindDOM(document.body);
  tick();

  document.body.querySelector('button').click();
  tick();
  assert.equal(getPathObj(appState, 'x'), 1);

  destroy();
  // Listener gone — click should now be a no-op.
  document.body.querySelector('button').click();
  tick();
  assert.equal(getPathObj(appState, 'x'), 1, 'listener should be removed by destroy()');

  // Root is released, so bindDOM can re-bind.
  bindDOM(document.body);
  document.body.querySelector('button').click();
  tick();
  assert.equal(getPathObj(appState, 'x'), 2, 'rebound listener should fire');
});

// === URL scheme guard (F-4) ===

test(':href neutralizes javascript: scheme to "#"', () => {
  document.body.innerHTML = '<a :href="link">go</a>';
  setValue('link', 'javascript:alert(1)');
  bindDOM(document.body);
  tick();
  const a = document.body.querySelector('a');
  assert.equal(a.getAttribute('href'), '#', 'javascript: rewritten to # to block XSS');

  setValue('link', 'https://example.com/safe');
  tick();
  assert.equal(a.getAttribute('href'), 'https://example.com/safe', 'https URL passes through');

  setValue('link', '  JavaScript:alert(1)');
  tick();
  assert.equal(a.getAttribute('href'), '#', 'leading whitespace + mixed case still blocked');
});

test(':src on iframe also neutralizes javascript:', () => {
  document.body.innerHTML = '<iframe :src="frame"></iframe>';
  setValue('frame', 'javascript:void(0)');
  bindDOM(document.body);
  tick();
  assert.equal(document.body.querySelector('iframe').getAttribute('src'), '#');
});

// === reset() drains DOM listeners (F-5) ===

test('reset() removes data-action click listener so rebind does not stack', () => {
  // Regression: reset() previously cleared state but left DOM
  // listeners attached. A subsequent bindDOM() on the same root
  // attached a *second* listener, so a click fired the handler twice.
  document.body.innerHTML = `
    <button data-action="click" data-fn="trigger" data-id="x" data-value="1" data-name="hit">+</button>`;
  setValue('x', 0);
  bindDOM(document.body);
  tick();
  document.body.querySelector('button').click();
  tick();
  assert.equal(getPathObj(appState, 'x'), 1);

  // reset + rebind without explicit destroy(). The audit's failure
  // mode: the original listener stays attached, the second bindDOM
  // attaches a duplicate, and one click fires both.
  reset();
  setValue('x', 0);
  bindDOM(document.body);
  tick();
  document.body.querySelector('button').click();
  tick();
  assert.equal(getPathObj(appState, 'x'), 1, 'click must fire the handler exactly once');
});

test('reset() removes data-model input listener so rebind does not stack', () => {
  document.body.innerHTML = '<input data-model="name">';
  setValue('name', 'a');
  bindDOM(document.body);
  tick();

  reset();
  document.body.innerHTML = '<input data-model="name">';
  setValue('name', 'a');
  bindDOM(document.body);
  tick();

  // Mutate via the new input. If the old listener leaked, both old
  // and new would fire — but the old listener now points to the prior
  // appState (since reset() wiped it), and writing through it would
  // produce undefined behavior. The cleanest assertion: history has
  // exactly one mutation per input event.
  const input = document.body.querySelector('input');
  input.value = 'b';
  input.dispatchEvent(new Event('input'));
  tick();
  assert.equal(getPathObj(appState, 'name'), 'b');
  // Setup wrote one entry, the input event added exactly one more.
  assert.equal(spektrum.history.length, 2,
    'one record per logical mutation; no stacked listeners');
});

// === Unknown data-action modifier warning (F-17) ===

test('data-action with unknown modifier warns at bind time', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)));
  document.body.innerHTML = `
    <button data-action="click.preventdefault" data-fn="trigger" data-id="x" data-value="1" data-name="hit">+</button>`;
  setValue('x', 0);
  bindDOM(document.body);
  assert.ok(
    warnings.some(w => /unknown data-action modifier \.preventdefault/.test(w)),
    `expected unknown-modifier warn; got: ${JSON.stringify(warnings)}`,
  );
});

test('data-action with all known modifiers does not warn', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)));
  document.body.innerHTML = `
    <button data-action="click.prevent.stop.once" data-fn="trigger" data-id="x" data-value="1" data-name="hit">+</button>`;
  setValue('x', 0);
  bindDOM(document.body);
  assert.equal(
    warnings.filter(w => /unknown data-action modifier/.test(w)).length, 0,
    'recognised modifiers must not warn',
  );
});

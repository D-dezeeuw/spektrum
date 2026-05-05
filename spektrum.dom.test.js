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
import {
  appState, setValue, bindDOM, tick, reset, getPathObj,
} from './spektrum.js';

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

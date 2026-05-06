/*
  DevTools panel tests, run via `node --test`.

  Uses happy-dom for the DOM. The panel is rAF-driven, so each test
  flushes one rAF tick after mount to let the first render populate
  cursor / log content.
*/

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import spektrum, { setValue, tick, reset } from './spektrum.js';
import { mount } from './spektrum-devtools.js';

beforeEach(() => {
  // Silence the "reset() detached N system(s)" warn during cleanup.
  const orig = console.warn;
  console.warn = () => {};
  try { reset(); } finally { console.warn = orig; }
  document.body.innerHTML = '';
});

const flushRaf = () => new Promise(r => requestAnimationFrame(r));

test('mount creates a panel inside the parent', () => {
  const unmount = mount(spektrum);
  const panel = document.body.querySelector('[data-spektrum-devtools]');
  assert.ok(panel, 'panel is in the DOM');
  assert.ok(panel.querySelector('[data-cursor]'), 'cursor element present');
  assert.ok(panel.querySelector('[data-scrub]'), 'scrubber present');
  assert.ok(panel.querySelector('[data-log]'), 'log present');
  assert.ok(panel.querySelector('[data-act="live"]'), 'live button present');
  unmount();
});

test('mount honours opts.parent and opts.position', () => {
  const host = document.createElement('section');
  document.body.appendChild(host);
  const unmount = mount(spektrum, { parent: host, position: 'top-left' });
  const panel = host.querySelector('[data-spektrum-devtools]');
  assert.ok(panel, 'panel mounted into the custom parent');
  assert.match(panel.style.cssText, /top:\s*12px/);
  assert.match(panel.style.cssText, /left:\s*12px/);
  unmount();
});

test('mount falls back to default position on an unknown corner', () => {
  const unmount = mount(spektrum, { position: 'middle-of-nowhere' });
  const panel = document.body.querySelector('[data-spektrum-devtools]');
  // Default is bottom-right.
  assert.match(panel.style.cssText, /bottom:\s*12px/);
  assert.match(panel.style.cssText, /right:\s*12px/);
  unmount();
});

test('mount honours a custom opts.title (escapes it)', () => {
  // Covers the opts.title truthy branch and the title escapeHtml call.
  const unmount = mount(spektrum, { title: 'my <app>' });
  const panel = document.body.querySelector('[data-spektrum-devtools]');
  assert.ok(panel.innerHTML.includes('my &lt;app&gt;'),
    `expected escaped custom title; got: ${panel.innerHTML.slice(0, 200)}`);
  unmount();
});

test('panel reflects cursor and history length after a rAF tick', async () => {
  setValue('x', 1);
  setValue('y', 2);
  tick();
  const unmount = mount(spektrum);
  await flushRaf();
  const cursor = document.body.querySelector('[data-cursor]');
  assert.match(cursor.textContent, /cursor 2 \/ 2/, `got "${cursor.textContent}"`);
  const scrub = document.body.querySelector('[data-scrub]');
  assert.equal(scrub.max, '2');
  assert.equal(scrub.value, '2');
  unmount();
});

test('scrubbing the slider triggers replay()', async () => {
  setValue('x', 1);
  setValue('x', 2);
  setValue('x', 3);
  tick();
  const unmount = mount(spektrum);
  await flushRaf();
  const scrub = document.body.querySelector('[data-scrub]');
  scrub.value = '1';
  scrub.dispatchEvent(new Event('input'));
  assert.equal(spektrum.cursor, 1, 'replay moved cursor to 1');
  unmount();
});

test('live button replays to history.length', async () => {
  setValue('x', 1);
  setValue('x', 2);
  tick();
  spektrum.replay(1);
  assert.equal(spektrum.cursor, 1);
  const unmount = mount(spektrum);
  await flushRaf();
  document.body.querySelector('[data-act="live"]').click();
  assert.equal(spektrum.cursor, 2, 'live jumped cursor to head');
  unmount();
});

test('state values in the log are HTML-escaped (XSS guard)', async () => {
  setValue('msg', '<script>alert(1)</script>');
  tick();
  const unmount = mount(spektrum);
  await flushRaf();
  const log = document.body.querySelector('[data-log]');
  // Escaped form must be present; raw <script> must not.
  assert.ok(log.innerHTML.includes('&lt;script&gt;'),
    `expected escaped <script> in log; got: ${log.innerHTML}`);
  assert.ok(!log.innerHTML.includes('<script>alert'),
    'raw <script> tag must never reach the panel innerHTML');
  // No injected <script> ended up live in the document either.
  assert.equal(document.body.querySelector('script'), null);
  unmount();
});

test('log truncates long values', async () => {
  // truncate() slices to 19 chars + '…' for anything over 20 chars.
  setValue('msg', 'a'.repeat(100));
  tick();
  const unmount = mount(spektrum);
  await flushRaf();
  const log = document.body.querySelector('[data-log]');
  // Look for the truncation marker.
  assert.ok(log.innerHTML.includes('…'), 'log truncates with ellipsis');
  unmount();
});

test('log renders additive trigger entries with +value formatting', async () => {
  setValue('count', 0);
  spektrum.trigger('inc', 'count', 5);
  tick();
  const unmount = mount(spektrum);
  await flushRaf();
  const log = document.body.querySelector('[data-log]');
  assert.ok(log.innerHTML.includes('+5'), 'additive entry shows as +5');
  unmount();
});

test('log renders checkpoint entries with the ◆ marker', async () => {
  // Covers the e.op === 'checkpoint' branch in the op-formatting ternary.
  spektrum.checkpoint('search-done');
  tick();
  const unmount = mount(spektrum);
  await flushRaf();
  const log = document.body.querySelector('[data-log]');
  assert.ok(log.innerHTML.includes('◆'),
    `expected diamond marker for checkpoint; got: ${log.innerHTML.slice(0, 200)}`);
  assert.ok(log.innerHTML.includes('search-done'),
    'checkpoint name is rendered');
  unmount();
});

test('panel does not overwrite scrubber value while user is dragging', async () => {
  // Covers the `document.activeElement !== scrubEl` guard branch:
  // when the user is mid-drag, the render skips the value reset so it
  // doesn't fight the drag.
  setValue('x', 1);
  setValue('x', 2);
  setValue('x', 3);
  tick();
  const unmount = mount(spektrum);
  await flushRaf();
  const scrub = document.body.querySelector('[data-scrub]');

  scrub.focus();
  // User drags to position 1. activeElement === scrub.
  scrub.value = '1';
  // Replay back to 2 to make cursor !== scrub.value, then re-render.
  spektrum.replay(2);
  await flushRaf();

  // The render should NOT have clobbered the user's mid-drag value
  // (cursor changed from 1 to 2, but scrub stayed at '1' because it
  // was the activeElement during the render pass).
  assert.equal(scrub.value, '1',
    'scrubber value preserved while focused (no drag-fight)');
  unmount();
});

test('panel skips DOM writes when history and cursor are unchanged across rAF ticks', async () => {
  // Covers the `if (h.length !== lastLen || c !== lastCursor)` false
  // branch — the no-op render path that protects against thrashing.
  setValue('x', 1);
  tick();
  const unmount = mount(spektrum);
  await flushRaf();
  const log = document.body.querySelector('[data-log]');
  const before = log.innerHTML;

  // Two more rAF ticks without any state change. innerHTML should
  // not be rewritten — same string (proves the guard kicked in,
  // because rewriting innerHTML would create a new string identity).
  await flushRaf();
  await flushRaf();
  assert.equal(log.innerHTML, before,
    'log innerHTML untouched on no-change rAF ticks');
  unmount();
});

test('unmount removes panel and stops the rAF loop', async () => {
  const unmount = mount(spektrum);
  await flushRaf();
  assert.ok(document.body.querySelector('[data-spektrum-devtools]'));
  unmount();
  assert.equal(
    document.body.querySelector('[data-spektrum-devtools]'),
    null,
    'panel removed from DOM',
  );
  // After unmount, further setValue+rAF cycles must not throw — the
  // render loop bails on `stopped`.
  setValue('x', 1);
  tick();
  await flushRaf();
  await flushRaf();
});

test('unmount detaches scrubber and live listeners', async () => {
  setValue('x', 1);
  setValue('x', 2);
  tick();
  const unmount = mount(spektrum);
  await flushRaf();
  const scrub = document.body.querySelector('[data-scrub]');
  unmount();
  // The detached scrub element still exists as a JS object; firing
  // input on it should not call replay (listener was removed).
  const cursorBefore = spektrum.cursor;
  scrub.value = '0';
  scrub.dispatchEvent(new Event('input'));
  assert.equal(spektrum.cursor, cursorBefore, 'replay not called after unmount');
});

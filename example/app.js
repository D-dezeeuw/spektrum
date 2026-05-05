/*
  Two isolated Spektrum instances on one page.

  Each createSpektrum() call returns its own state, history, systems,
  fns registry, and refs map. The two panels below share nothing —
  clicks on the counter don't touch the basket and vice versa.
  bindDOM() is called per panel so each instance only scans its own
  subtree.

  The demo exercises every binding form Spektrum supports:
    {{expr}}          counter readout, "next" / "doubled" math, item label, count
    :attr             :class object form (positive/negative), :disabled (expression)
    data-if           empty-basket message, per-item filter (inside data-each)
    data-each         basket items, with per-item path rewriting
    data-action       click (buttons, undo, remove) and input (number, text)
    data-model        counter set-directly + basket filter (two-way)
    data-ref          filter input handle, focused after bind
    computed          atSeed flag derived from cursor (no addSystem boilerplate)
*/

import { createSpektrum } from '../spektrum.js';

// === Counter ===

const counter = createSpektrum();
counter.setValue('count', 0, 'seed');

// First-class derived state. Reads the live cursor (instance property)
// and writes the boolean into state, where the :disabled binding picks
// it up. No addSystem + setPathValue boilerplate.
counter.computed('atSeed', ['count'], () => counter.cursor <= 1);

counter.defineFn('undo', () => {
  counter.replay(Math.max(1, counter.history.length - 1));
});

counter.bindDOM(document.getElementById('counter'));
counter.run();

// === Basket ===

const basket = createSpektrum();
basket.setValue('items', [], 'seed');
basket.setValue('filter', '', 'seed');

basket.computed('atSeed', ['items', 'filter'], () => basket.cursor <= 2);

// addKind: append a new {label} to state.items. Reads delta first (in
// case multiple clicks land in the same frame) so concurrent additions
// don't overwrite each other.
basket.defineFn('addKind', (el, state, delta) => {
  const current = delta.items || state.items || [];
  basket.setValue(
    'items',
    [...current, { label: el.dataset.name }],
    `add ${el.dataset.name}`,
  );
});

// removeAt: data-id is rewritten by data-each from "item" to "items.<i>"
// per cloned row, so the click handler reads the absolute path and
// extracts the index from the last segment.
basket.defineFn('removeAt', (el, state, delta) => {
  const i = Number(el.dataset.id.split('.').pop());
  const current = delta.items || state.items || [];
  basket.setValue(
    'items',
    current.filter((_, idx) => idx !== i),
    `remove ${i}`,
  );
});

basket.defineFn('undo', () => {
  basket.replay(Math.max(2, basket.history.length - 1));
});

basket.bindDOM(document.getElementById('basket'));
basket.run();

// data-ref demo: focus the filter input after bind so users can start
// typing immediately. refs is populated synchronously by bindDOM().
basket.refs.filterInput?.focus();

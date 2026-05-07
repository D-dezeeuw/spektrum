/*
  Two isolated Spektrum instances on one page, wired to the demo's
  full feature surface:

    createSpektrum(opts)  → historyLimit + snapshotEvery
    onError               → log system exceptions
    data-key              → keyed list reconciliation (see basket)
    data-action="x.mod"   → event modifiers (.stop, .prevent)
    spektrum/devtools     → floating scrubber panel (per instance)
    spektrum/persist      → loadHistory + autoSave (uses onRecord
                            internally to catch every mutation,
                            including data-model two-way edits)

  Every binding form is exercised somewhere in the markup; this
  file just wires the engine side.
*/

import { createSpektrum } from '../spektrum.js';
import { mount as mountDevtools } from '../spektrum-devtools.js';
import { loadHistory, autoSave } from '../spektrum-persist.js';

// One simple ID source for keyed list items. Persisted history
// re-applies its own pre-existing IDs, so we only ever bump for new
// rows during this session.
let nextId = 1;

// === Counter ===

// historyLimit caps memory; snapshotEvery makes replay() O(K) at the
// cost of one in-memory clone of appState every K entries. For a
// counter these caps are way overspec — they're here to demonstrate
// the options, not because the demo needs them.
const counter = createSpektrum({ historyLimit: 500, snapshotEvery: 25 });

counter.onError((err, fn) => console.error('[counter] system threw:', err, fn));

const counterKey = 'spektrum:demo:counter';
loadHistory(counter, { key: counterKey });

// Defaults are *state*, not actions — they describe the world before
// any user input. Direct-mutating appState writes them without going
// through record(), so they don't pollute history. The same function
// runs as a system below so replay() (which clears appState) re-applies
// the defaults — scrubbing all the way back lands at "count: 0".
//
// `atSeed` is reactive (depends on cursor), so it goes through the
// DELTA — direct-mutating it would bypass fan-out and the bindings on
// `:disabled="atSeed"` would never re-evaluate on a normal click.
// Replay refreshes every system regardless of delta, which is why
// scrubbing covers up that mistake — but a click between two replay
// boundaries wouldn't, hence the delta write here.
const seedCounter = (state, delta) => {
  state.count ??= 0;
  delta.atSeed = counter.cursor === 0;
};
seedCounter(counter.appState, counter.appStateDelta);
counter.addSystem(['count'], seedCounter);

counter.defineFn('undo', () => {
  counter.replay(Math.max(0, counter.cursor - 1));
});

// Forks visualization. The onFork hook mirrors a compact summary into
// the delta so the data-each binding fans out and re-renders. We don't
// store the forks themselves in state — they live on instance.forks
// (engine-managed, NOT serialized by saveHistory) and we look them up
// by index when restoring.
const mirrorForks = (instance) => {
  instance.appStateDelta.forkSummary = instance.forks.map(f => ({
    count: f.entries.length,
    ts: f.ts,
  }));
};
counter.onFork(() => mirrorForks(counter));

// restoreFork: rewind to where the fork was discarded, then re-apply
// its entries. Any diverging history past forkedAt becomes a NEW fork,
// so the user's "wrong turn" gets preserved exactly once and the
// original future is back. data-id="f" is rewritten by data-each to
// "forkSummary.<i>" per row — the index is the last segment.
const restoreFork = (instance) => (el) => {
  const idx = Number(el.dataset.id.split('.').pop());
  const fork = instance.forks[idx];
  if (!fork) return;
  instance.replay(fork.forkedAt);
  for (const e of fork.entries) {
    if (e.op === 'set') instance.setValue(e.path, e.value, e.id);
    else if (e.op === 'add') instance.trigger(e.id, e.path, e.value);
    else if (e.op === 'checkpoint') instance.checkpoint(e.id, e.value);
  }
  // Consumed: drop from the engine's forks array AND update the delta
  // mirror so the restored row disappears immediately. (The new fork
  // captured from the diverging tail stays — user can restore it later.)
  instance.forks.splice(idx, 1);
  mirrorForks(instance);
};
counter.defineFn('restoreFork', restoreFork(counter));

counter.bindDOM(document.getElementById('counter'));
counter.run();

// autoSave persists every recorded mutation (including data-model
// edits, via the engine-level onRecord hook). Debounced so a user
// hammering "+1" doesn't write to localStorage on every click.
autoSave(counter, { key: counterKey, debounce: 200 });

// === Basket ===

const basket = createSpektrum({ historyLimit: 500, snapshotEvery: 25 });
basket.onError((err) => console.error('[basket] system threw:', err));

const basketKey = 'spektrum:demo:basket';
loadHistory(basket, { key: basketKey });
// Items loaded from storage already have IDs; keep nextId past the
// highest one so newly-added rows don't collide.
for (const it of basket.appState.items || []) {
  if (it && it.id >= nextId) nextId = it.id + 1;
}

// Same pattern as counter: direct-mutate defaults (no history), but
// route the reactive `atSeed` through the delta so bindings fan out.
const seedBasket = (state, delta) => {
  state.items ??= [];
  state.filter ??= '';
  delta.atSeed = basket.cursor === 0;
};
seedBasket(basket.appState, basket.appStateDelta);
basket.addSystem(['items', 'filter'], seedBasket);

// addKind: append a new {id, label, note}. Reads delta first (in
// case multiple clicks land in the same frame) so concurrent additions
// don't overwrite each other. The id is stable per row, which
// data-key="item.id" relies on for keyed reconciliation.
basket.defineFn('addKind', (el, state, delta) => {
  const current = delta.items || state.items || [];
  basket.setValue(
    'items',
    [...current, { id: nextId++, label: el.dataset.name, note: '' }],
    `add ${el.dataset.name}`,
  );
});

// removeAt: data-id is rewritten by data-each from "item" to "items.<i>"
// per cloned row, so the click handler reads the absolute path and
// extracts the index from the last segment. Note the markup uses
// data-action="click.stop" so the click doesn't bubble (cosmetic
// here — the row itself doesn't capture clicks — but it demonstrates
// the modifier syntax).
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
  basket.replay(Math.max(0, basket.cursor - 1));
});

basket.onFork(() => mirrorForks(basket));
basket.defineFn('restoreFork', restoreFork(basket));

// resetAll: footer link uses data-action="click.prevent" so the
// `<a href="#">` doesn't navigate. Clear both stores and reload —
// simplest way to verify persistence is doing its job.
basket.defineFn('resetAll', () => {
  localStorage.removeItem(counterKey);
  localStorage.removeItem(basketKey);
  location.reload();
});

basket.bindDOM(document.getElementById('basket'));
// The footer's "clear saved state" link lives outside #basket but its
// data-fn="resetAll" is registered on the basket instance, so we
// scan the footer with the same bindDOM. Without this, the link is
// inert — the .prevent modifier never wires either, so clicking would
// navigate to "#" instead of clearing storage.
basket.bindDOM(document.querySelector('footer'));
basket.run();

autoSave(basket, { key: basketKey, debounce: 200 });

// data-ref demo: focus the filter input after bind so users can start
// typing immediately. refs is populated synchronously by bindDOM().
basket.refs.filterInput?.focus();

// === Devtools ===
//
// One panel per instance — both render their own history and cursor.
// Desktop: opposite bottom corners, out of the way of the demo
// content. Mobile: stacked on the right (top + bottom) so two
// 260-wide panels don't collide at the bottom of a 375-wide screen.
const small = matchMedia('(max-width: 600px)').matches;
mountDevtools(counter, { position: small ? 'top-right'    : 'bottom-left',  title: 'counter' });
mountDevtools(basket,  { position: small ? 'bottom-right' : 'bottom-right', title: 'basket'  });

// Make each devtools panel collapsible — click the title row to
// toggle. The devtools module doesn't ship with this; we do it from
// here by treating the panel root as a known shape: first child is
// the title row (title + "live" button), everything after it is the
// scrubber + log. On mobile we start collapsed so the panels don't
// cover the demo on first load.
const makeCollapsible = (root, { startCollapsed = false } = {}) => {
  const header = root.firstElementChild;
  const body = [...root.children].slice(1);
  const titleEl = header.firstElementChild;

  // Visual affordance: an arrow next to the title that flips with
  // state, and a pointer cursor on the whole header.
  const indicator = document.createElement('span');
  indicator.style.cssText = 'color:#888;margin-left:6px;font-size:10px;';
  titleEl.appendChild(indicator);
  header.style.cursor = 'pointer';
  header.title = 'click title to collapse';

  let collapsed = startCollapsed;
  const apply = () => {
    for (const el of body) el.style.display = collapsed ? 'none' : '';
    indicator.textContent = collapsed ? '▸' : '▾';
  };
  apply();

  header.addEventListener('click', (ev) => {
    // Don't toggle when the user clicks the "live" button (the only
    // <button> inside the header). Without this, hitting "live"
    // jumps to head AND collapses the panel — surprising.
    if (ev.target.closest('button')) return;
    collapsed = !collapsed;
    apply();
  });
};

for (const root of document.querySelectorAll('[data-spektrum-devtools]')) {
  makeCollapsible(root, { startCollapsed: small });
}

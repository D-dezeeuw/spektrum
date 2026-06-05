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
import { mount as mountDevtools } from '../companions/spektrum-devtools.js';
import { mount as mountInspect  } from '../companions/spektrum-inspect.js';
import { mount as mountDock     } from '../companions/spektrum-dock.js';
import { loadHistory, autoSave } from '../companions/spektrum-persist.js';

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

// Defaults + reactive derivations. Defaults (`state.count ??= 0`) are
// direct-mutated — they don't belong in history. Reactive values
// (`atSeed`, `forkSummary`) go through the DELTA so subscribers fan
// out. Mirroring forks here (rather than via the onFork hook alone)
// also covers replay() — replay clears appState, then runs the system
// refresh which re-fires every system including this one, which
// re-mirrors instance.forks back into delta.forkSummary. Without this,
// scrubbing the timeline made the discarded-futures aside vanish even
// though the underlying forks were still on the instance.
const mirrorForks = (instance, delta) => {
  delta.forkSummary = instance.forks.map(f => ({
    count: f.entries.length,
    ts: f.ts,
  }));
};
const seedCounter = (state, delta) => {
  state.count ??= 0;
  delta.atSeed = counter.cursor === 0;
  mirrorForks(counter, delta);
};
seedCounter(counter.appState, counter.appStateDelta);
counter.addSystem(['count'], seedCounter);

counter.defineFn('undo', () => {
  counter.replay(Math.max(0, counter.cursor - 1));
}, {
  description: 'Step the cursor back one history entry. Pure replay; nothing is recorded.',
  input: { type: 'object', properties: {}, additionalProperties: false },
});

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
  // Consumed. We mutated forks directly (splice) which doesn't tick,
  // so write the updated mirror to delta to fan out the row removal.
  instance.forks.splice(idx, 1);
  mirrorForks(instance, instance.appStateDelta);
};
counter.defineFn('restoreFork', restoreFork(counter), {
  description: 'Re-apply a discarded future from spektrum.forks at the indicated index. Reads data-id="forkSummary.<i>".',
});

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

// Same shape as counter: defaults direct-mutated; reactive values
// (atSeed, forkSummary) routed through the delta.
const seedBasket = (state, delta) => {
  state.items ??= [];
  state.filter ??= '';
  delta.atSeed = basket.cursor === 0;
  mirrorForks(basket, delta);
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
}, {
  description: 'Append a fruit to basket.items. Reads the label from the element\'s data-name attribute.',
  input: {
    type: 'object',
    properties: { 'data-name': { type: 'string', description: 'Display label for the new row.' } },
  },
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
}, {
  description: 'Remove a row from basket.items by index. Reads the index from data-id="items.<i>".',
});

basket.defineFn('undo', () => {
  basket.replay(Math.max(0, basket.cursor - 1));
}, {
  description: 'Step the cursor back one history entry. Pure replay; nothing is recorded.',
});

basket.defineFn('restoreFork', restoreFork(basket), {
  description: 'Re-apply a discarded future from spektrum.forks at the indicated index.',
});

// resetAll: footer link uses data-action="click.prevent" so the
// `<a href="#">` doesn't navigate. Clear both stores and reload —
// simplest way to verify persistence is doing its job.
basket.defineFn('resetAll', () => {
  localStorage.removeItem(counterKey);
  localStorage.removeItem(basketKey);
  location.reload();
}, {
  description: 'Wipe persisted history for both demo instances and reload. Destructive — no confirm.',
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

// Counter keeps a free-floating devtools panel — the simple, single-tool
// integration that every existing user knows.
mountDevtools(counter, { position: small ? 'top-right' : 'bottom-left', title: 'counter' });

// Basket shows the cohesive dock UI: one container, tabs for each tool,
// collapse/expand, side-toggle. Mount the dock FIRST so the companions
// detect it and register as tabs instead of free-floating panels.
mountDock({ side: small ? 'bottom' : 'right' });
mountDevtools(basket, { title: 'basket' });
mountInspect(basket);

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

// === Agent surface playground ===
//
// Both instances are exposed on `window.spektrum` so anyone (or any
// in-browser agent) can drive them from devtools console:
//
//   spektrum.basket.describe()                       // full manifest
//   spektrum.basket.findByIntent('basket.add')       // [el, el, el, el]
//   spektrum.counter.attempt('+5', () => {           // speculative edit
//     for (let i = 0; i < 5; i++)
//       spektrum.counter.trigger('inc', 'count', 1);
//   })                                                // → { result, commit, discard }
//   spektrum.counter.explain({ from: spektrum.counter.history.length - 5 })
//
// See AGENTS.md in the repo root for a full agent workflow tutorial.
window.spektrum = { counter, basket };

// === In-page AI agent (opt-in) ===
//
// The footer's "enable AI assistant" link mounts the agent panel from
// spektrum/agent. We don't auto-mount: the panel asks for an Anthropic
// API key on first open and we don't want to surprise casual visitors.
// Once enabled, the choice persists for the session via sessionStorage.
const AGENT_FLAG = 'spektrum:demo:agent-enabled';
const enableAgentLink = document.getElementById('enable-agent');

const mountAgent = async () => {
  const { mount: mountAgentPanel } = await import('../companions/spektrum-agent.js');
  // The agent drives the basket instance (more interesting surface area:
  // lists, filtering, multiple intents). Mount one per instance if you
  // want both wired. allowAllPaths because this is a demo — the agent is
  // read-only by default; a real app would pass protectedPaths instead.
  mountAgentPanel(basket, { position: small ? 'top-left' : 'top-right', title: 'agent · basket', allowAllPaths: true });
  enableAgentLink.style.display = 'none';
};

if (sessionStorage.getItem(AGENT_FLAG) === '1') {
  mountAgent();
} else {
  enableAgentLink.addEventListener('click', (ev) => {
    ev.preventDefault();
    sessionStorage.setItem(AGENT_FLAG, '1');
    mountAgent();
  });
}

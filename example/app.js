/*
  The Spektrum demo — three isolated instances on one page:

    counter  — the flagship widget: persisted history, undo, forks,
               a free-floating devtools scrubber.
    basket   — keyed lists, filtering, intents, persisted history,
               the dock UI (devtools + inspect as tabs), and the
               opt-in in-page agent panel.
    tour     — the self-documenting feature tour below the panels.
               Every section binds a live demo AND shows its own
               markup: the snippet is extracted from the DOM before
               bindDOM() runs, so what you read is exactly what's
               bound. The JS shown per section is fn.toString() of
               the wiring that actually ran — same guarantee.

  House rules this file follows (worth copying into your own app):
    - Defaults (`state.x ??= …`) are direct-mutated inside a seed
      system — they don't belong in history.
    - Reactive mirrors of engine internals (cursor, forks) are
      written into the DELTA directly (no record), so they fan out
      without polluting the timeline.
    - Custom data-fn handlers read the data-each row from the scope
      argument (`scope.item`, `scope.$index`) — never from a
      rewritten data-id (that pre-1.0 mechanism is gone).
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
// original future is back. The row index comes from the data-each
// iteration scope ($index), which bindAction passes to every handler
// as the trailing argument. (Pre-1.0 this read a data-id that the old
// text-rewriter rewrote per row; that mechanism is gone, and the old
// read silently produced NaN.)
const restoreFork = (instance) => (_el, _s, _d, _v, _e, scope) => {
  const idx = scope?.$index;
  const fork = instance.forks[idx];
  if (!fork) return;
  instance.replay(fork.forkedAt);
  for (const e of fork.entries) {
    if (e.op === 'set') instance.setValue(e.path, e.value, e.id);
    else if (e.op === 'add') instance.addValue(e.path, e.value, e.id);
    else if (e.op === 'checkpoint') instance.checkpoint(e.id, e.value);
  }
  // Consumed. We mutated forks directly (splice) which doesn't tick,
  // so write the updated mirror to delta to fan out the row removal.
  instance.forks.splice(idx, 1);
  mirrorForks(instance, instance.appStateDelta);
};
counter.defineFn('restoreFork', restoreFork(counter), {
  description: 'Re-apply the discarded future at the clicked row (index from the iteration scope).',
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

// removeAt: the clicked row's identity comes from the data-each
// iteration scope (scope.item), which bindAction passes to every
// handler as the trailing argument. Filtering by identity (not index)
// stays correct however the list is filtered or reordered. (Pre-1.0
// this parsed an index out of a data-id the old text-rewriter rewrote
// per row; that mechanism is gone — the old read produced NaN and
// silently removed nothing.) The markup keeps data-action="click.stop"
// to demonstrate the modifier syntax.
basket.defineFn('removeAt', (_el, state, delta, _v, _e, scope) => {
  const current = delta.items || state.items || [];
  basket.setValue(
    'items',
    current.filter((it) => it !== scope.item),
    `remove ${scope.item?.label ?? '?'}`,
  );
}, {
  description: 'Remove the clicked row from basket.items (row identity from the iteration scope).',
});

basket.defineFn('undo', () => {
  basket.replay(Math.max(0, basket.cursor - 1));
}, {
  description: 'Step the cursor back one history entry. Pure replay; nothing is recorded.',
});

basket.defineFn('restoreFork', restoreFork(basket), {
  description: 'Re-apply the discarded future at the clicked row (index from the iteration scope).',
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

// ============================================================
// === The feature tour =======================================
// ============================================================
//
// A third isolated instance. Not persisted — every load starts clean,
// so the demos are deterministic. Each section below follows the same
// shape: a setup fn wires the engine side, the markup lives in
// index.html, and BOTH are displayed inside the section verbatim
// (markup extracted pre-bind, JS via fn.toString()), so the page can
// never show code that differs from what runs.

const tour = createSpektrum({ snapshotEvery: 20 });
tour.onError((err) => console.error('[tour] system threw:', err));

// --- 1 · state, delta, tick — and the undefined footgun ---

const setupState = () => {
  tour.defineFn('msgHello', () => tour.setValue('msg', 'hello'), {
    description: 'Absolute write: setValue("msg", "hello").',
  });
  // Writing `undefined` records + merges, but fires NO subscribers —
  // tick() selects systems by whether the path RESOLVES in the delta.
  // The readouts above go stale on purpose. Write null to clear.
  tour.defineFn('msgUndef', () => tour.setValue('msg', undefined), {
    description: 'The footgun: setValue("msg", undefined) — merges but re-renders nothing.',
  });
  tour.defineFn('msgNull', () => tour.setValue('msg', null), {
    description: 'The fix: setValue("msg", null) — resolves, so bindings re-render empty.',
  });
};

// --- 2 · text + attribute bindings ---

const setupText = () => {
  // Nothing to wire: {{expr}} and :attr bindings are pure markup.
  // data-model="mood" writes state, the bindings re-render. See the
  // markup panel — note the comparison lives in :class (attribute
  // values are one string; a bare > inside {{…}} in a TEXT node can
  // be split by the HTML parser).
};

// --- 3 · two-way forms: data-model + modifiers ---

const setupForms = () => {
  // .trim / .number / .lazy are trailing path modifiers, chainable.
  // The JSON readout below the form subscribes to `form` — any
  // sub-path write (form.email, form.age, …) resolves through it.
};

// --- 4 · conditional display: data-if ---

const setupIf = () => {
  // data-if toggles display (v-show semantics) — children STAY BOUND.
  // The panel keeps re-rendering while hidden; unhide to see the
  // clicks it counted in the dark. The +1 button is the built-in
  // data-fn="addValue" — additive, accumulates within a tick.
};

// --- 5 · lists: data-each, keys, scope, <template>, nesting ---

const TRACK_NAMES = ['aurora', 'basalt', 'cirrus', 'dune', 'ember', 'fjord', 'geyser'];
const setupLists = () => {
  tour.defineFn('addTrack', (_el, state) => {
    const tracks = state.tracks || [];
    const name = TRACK_NAMES[tracks.length % TRACK_NAMES.length];
    tour.setValue('tracks', [...tracks, { id: nextId++, name }], `track+${name}`);
  }, { description: 'Append the next demo track to tracks.' });

  tour.defineFn('shuffleTracks', (_el, state) => {
    tour.setValue('tracks', [...state.tracks].sort(() => Math.random() - 0.5), 'shuffle');
  }, { description: 'Shuffle tracks — keyed rows keep their DOM nodes (and any half-typed note).' });

  tour.defineFn('sortTracks', (_el, state) => {
    tour.setValue('tracks', [...state.tracks].sort((a, b) => a.name.localeCompare(b.name)), 'sort');
  }, { description: 'Sort tracks by name — same keyed-reuse story as shuffle.' });

  // Row identity comes from the scope argument — scope.t is the row
  // object because the markup says data-as="t".
  tour.defineFn('removeTrack', (_el, state, _d, _v, _e, scope) => {
    tour.setValue('tracks', state.tracks.filter(x => x !== scope.t), `track-${scope.t?.name}`);
  }, { description: 'Remove the clicked row (identity via scope.t).' });

  tour.defineFn('bumpStock', (_el, state) => {
    const i = Math.floor(Math.random() * state.stock.length);
    tour.addValue(`stock.${i}.qty`, 1, `stock+${i}`);
  }, { description: 'addValue on a random stock.<i>.qty — the computed total re-derives.' });
};

// --- 6 · events: data-action modifiers, built-ins, cycle, refs ---

const setupActions = () => {
  tour.defineFn('shout', (el) => {
    tour.setValue('actionLog', `keydown.enter → you said “${el.value}”`);
    el.value = '';
  }, { description: 'Fires only on Enter (keydown.enter key gate).' });

  tour.defineFn('onlyOnce', () => {
    tour.setValue('actionLog', '.once fired — the listener removed itself; click again, nothing happens');
  }, { description: 'One-shot listener via the .once modifier.' });

  tour.defineFn('selfOnly', () => {
    tour.setValue('actionLog', '.self — the padded box itself was clicked');
  }, { description: 'Fires only when event.target IS the bound element (.self).' });

  tour.defineFn('innerClick', () => {
    tour.setValue('actionLog', 'inner button clicked — the parent’s .self handler stayed quiet');
  }, { description: 'Sibling handler proving .self filtered the bubbled click.' });

  tour.defineFn('focusSay', () => tour.refs.say?.focus(), {
    description: 'Imperative escape hatch: focus the input registered via data-ref="say".',
  });

  // data-action="cycle" is a SUBSCRIPTION, not a DOM event: the fn
  // runs whenever the data-id path changes. This one watches the
  // data-if demo's click counter.
  tour.defineFn('onClicksChange', () => {
    tour.addValue('cycleFired', 1, 'cycle');
  }, { description: 'Runs on every ui.clicks change (data-action="cycle" subscription).' });
};

// --- 7 · derived + async: computed, addAsync, refresh ---

const QUOTES = [
  'state is a timeline, not a snapshot',
  'every mutation is a fact — record it',
  'replay(n) is the debugger you already had',
  'small enough to read, honest enough to audit',
];
const setupDerived = () => {
  // computed: re-derives when any dep changes; throws E_COMPUTED_SELF_DEP
  // at registration if a dep overlaps its own output path.
  tour.computed('stockTotal', ['stock'], s =>
    (s.stock || []).reduce((sum, row) => sum + row.qty, 0));

  // addAsync sets quote.loading / quote.error / quote.data as the
  // promise progresses — each phase records through setValue, so a
  // replay re-applies the values without re-fetching. The "fetch" here
  // is a 700 ms timer picking the next line.
  let i = 0;
  tour.addAsync('quote', () => new Promise(resolve =>
    setTimeout(() => resolve(QUOTES[i++ % QUOTES.length]), 700)));

  tour.defineFn('reloadQuote', () => tour.refresh('quote'), {
    description: 'Re-run the loader registered under "quote" via refresh(path).',
  });
};

// --- 8 · time-travel: history, replay, checkpoints, forks ---

const feed = [];
const setupTimeTravel = () => {
  // Mirror engine internals (cursor, history length, …) into the DELTA
  // directly — a mirror is presentation, not a fact, so it must not
  // record. onRecord covers live mutations (including checkpoints);
  // the system covers replay(), because replay re-fires every system
  // against the final state after the scrub.
  const mirrorTT = (delta) => {
    delta.ttCursor = tour.cursor;
    delta.ttLength = tour.history.length;
    delta.ttSnaps = tour.snapshots.length;
    delta.ttForks = tour.forks.length;
    delta.ttHasMark = tour.checkpoints.some(c => c.id === 'marked');
    delta.ttFeed = feed.slice(-4).join('  ·  ') || '—';
  };
  tour.onRecord((entry) => {
    feed.push(`${entry.op}:${entry.id}`);
    mirrorTT(tour.appStateDelta);
  });
  tour.addSystem(['tt'], (_state, delta) => mirrorTT(delta));

  tour.defineFn('ttUndo', () => tour.replay(Math.max(0, tour.cursor - 1)), {
    description: 'replay(cursor − 1): rewind the WHOLE tour instance one recorded entry.',
  });
  tour.defineFn('ttMark', () => tour.checkpoint('marked', { by: 'tour' }), {
    description: 'Drop a named checkpoint — a tagged marker in history, no state effect.',
  });
  tour.defineFn('ttJump', () => {
    const cp = tour.checkpoints.findLast(c => c.id === 'marked');
    if (cp) tour.replay(cp.index + 1);
  }, { description: 'replay() to just after the most recent "marked" checkpoint.' });
};

// --- 9 · the agent surface ---

let specHandle = null;
const setupAgent = () => {
  // describe(): the one-call manifest. We inspect the COUNTER instance
  // (small state, easy to read) — cross-instance calls are just JS.
  tour.defineFn('runDescribe', () => {
    tour.setValue('agentOut', JSON.stringify(counter.describe(), null, 2), 'describe');
  }, { description: 'Render counter.describe() — the full operational manifest in one call.' });

  tour.defineFn('runExplain', () => {
    const trace = counter.explain({ from: Math.max(0, counter.cursor - 5) });
    tour.setValue('agentOut', JSON.stringify(trace, null, 2), 'explain');
  }, { description: 'Render counter.explain() for the last 5 entries — each annotated with the systems it triggers.' });

  // findByIntent: semantic UI lookup. Flash the four basket.add
  // buttons so the result is visible, not just countable.
  tour.defineFn('flashIntents', () => {
    const els = basket.findByIntent('basket.add');
    for (const el of els) {
      el.style.outline = '2px solid var(--accent)';
      setTimeout(() => { el.style.outline = ''; }, 1200);
    }
    tour.setValue('agentOut',
      `basket.findByIntent('basket.add') → ${els.length} elements (flashing above)`, 'findByIntent');
  }, { description: 'Locate elements by data-intent and flash them.' });

  // attempt(): speculative execution against THIS instance. The
  // pending flag is recorded AFTER the attempt's checkpoint, so
  // discard() rewinds it automatically — no cleanup bookkeeping.
  tour.defineFn('specStart', () => {
    specHandle = tour.attempt('plus-five', () => {
      for (let i = 0; i < 5; i++) tour.addValue('tt.count', 1, 'spec+1');
    });
    tour.setValue('spec.pending', true);
  }, { description: 'attempt("plus-five"): speculatively add 5 to tt.count.' });

  tour.defineFn('specCommit', () => {
    specHandle?.commit();               // records a plus-five:commit checkpoint
    specHandle = null;
    tour.setValue('spec.pending', false);
  }, { description: 'Keep the speculative branch (records a :commit checkpoint).' });

  tour.defineFn('specDiscard', () => {
    specHandle?.discard();              // replays back; entries land on forks
    specHandle = null;                  // (spec.pending rewinds with them)
  }, { description: 'Rewind the speculative branch; its entries land on tour.forks.' });
};

// --- boot the tour ---

// Seed defaults directly (not recorded — they're the starting facts,
// not user history), mirroring the counter/basket house pattern.
const seedTour = (state) => {
  state.msg ??= '(unset)';
  state.mood ??= '';
  state.form ??= { email: '', age: null, bio: '', newsletter: false, plan: '' };
  state.ui ??= { showPanel: true, clicks: 0 };
  state.tracks ??= [
    { id: nextId++, name: 'aurora' },
    { id: nextId++, name: 'basalt' },
    { id: nextId++, name: 'cirrus' },
  ];
  state.stock ??= [
    { id: nextId++, name: '🍎 apples', qty: 3 },
    { id: nextId++, name: '🍌 bananas', qty: 5 },
    { id: nextId++, name: '🥭 mangos', qty: 2 },
  ];
  state.groups ??= [
    { id: nextId++, title: 'citrus', items: [{ id: nextId++, label: 'lime' }, { id: nextId++, label: 'yuzu' }] },
    { id: nextId++, title: 'stone',  items: [{ id: nextId++, label: 'peach' }] },
  ];
  state.tt ??= { count: 0 };
  state.spec ??= { pending: false };
  state.actionLog ??= '(nothing yet)';
  state.cycleFired ??= 0;
};
seedTour(tour.appState);

setupState();
setupText();
setupForms();
setupIf();
setupLists();
setupActions();
setupDerived();
setupTimeTravel();
setupAgent();

// Self-documentation. Order matters: extract each demo's markup BEFORE
// bindDOM rewrites its text nodes, so the snippet is the author-written
// source. The JS panel gets the section's setup fn, verbatim.
const dedent = (html) => {
  const lines = html.replace(/^\n+/, '').trimEnd().split('\n');
  const pad = Math.min(...lines.filter(l => l.trim()).map(l => /^\s*/.exec(l)[0].length));
  return lines.map(l => l.slice(pad)).join('\n');
};
const SECTION_JS = {
  'f-state': setupState,
  'f-lists': setupLists,
  'f-actions': setupActions,
  'f-derived': setupDerived,
  'f-time': setupTimeTravel,
  'f-agent': setupAgent,
};
for (const feature of document.querySelectorAll('.feature')) {
  const demo = feature.querySelector('.demo');
  const html = feature.querySelector('details.src-html code');
  if (demo && html) html.textContent = dedent(demo.innerHTML);
  const js = feature.querySelector('details.src-js code');
  const fn = SECTION_JS[feature.id];
  if (js && fn) js.textContent = `const ${fn.name} = ` + fn.toString() + ';';
  if (demo) tour.bindDOM(demo);
}
tour.run();

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
// All three instances are exposed on `window.spektrum` so anyone (or
// any in-browser agent) can drive them from devtools console:
//
//   spektrum.basket.describe()                       // full manifest
//   spektrum.basket.findByIntent('basket.add')       // [el, el, el, el]
//   spektrum.counter.attempt('+5', () => {           // speculative edit
//     for (let i = 0; i < 5; i++)
//       spektrum.counter.addValue('count', 1, 'inc');
//   })                                                // → { result, commit, discard }
//   spektrum.counter.explain({ from: spektrum.counter.history.length - 5 })
//
// See AGENTS.md in the repo root for a full agent workflow tutorial.
window.spektrum = { counter, basket, tour };

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

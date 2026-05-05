/*
  Demo-specific boot.

  Seeds initial state, registers systems for behaviors that aren't
  declarative (clamp, derived flags, scrubber sync, log fan-out), then
  hands control to the engine.

  Declarative wiring lives in index.html via {{...}}, :attr, data-action,
  data-if, and data-each.
*/

import spektrum, {
  setValue, addSystem, defineFn, bindDOM, run, replay,
  history, setPathValue,
} from '../spektrum.js';

setValue('gas.value', 100, 'seed');

// Clamp gas.value to [0, 100] and derive flags + status text for the
// data-if / :disabled / setText bindings. Mutates state directly — no
// delta write needed since these are tied to the same path that
// triggered the system. Number(...) || 0 guards against the input
// sending undefined when the field is cleared.
addSystem(['gas.value'], (state) => {
  state.gas.value = Math.max(0, Math.min(100, Number(state.gas.value) || 0));
  state.gas.empty = state.gas.value === 0;
  state.gas.full = state.gas.value === 100;
  state.gas.statusText = state.gas.empty ? 'EMPTY'
    : state.gas.full ? 'FULL'
    : 'OK';
});

// Mirror the latest history entry into state.recentEvents so the log
// can be rendered with data-each. Writes into the delta so subscribers
// (the data-each in index.html) fire on the next tick pass — that's
// the fan-out the engine's tick loop now supports.
addSystem(['gas.value'], (state, delta) => {
  const last = history[spektrum.cursor - 1];
  if (!last) return;
  const entry = {
    id: last.id,
    value: last.value,
    display: `${last.id.padEnd(20)} ${last.value >= 0 ? '+' : ''}${last.value}`,
  };
  const events = state.recentEvents || [];
  setPathValue(delta, 'recentEvents', [entry, ...events].slice(0, 8));
});

// Scrubber sync: snap slider to the live end on every new action.
// Skipped during replay so user drags aren't fought.
const $scrub = document.getElementById('scrub');
addSystem(['gas.value'], () => {
  if (spektrum.replaying || !$scrub) return;
  $scrub.max = history.length;
  $scrub.value = history.length;
});

// data-fn="scrub": replay state to the slider's position. The log
// rebuilds itself via data-each as replay re-fires the log-pusher.
defineFn('scrub', (el) => {
  replay(Number(el.value));
});

bindDOM();
run();

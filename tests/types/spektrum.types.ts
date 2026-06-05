/*
  Hand-maintained .d.ts drift detector. This file is compiled by
  `npm run typecheck` (tsc --noEmit). It does NOT execute — its job
  is to fail compilation if spektrum.d.ts no longer matches the JS
  public surface, so the type definitions stay honest.

  Convention: import every public export, exercise its type in the
  way a real consumer would, and pin a few negative cases with
  `@ts-expect-error`. Tests are by inspection — a green tsc means
  the types compile against the documented API.
*/

import spektrum, {
  // Types
  type State,
  type HistoryEntry,
  type CheckpointView,
  type ForkRecord,
  type Snapshot,
  type SystemFn,
  type ErrorHandler,
  type RecordHandler,
  type ForkHandler,
  type EngineErrorCode,
  type FnMeta,
  type SpektrumManifest,
  type ExplainedEntry,
  type AttemptHandle,
  type BoundFn,
  type IterationScope,
  type SpektrumOptions,
  type Spektrum,
  // Values: singleton state references
  appState,
  appStateDelta,
  history,
  snapshots,
  forks,
  refs,
  intents,
  // Values: factory + helpers
  createSpektrum,
  getPathObj,
  setPathValue,
  precompile,
  // Values: singleton mutators / subscribers / hooks / lifecycle
  trigger,
  setValue,
  checkpoint,
  computed,
  addAsync,
  refresh,
  addSystem,
  watch,
  removeSystem,
  defineFn,
  onError,
  onRecord,
  onFork,
  bindDOM,
  run,
  tick,
  replay,
  reset,
  resetState,
  serialize,
  describe,
  explain,
  attempt,
  findByIntent,
} from '../../spektrum.js';

// === default export is the singleton ===

const sgl: Spektrum = spektrum;
const sglState: State = sgl.appState;

// === factory + options ===

const inst: Spektrum = createSpektrum();
const instOpts: Spektrum = createSpektrum({
  historyLimit: 1000,
  snapshotEvery: 100,
  forkLimit: 50,
});

// historyLimit accepts a number; nothing else
// @ts-expect-error — historyLimit must be number | undefined
createSpektrum({ historyLimit: 'lots' });

// === mutators ===

trigger('counter@inc', 'count', 1);
setValue('user.name', 'alice');
setValue('user.name', 'alice', 'rename');
checkpoint('milestone-1');
checkpoint('milestone-1', { author: 'tester' });

// setValue path is required (non-empty string at call site)
// @ts-expect-error — path is required
setValue();

// === subscriptions ===

const sysFn: SystemFn = (state, delta) => {
  const v: any = state['something'];
  void v; void delta;
};
const offSys: () => void = addSystem(['count'], sysFn);
offSys();

const offWatch: () => void = watch(['user.name'], (s, d) => void [s, d]);
offWatch();

const removed: boolean = removeSystem(sysFn);
void removed;

// === defineFn / BoundFn ===

const handler: BoundFn = (el, state, delta, value, ev) => {
  el.dataset.lastValue = String(value);
  void state; void delta; void ev;
};
defineFn('myFn', handler);

// Scope-aware handler form (PR #2's data-each refactor added the trailing
// `scope` param). Verifies the IterationScope type flows through.
const scopedHandler: BoundFn = (el, state, delta, value, ev, scope) => {
  const row: IterationScope | undefined = scope;
  void el; void state; void delta; void value; void ev; void row;
};
defineFn('myScopedFn', scopedHandler);

const meta: FnMeta = {
  description: 'set a flag',
  input: { type: 'object' },
  output: { type: 'boolean' },
  examples: [{ id: 'demo' }],
};
defineFn('myFnWithMeta', handler, meta);

// === computed ===

computed('total', ['cart.items'], (state) => {
  const items: any[] = state['cart']?.items ?? [];
  return items.reduce((a, x) => a + (x.price ?? 0), 0);
});

// === async resources ===

const loader: () => Promise<unknown> = addAsync('user', async () => {
  return { id: 1, name: 'alice' };
});
void loader;
const reran: Promise<unknown> | undefined = refresh('user');
void reran;

// === hooks (each returns unsubscribe; null clears) ===

const errHandler: ErrorHandler = (err, system) => {
  const code: EngineErrorCode | undefined = err.code;
  // Exhaustiveness gate: every member of EngineErrorCode must be
  // handled here. Adding a code to the union without a case (or
  // removing one) makes `_exhaustive` no longer `never` and fails
  // `tsc --noEmit`. This forces the union to stay a *deliberate*,
  // documented set rather than silently drifting. The runtime
  // source-scan gate in spektrum.test.js catches the other direction
  // (a code thrown in spektrum.js that was never added to the union).
  switch (code) {
    case 'E_TICK_OVERFLOW':
    case 'E_COMPUTED_SELF_DEP':
    case undefined:
      break;
    default: {
      const _exhaustive: never = code;
      void _exhaustive;
    }
  }
  void code; void system;
};
const offErr: () => void = onError(errHandler);
offErr();
onError(null);

const recHandler: RecordHandler = (entry) => { void entry.id; };
const offRec: () => void = onRecord(recHandler);
offRec();
onRecord(null);

const forkHandler: ForkHandler = (fork) => {
  const tail: HistoryEntry[] = fork.entries;
  void tail;
};
const offFork: () => void = onFork(forkHandler);
offFork();
onFork(null);

// === DOM lifecycle ===

const destroyAll: () => void = bindDOM();
const destroyEl: () => void = bindDOM(document.body);
destroyAll();
destroyEl();
run();
tick();
reset();
resetState();
replay(5);

// === serialize ===

const json: string = serialize();
const stateOnly: string = serialize({ includeHistory: false });
const withForks: string = serialize({ includeForks: true });
void json; void stateOnly; void withForks;

// === agent surface ===

const manifest: SpektrumManifest = describe();
const ck: CheckpointView[] = manifest.checkpoints;
const fnsList: SpektrumManifest['fns'] = manifest.fns;
void ck; void fnsList;

const trace: ExplainedEntry[] = explain({ from: 0, to: 10 });
void trace;

const handle: AttemptHandle<number> = attempt('edit', () => 42);
const result: number = handle.result;
handle.commit();
handle.discard();
void result;

const els: Element[] = findByIntent('row.delete');
void els;

// === precompile ===

precompile('a.b.c', (state) => state['a']?.b?.c);

// === instance state shapes ===

const _stateRef: State = appState;
const _deltaRef: State = appStateDelta;
const _hist: HistoryEntry[] = history;
const _snaps: Snapshot[] = snapshots;
const _forks: ForkRecord[] = forks;
const _refs: Record<string, Element> = refs;
const _intents: Record<string, Element[]> = intents;

// === path helpers ===

const v1: string | undefined = getPathObj<string>(appState, 'user.name');
const v2: number | undefined = getPathObj<number>(appState, 'count');
void v1; void v2;
setPathValue(appState, 'user.email', 'a@b.c');

// === instance cursor / replaying are readonly numbers / booleans ===

const cur: number = inst.cursor;
const rep: boolean = inst.replaying;
void cur; void rep;

// instance.cursor is read-only — assignment is a type error
// @ts-expect-error — cursor is a getter, not assignable
inst.cursor = 0;

// === Spektrum interface surface check ===

const _surfaceCheck: Spektrum = {
  appState: inst.appState,
  appStateDelta: inst.appStateDelta,
  history: inst.history,
  snapshots: inst.snapshots,
  forks: inst.forks,
  refs: inst.refs,
  intents: inst.intents,
  get cursor() { return inst.cursor; },
  get replaying() { return inst.replaying; },
  get checkpoints() { return inst.checkpoints; },
  trigger: inst.trigger,
  setValue: inst.setValue,
  addValue: inst.addValue,
  checkpoint: inst.checkpoint,
  computed: inst.computed,
  addAsync: inst.addAsync,
  refresh: inst.refresh,
  addSystem: inst.addSystem,
  watch: inst.watch,
  removeSystem: inst.removeSystem,
  defineFn: inst.defineFn,
  onError: inst.onError,
  onRecord: inst.onRecord,
  onFork: inst.onFork,
  bindDOM: inst.bindDOM,
  run: inst.run,
  tick: inst.tick,
  replay: inst.replay,
  reset: inst.reset,
  resetState: inst.resetState,
  serialize: inst.serialize,
  describe: inst.describe,
  explain: inst.explain,
  attempt: inst.attempt,
  findByIntent: inst.findByIntent,
};
void _surfaceCheck;

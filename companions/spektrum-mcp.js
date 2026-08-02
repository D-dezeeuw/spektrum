/*
  Spektrum — MCP tool factory.

  Exposes a Spektrum instance as a set of MCP tools (read state, drive
  it, scrub history, locate UI by intent, get a manifest, get a causal
  trace). SDK-agnostic by design: this module returns plain JS tool
  definitions ({ name, description, inputSchema, handler }) so you can
  wire them into the MCP server SDK of your choice (stdio, HTTP, your
  agent framework's tool layer, anything).

  Standalone module, zero deps. Not bundled into spektrum.js — opt in
  only when you want to put a running Spektrum app on the wire for an
  agent to read and drive.

  Usage:

    import { createTools } from 'spektrum/mcp';
    import spektrum from 'spektrum';

    const tools = createTools(spektrum);
    // Pass tools[].handler to your MCP server SDK as you would any
    // other tool implementation. Each handler returns plain JSON.

  When wired into an MCP-speaking agent (Claude Desktop, Cursor, an
  in-app supervisor, etc.) the agent can:
    - read current state              → spektrum.getState
    - inspect the manifest            → spektrum.describe
    - trace causality over history    → spektrum.explain
    - mutate state through the API    → spektrum.setValue
    - mark logical boundaries         → spektrum.checkpoint
    - speculatively try + commit/discard → spektrum.attempt
    - scrub time                      → spektrum.replay
    - locate UI by intent             → spektrum.findByIntent
    - export a portable snapshot      → spektrum.serialize

  All tools are pure with respect to the engine — they go through the
  public API. Time-travel works exactly as for a human user: every
  agent-driven mutation is recorded, replayable, and forkable.

  Security note: this module hands an agent direct access to your
  application state. Only mount it in environments where you trust
  the agent and the transport (e.g. local stdio MCP, never open to
  the internet without auth).
*/

// Schema builders. Every tool's inputSchema is a closed object schema,
// so `type: 'object'` and `additionalProperties: false` repeated per
// tool — and object keys survive minification unshortened. Factoring
// them into one builder (and sharing the handful of leaf-field schemas
// that recur) is pure structural dedup: the emitted schemas are
// byte-for-byte identical, just assembled from shared parts.
const OBJ = (properties, required = []) =>
  ({ type: 'object', properties, required, additionalProperties: false });
const STR  = { type: 'string' };                 // optional string
const STR1 = { type: 'string', minLength: 1 };   // required non-empty string
const NO_INPUT = OBJ({});

const ok  = (data)  => ({ ok: true,  data });
const err = (error) => ({ ok: false, error });

/** Deep copy of engine state before it leaves a tool handler. Over a
 *  JSON transport a copy happens anyway, but this module is explicitly
 *  designed to be handed to an in-process agent library — and there a
 *  live `appState` reference is a hole straight past the write guard:
 *  mutate the object you got back from `getState` and no handler ever
 *  runs.
 *
 *  `structuredClone` (a platform global — Safari 15.4+, under our 16.4
 *  floor) is a drop-in for the JSON-shaped state domain, and it beats a
 *  hand-rolled walker on bytes. Its one behavioural difference — a
 *  literal own `__proto__` key would be copied rather than dropped —
 *  cannot arise: the engine's SAFE_KEY guards block such a key from ever
 *  landing in state. Bonus: NaN/Infinity survive (a JSON round-trip
 *  would not). */
const clone = structuredClone;

/** Build a path guard from a non-empty `protectedPaths` array (the
 *  caller's three-way ternary only reaches here with one). Returns
 *  true when the path is DENIED. */
const buildGuard = (patterns) => {
  // Strip stateful RegExp flags once, at build time. `g` and `y` make
  // `.test()` advance `lastIndex`, so the same pattern alternates
  // between matching and not matching on successive calls — protection
  // would flicker on and off per write. Rebuild rather than mutate the
  // caller's RegExp.
  const norm = patterns.map(p =>
    p instanceof RegExp && /[gy]/.test(p.flags)
      ? new RegExp(p.source, p.flags.replace(/[gy]/g, ''))
      : p);
  return (path) => norm.some(p =>
    typeof p === 'string'
      // Overlap is BIDIRECTIONAL. A write is denied when the path is
      // the protected path, when it sits under it (`llm.apiKey` under
      // a guard on `llm`), and when it is an ancestor of it (`llm`
      // when `llm.apiKey` is guarded). The ancestor arm is what stops
      // `setValue('llm', { apiKey: '…' })` from replacing a protected
      // leaf wholesale — without it, every documented protectedPaths
      // example was bypassable by writing the parent object. The dot
      // boundary keeps `llmFoo` from matching a guard on `llm`.
      ? path === p || path.startsWith(p + '.') || p.startsWith(path + '.')
      : p.test(path));
};

// Argument validation. An MCP SDK handed a raw `inputSchema` does not
// necessarily validate arguments before dispatch, so a malformed call
// used to reach the engine and throw a raw TypeError out of the handler
// (`path.split is not a function`) instead of returning the error
// envelope every other failure path uses. These check only what the
// handler is about to dereference — engine-thrown errors still
// propagate, so a genuine E_TICK_OVERFLOW is never mistaken for bad
// input.
const isPath  = (v) => typeof v === 'string' && v.length > 0;
const isIndex = (v) => Number.isInteger(v) && v >= 0;
// Message builders — the same two sentences appear across nine
// handlers. Naming the offending field keeps the envelope useful to an
// agent trying to correct its own call.
const bad    = (f, t) => err(`${f} must be ${t}`);
const badStr = (f) => bad(f, 'a non-empty string');
const badInt = (f) => bad(f, 'a non-negative integer');

/**
 * Build the MCP tool catalog for a Spektrum instance.
 *
 * @param {object} spektrum - the engine instance to expose
 * @param {object} [opts]
 * @param {string} [opts.prefix='spektrum.'] - namespace prepended to every tool name
 * @param {Array<string|RegExp>} [opts.protectedPaths] - paths that mutation tools (setValue, trigger, and the inline set/add ops inside attempt.start) refuse to write. String entries match exact path or dot-segment prefix; RegExp entries are tested as-is. Denied writes return `{ ok: false, error: 'protected: <path>' }` and the engine is never called. Reads, describe, explain, replay, etc. are unaffected. Takes precedence over `allowAllPaths`. The in-page agent companion forwards its own `protectedPaths` opt here.
 * @param {boolean} [opts.allowAllPaths] - opt into unrestricted writes. Writes are **denied by default** (read-only agent); pass `protectedPaths` to allow all but specific paths, or `allowAllPaths: true` to allow every path. Ignored when `protectedPaths` is set (those still apply).
 * @param {boolean} [opts.allowTimeTravel] - in read-only mode only, opt back into the history-mutating tools (`checkpoint`, `attempt.start`, `replay`). Read-only denies them by default because they rewrite the timeline: `replay` moves the cursor back, and the next recorded entry then truncates everything after it. Ignored when writes are enabled (those modes already allow time travel).
 * @returns {Array<{name: string, description: string, inputSchema: object, handler: (args: object) => any}>}
 */
export const createTools = (spektrum, opts = {}) => {
  const prefix = opts.prefix ?? 'spektrum.';
  // Safe-by-default (1.1.0): writes are DENIED unless the caller opts
  // in. protectedPaths wins — it means "allow everything except these".
  // allowAllPaths means "allow everything". With neither, the guard
  // denies all writes, so a forgotten config yields a read-only agent
  // instead of one with full authority over app state.
  const writesEnabled = !!(opts.protectedPaths?.length || opts.allowAllPaths);
  const guard = opts.protectedPaths?.length ? buildGuard(opts.protectedPaths)
    : opts.allowAllPaths ? null
    : () => true;
  // "Read-only" has to mean the timeline too. `checkpoint` and `replay`
  // never write state directly, but they DO mutate history: replay
  // rewinds the cursor, and `record()` truncates everything past the
  // cursor on the next entry — so a deny-all catalog could still rewind
  // the live app and destroy its history. `attempt.start` records a
  // checkpoint before running, so it belongs to the same set even when
  // every action it carries is a checkpoint. Opt back in deliberately
  // with allowTimeTravel when an agent needs to scrub a read-only app.
  const timeTravelDenied = !writesEnabled && !opts.allowTimeTravel;
  const readOnlyErr = () => err('read-only; set allowTimeTravel to scrub');
  const t = (name, description, inputSchema, handler) => ({
    name: prefix + name, description, inputSchema, handler,
  });

  const speculative = new Map(); // id → handle from spektrum.attempt
  let seq = 0;                   // disambiguates attempt handle ids

  return [
    t('getState',
      'Current committed state as JSON. Excludes history.',
      NO_INPUT,
      () => ok(clone(spektrum.appState))),

    t('describe',
      'Operational manifest: state, systems, fns, refs, intents, checkpoints, options. Best first call to orient.',
      NO_INPUT,
      () => ok(clone(spektrum.describe()))),

    t('explain',
      'Causal trace over a history slice; each entry annotated with the systems its path triggers.',
      OBJ({
        from: { type: 'integer', minimum: 0, description: 'Inclusive start index (default 0).' },
        to:   { type: 'integer', minimum: 0, description: 'Exclusive end index (default history.length).' },
      }),
      ({ from, to } = {}) => {
        if (from !== undefined && !isIndex(from)) return badInt('from');
        if (to !== undefined && !isIndex(to)) return badInt('to');
        return ok(clone(spektrum.explain({ from, to })));
      }),

    t('setValue',
      'Write value to a dotted state path. Recorded; fires subscribers next tick.',
      OBJ({ path: { ...STR1, description: 'Dotted path, e.g. "user.email".' }, value: {}, id: STR }, ['path']),
      ({ path, value, id } = {}) => {
        if (!isPath(path)) return badStr('path');
        if (guard && guard(path)) return err(`protected: ${path}`);
        spektrum.setValue(path, value, id);
        return ok({ cursor: spektrum.cursor });
      }),

    t('trigger',
      'Additive numeric change at a path.',
      OBJ({ id: STR1, path: STR1, value: { type: 'number' } }, ['id', 'path', 'value']),
      ({ id, path, value } = {}) => {
        if (!isPath(path) || !isPath(id)) return badStr('id and path');
        if (typeof value !== 'number') return bad('value', 'a number');
        if (guard && guard(path)) return err(`protected: ${path}`);
        spektrum.trigger(id, path, value);
        return ok({ cursor: spektrum.cursor });
      }),

    t('checkpoint',
      'Tag a boundary in history. Pure marker; no state effect on replay.',
      OBJ({ name: STR1, metadata: {} }, ['name']),
      ({ name, metadata } = {}) => {
        if (timeTravelDenied) return readOnlyErr();
        if (!isPath(name)) return badStr('name');
        spektrum.checkpoint(name, metadata);
        return ok({ cursor: spektrum.cursor });
      }),

    t('attempt.start',
      'Begin a speculative attempt (returns a handle id). Pair with attempt.commit/discard.',
      OBJ({
        name:    STR1,
        actions: {
          type: 'array',
          description: 'Sequence of setValue / trigger / checkpoint calls to perform inside the attempt.',
          items: OBJ({ op: { enum: ['set', 'add', 'checkpoint'] }, path: STR, value: {}, id: STR, name: STR }, ['op']),
        },
      }, ['name', 'actions']),
      ({ name, actions } = {}) => {
        if (timeTravelDenied) return readOnlyErr();
        if (!isPath(name)) return badStr('name');
        if (!Array.isArray(actions)) return bad('actions', 'an array');
        // Validate and guard EVERY action up front, before the attempt
        // records its opening checkpoint — a rejection must leave no
        // trace in history.
        for (const a of actions) {
          if (!a || (a.op !== 'set' && a.op !== 'add' && a.op !== 'checkpoint')) {
            return bad('action.op', 'set/add/checkpoint');
          }
          if (a.op === 'checkpoint') continue;
          if (!isPath(a.path)) return badStr('action path');
          if (a.op === 'add' && typeof a.value !== 'number') return bad('action.value', 'a number');
          if (guard && guard(a.path)) return err(`protected: ${a.path}`);
        }
        const handle = spektrum.attempt(name, () => {
          for (const a of actions) {
            if (a.op === 'set') spektrum.setValue(a.path, a.value, a.id);
            else if (a.op === 'add') spektrum.trigger(a.id, a.path, a.value);
            else if (a.op === 'checkpoint') spektrum.checkpoint(a.name || name, a.value);
          }
        });
        // Disambiguate handles: `${name}:${cursor}` alone collides when
        // two attempts share a name and land on the same cursor, and the
        // second registration would silently overwrite a live handle
        // (leaking the first, which could then never be committed or
        // discarded).
        const id = `${name}:${spektrum.cursor}:${seq++}`;
        speculative.set(id, handle);
        return ok({ id, cursor: spektrum.cursor, state: clone(spektrum.appState) });
      }),

    t('attempt.commit',
      'Commit an attempt; records a commit checkpoint and forgets the handle.',
      OBJ({ id: STR1 }, ['id']),
      ({ id } = {}) => {
        const h = speculative.get(id);
        if (!h) return err('unknown attempt id');
        h.commit();
        speculative.delete(id);
        return ok({ cursor: spektrum.cursor });
      }),

    t('attempt.discard',
      'Discard an attempt; rewinds to before it. Discarded entries land on forks.',
      OBJ({ id: STR1 }, ['id']),
      ({ id } = {}) => {
        const h = speculative.get(id);
        if (!h) return err('unknown attempt id');
        h.discard();
        speculative.delete(id);
        return ok({ cursor: spektrum.cursor, state: clone(spektrum.appState) });
      }),

    t('replay',
      'Move the cursor to history index n and rebuild state.',
      OBJ({ n: { type: 'integer', minimum: 0 } }, ['n']),
      ({ n } = {}) => {
        if (timeTravelDenied) return readOnlyErr();
        if (!isIndex(n)) return badInt('n');
        spektrum.replay(n);
        return ok({ cursor: spektrum.cursor, state: clone(spektrum.appState) });
      }),

    t('findByIntent',
      'Element descriptors for every element with the given data-intent. Locate UI by purpose, not selector.',
      OBJ({ name: STR1 }, ['name']),
      ({ name } = {}) => {
        if (!isPath(name)) return badStr('name');
        return ok(spektrum.findByIntent(name).map(describeElement));
      }),

    t('serialize',
      'Portable JSON snapshot: state, history, cursor. includeForks for debug dumps.',
      OBJ({
        includeHistory: { type: 'boolean' },
        includeForks:   { type: 'boolean' },
      }),
      (args = {}) => ok(JSON.parse(spektrum.serialize(args)))),
  ];
};

const describeElement = (el) => ({
  tag: el.tagName?.toLowerCase(),
  id: el.id || undefined,
  classes: el.className ? String(el.className).split(/\s+/).filter(Boolean) : undefined,
  dataset: el.dataset ? { ...el.dataset } : undefined,
  text: (el.textContent || '').slice(0, 80),
});

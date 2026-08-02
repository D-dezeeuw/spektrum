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

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };

const ok  = (data)  => ({ ok: true,  data });
const err = (error) => ({ ok: false, error });

/** Structural deep copy of the supported state shape (plain objects +
 *  arrays; primitives — including NaN/Infinity — pass through).
 *  Mirrors the engine's own `deepClone` rather than importing it: this
 *  module is standalone and zero-dep.
 *
 *  Every tool that returns engine state clones it first. Over a JSON
 *  transport that copy happens anyway, but this module is explicitly
 *  designed to be handed to an in-process agent library — and there a
 *  live `appState` reference is a hole straight past the write guard:
 *  mutate the object you got back from getState and no handler ever
 *  runs. */
const clone = (v) => {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = clone(v[k]);
    return o;
  }
  return v;
};

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
const badStr = (f) => err(`${f} must be a non-empty string`);
const badInt = (f) => err(`${f} must be a non-negative integer`);

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
  const readOnlyErr = () => err('read-only: history is not writable (set allowTimeTravel to permit scrubbing)');
  const t = (name, description, inputSchema, handler) => ({
    name: prefix + name, description, inputSchema, handler,
  });

  const speculative = new Map(); // id → handle from spektrum.attempt
  let seq = 0;                   // disambiguates attempt handle ids

  return [
    t('getState',
      'Return the current committed application state as JSON. Cheap; does not include history.',
      NO_INPUT,
      () => ok(clone(spektrum.appState))),

    t('describe',
      'Return the operational manifest: state, registered systems, fns and their schemas, refs, intents, checkpoints, history shape, and instance options. The single best first call for an agent orienting itself.',
      NO_INPUT,
      () => ok(clone(spektrum.describe()))),

    t('explain',
      'Causal trace over a slice of history. Each entry is annotated with the systems whose subscriptions intersect its path.',
      {
        type: 'object',
        properties: {
          from: { type: 'integer', minimum: 0, description: 'Inclusive start index (default 0).' },
          to:   { type: 'integer', minimum: 0, description: 'Exclusive end index (default history.length).' },
        },
        additionalProperties: false,
      },
      ({ from, to } = {}) => {
        if (from !== undefined && !isIndex(from)) return badInt('from');
        if (to !== undefined && !isIndex(to)) return badInt('to');
        return ok(clone(spektrum.explain({ from, to })));
      }),

    t('setValue',
      'Write `value` to the dotted state path. Recorded in history; subscribed systems fire on the next tick.',
      {
        type: 'object',
        properties: {
          path:  { type: 'string', minLength: 1, description: 'Dotted path, e.g. "user.email".' },
          value: { description: 'Any JSON-serializable value.' },
          id:    { type: 'string', description: 'Optional history id (defaults to "set:<path>").' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      ({ path, value, id } = {}) => {
        if (!isPath(path)) return badStr('path');
        if (guard && guard(path)) return err(`protected: ${path}`);
        spektrum.setValue(path, value, id);
        return ok({ cursor: spektrum.cursor });
      }),

    t('trigger',
      'Record an additive numeric change at the given path.',
      {
        type: 'object',
        properties: {
          id:    { type: 'string', minLength: 1 },
          path:  { type: 'string', minLength: 1 },
          value: { type: 'number' },
        },
        required: ['id', 'path', 'value'],
        additionalProperties: false,
      },
      ({ id, path, value } = {}) => {
        if (!isPath(path) || !isPath(id)) return badStr('id and path');
        if (typeof value !== 'number') return err('value must be a number');
        if (guard && guard(path)) return err(`protected: ${path}`);
        spektrum.trigger(id, path, value);
        return ok({ cursor: spektrum.cursor });
      }),

    t('checkpoint',
      'Mark a tagged boundary in history. Pure marker — replay walks past it without state effect.',
      {
        type: 'object',
        properties: {
          name:     { type: 'string', minLength: 1 },
          metadata: { description: 'Optional JSON-serializable payload.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      ({ name, metadata } = {}) => {
        if (timeTravelDenied) return readOnlyErr();
        if (!isPath(name)) return badStr('name');
        spektrum.checkpoint(name, metadata);
        return ok({ cursor: spektrum.cursor });
      }),

    t('attempt.start',
      'Begin a speculative attempt. Returns a handle id; pair with attempt.commit or attempt.discard. Use this when you want to try an edit, evaluate the result, and decide whether to keep it.',
      {
        type: 'object',
        properties: {
          name:    { type: 'string', minLength: 1, description: 'Label for the attempt; appears in history as "attempt:<name>".' },
          actions: {
            type: 'array',
            description: 'Sequence of setValue / trigger / checkpoint calls to perform inside the attempt.',
            items: {
              type: 'object',
              properties: {
                op:    { enum: ['set', 'add', 'checkpoint'] },
                path:  { type: 'string' },
                value: {},
                id:    { type: 'string' },
                name:  { type: 'string' },
              },
              required: ['op'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'actions'],
        additionalProperties: false,
      },
      ({ name, actions } = {}) => {
        if (timeTravelDenied) return readOnlyErr();
        if (!isPath(name)) return badStr('name');
        if (!Array.isArray(actions)) return err('actions must be an array');
        // Validate and guard EVERY action up front, before the attempt
        // records its opening checkpoint — a rejection must leave no
        // trace in history.
        for (const a of actions) {
          if (!a || (a.op !== 'set' && a.op !== 'add' && a.op !== 'checkpoint')) {
            return err('each action needs op: "set" | "add" | "checkpoint"');
          }
          if (a.op === 'checkpoint') continue;
          if (!isPath(a.path)) return badStr('action path');
          if (a.op === 'add' && typeof a.value !== 'number') return err('add actions need a numeric value');
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
      'Commit a previously started attempt; records a "<name>:commit" checkpoint and forgets the handle.',
      {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'],
        additionalProperties: false,
      },
      ({ id } = {}) => {
        const h = speculative.get(id);
        if (!h) return err('unknown attempt id');
        h.commit();
        speculative.delete(id);
        return ok({ cursor: spektrum.cursor });
      }),

    t('attempt.discard',
      'Discard a previously started attempt; rewinds the cursor to before the attempt and forgets the handle. The discarded entries land on `forks` on the next mutation.',
      {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'],
        additionalProperties: false,
      },
      ({ id } = {}) => {
        const h = speculative.get(id);
        if (!h) return err('unknown attempt id');
        h.discard();
        speculative.delete(id);
        return ok({ cursor: spektrum.cursor, state: clone(spektrum.appState) });
      }),

    t('replay',
      'Move the cursor to history index `n` and rebuild state. Cheap when `snapshotEvery` is set on the instance.',
      {
        type: 'object',
        properties: { n: { type: 'integer', minimum: 0 } },
        required: ['n'],
        additionalProperties: false,
      },
      ({ n } = {}) => {
        if (timeTravelDenied) return readOnlyErr();
        if (!isIndex(n)) return badInt('n');
        spektrum.replay(n);
        return ok({ cursor: spektrum.cursor, state: clone(spektrum.appState) });
      }),

    t('findByIntent',
      'Return a list of element descriptors (tag, id, classes, dataset) for every element carrying the given data-intent. Lets the agent locate UI by purpose, not selector.',
      {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1 } },
        required: ['name'],
        additionalProperties: false,
      },
      ({ name } = {}) => {
        if (!isPath(name)) return badStr('name');
        return ok(spektrum.findByIntent(name).map(describeElement));
      }),

    t('serialize',
      'Return a portable JSON snapshot. Default includes state, history, and cursor (replay-able). Pass includeForks for debug dumps.',
      {
        type: 'object',
        properties: {
          includeHistory: { type: 'boolean' },
          includeForks:   { type: 'boolean' },
        },
        additionalProperties: false,
      },
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

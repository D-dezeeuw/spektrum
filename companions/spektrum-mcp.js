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

/** Build a path guard from `protectedPaths`. String entries match the
 *  full dotted path OR a dot-segment prefix (so `'llm'` covers
 *  `llm.apiKey`, `llm.provider`, etc., but not `llmFoo`). RegExp
 *  entries are tested as-is. Returns null when no patterns supplied —
 *  caller skips the gate. */
const buildGuard = (patterns) => {
  if (!patterns || !patterns.length) return null;
  return (path) => patterns.some(p =>
    typeof p === 'string'
      ? path === p || path.startsWith(p + '.')
      : p.test(path)
  );
};

const warnUnguarded = () => console.warn('[spektrum/mcp] ungated catalog: agent can write ANY path (keys, auth, config). Pass protectedPaths to fence, or allowAllPaths:true to silence.');

/**
 * Build the MCP tool catalog for a Spektrum instance.
 *
 * @param {object} spektrum - the engine instance to expose
 * @param {object} [opts]
 * @param {string} [opts.prefix='spektrum.'] - namespace prepended to every tool name
 * @param {Array<string|RegExp>} [opts.protectedPaths] - paths that mutation tools (setValue, trigger, and the inline set/add ops inside attempt.start) refuse to write. String entries match exact path or dot-segment prefix; RegExp entries are tested as-is. Denied writes return `{ ok: false, error: 'protected: <path>' }` and the engine is never called. Reads, describe, explain, replay, etc. are unaffected. The in-page agent companion forwards its own `protectedPaths` opt here.
 * @param {boolean} [opts.allowAllPaths] - explicit acknowledgement that the agent may write anywhere. Set this (instead of `protectedPaths`) to silence the unrestricted-write safety warning when full write access is genuinely intended.
 * @returns {Array<{name: string, description: string, inputSchema: object, handler: (args: object) => any}>}
 */
export const createTools = (spektrum, opts = {}) => {
  const prefix = opts.prefix ?? 'spektrum.';
  const guard  = buildGuard(opts.protectedPaths);
  // Safe-by-default posture without a breaking change: writes still
  // work when ungated (back-compat), but an unguarded catalog is a
  // foot-gun — an agent can overwrite any path (API keys, auth,
  // config). Warn loudly, once, unless the caller passed
  // `allowAllPaths` to consciously opt in.
  if (!guard && !opts.allowAllPaths) warnUnguarded();
  const t = (name, description, inputSchema, handler) => ({
    name: prefix + name, description, inputSchema, handler,
  });

  const speculative = new Map(); // id → handle from spektrum.attempt

  return [
    t('getState',
      'Return the current committed application state as JSON. Cheap; does not include history.',
      NO_INPUT,
      () => ok(spektrum.appState)),

    t('describe',
      'Return the operational manifest: state, registered systems, fns and their schemas, refs, intents, checkpoints, history shape, and instance options. The single best first call for an agent orienting itself.',
      NO_INPUT,
      () => ok(spektrum.describe())),

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
      ({ from, to } = {}) => ok(spektrum.explain({ from, to }))),

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
      ({ path, value, id }) => {
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
      ({ id, path, value }) => {
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
      ({ name, metadata }) => { spektrum.checkpoint(name, metadata); return ok({ cursor: spektrum.cursor }); }),

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
      ({ name, actions }) => {
        if (guard) {
          for (const a of actions) {
            if ((a.op === 'set' || a.op === 'add') && guard(a.path)) {
              return err(`protected: ${a.path}`);
            }
          }
        }
        const handle = spektrum.attempt(name, () => {
          for (const a of actions) {
            if (a.op === 'set') spektrum.setValue(a.path, a.value, a.id);
            else if (a.op === 'add') spektrum.trigger(a.id, a.path, a.value);
            else if (a.op === 'checkpoint') spektrum.checkpoint(a.name || name, a.value);
          }
        });
        const id = `${name}:${spektrum.cursor}`;
        speculative.set(id, handle);
        return ok({ id, cursor: spektrum.cursor, state: spektrum.appState });
      }),

    t('attempt.commit',
      'Commit a previously started attempt; records a "<name>:commit" checkpoint and forgets the handle.',
      {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'],
        additionalProperties: false,
      },
      ({ id }) => {
        const h = speculative.get(id);
        if (!h) return { ok: false, error: 'unknown attempt id' };
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
      ({ id }) => {
        const h = speculative.get(id);
        if (!h) return { ok: false, error: 'unknown attempt id' };
        h.discard();
        speculative.delete(id);
        return ok({ cursor: spektrum.cursor, state: spektrum.appState });
      }),

    t('replay',
      'Move the cursor to history index `n` and rebuild state. Cheap when `snapshotEvery` is set on the instance.',
      {
        type: 'object',
        properties: { n: { type: 'integer', minimum: 0 } },
        required: ['n'],
        additionalProperties: false,
      },
      ({ n }) => { spektrum.replay(n); return ok({ cursor: spektrum.cursor, state: spektrum.appState }); }),

    t('findByIntent',
      'Return a list of element descriptors (tag, id, classes, dataset) for every element carrying the given data-intent. Lets the agent locate UI by purpose, not selector.',
      {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1 } },
        required: ['name'],
        additionalProperties: false,
      },
      ({ name }) => ok(spektrum.findByIntent(name).map(describeElement))),

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

/**
 * Type declarations for `spektrum/mcp` — a SDK-agnostic factory that
 * exposes a Spektrum instance as plain MCP tool definitions (read
 * state, drive it, scrub history, locate UI by intent, manifest,
 * causal trace).
 *
 * Source of truth: `companions/spektrum-mcp.js`. When the runtime
 * shape changes, update this file in the same commit.
 *
 * Security: these tools hand an agent direct access to your app
 * state. Mount only where you trust the agent and transport.
 */

import type { Spektrum } from '../spektrum.js';

/** A single MCP tool definition. `inputSchema` is JSON Schema;
 *  `handler` returns plain JSON (`{ ok: true, data }` or
 *  `{ ok: false, error }`). */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>) => unknown;
}

/** A `protectedPaths` entry: an exact path / dot-segment prefix
 *  (string) or a pattern tested as-is (RegExp). */
export type PathPattern = string | RegExp;

/** Options for {@link createTools}. */
export interface CreateToolsOptions {
  /** Namespace prepended to every tool name. Defaults to
   *  `'spektrum.'`. */
  prefix?: string;
  /**
   * Paths the mutation tools (`setValue`, `trigger`, and the inline
   * set/add ops inside `attempt.start`) refuse to write — i.e. "allow
   * everything except these". Denied writes return
   * `{ ok: false, error: 'protected: <path>' }` without calling the
   * engine. Takes precedence over `allowAllPaths`.
   *
   * String entries match on **bidirectional** dotted-path overlap: the
   * exact path, any descendant of it, and any ancestor of it. The
   * ancestor arm is what stops a write to the parent object from
   * replacing a protected leaf wholesale — guarding `'llm.apiKey'`
   * also denies `setValue('llm', { apiKey: '…' })`. The dot boundary
   * keeps unrelated same-prefix keys (`llmFoo`) writable.
   *
   * RegExp entries are tested against the path. Stateful flags (`g`,
   * `y`) are stripped internally so `lastIndex` cannot make protection
   * alternate between calls; the RegExp you pass is never mutated.
   *
   * **This is a write fence, not a read fence.** A guarded path is
   * still readable through `getState`, `describe`, `explain`, and
   * `serialize`. Do not rely on it to keep secrets from an agent —
   * keep them out of engine state instead.
   */
  protectedPaths?: PathPattern[];
  /**
   * Opt into unrestricted writes. Writes are **denied by default**
   * (a read-only agent): pass `protectedPaths` to allow all but
   * specific paths, or `allowAllPaths: true` to allow every path.
   * Ignored when `protectedPaths` is set.
   */
  allowAllPaths?: boolean;
  /**
   * In read-only mode only, opt back into the history-mutating tools
   * (`checkpoint`, `attempt.start`, `replay`).
   *
   * Read-only denies them by default because they rewrite the
   * timeline even though they never write state directly: `replay`
   * moves the cursor back, and the next recorded entry truncates
   * everything after it. Without this gate a deny-all catalog could
   * still rewind the running app and destroy its history.
   *
   * Ignored when writes are enabled — those modes already permit time
   * travel.
   */
  allowTimeTravel?: boolean;
}

/**
 * Build the tool catalog for an instance. Each `handler` goes through
 * the public API, so every agent-driven mutation is recorded,
 * replayable, and forkable — exactly as for a human user.
 */
export function createTools(spektrum: Spektrum, opts?: CreateToolsOptions): McpTool[];

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
   * set/add ops inside `attempt.start`) refuse to write. String
   * entries match the exact path or a dot-segment prefix; RegExp
   * entries are tested as-is. Denied writes return
   * `{ ok: false, error: 'protected: <path>' }` without calling the
   * engine. Reads, describe, explain, replay, etc. are unaffected.
   */
  protectedPaths?: PathPattern[];
  /**
   * Explicit acknowledgement that the agent may write anywhere.
   * Required to silence the safety warning when no `protectedPaths`
   * are supplied. Leaving both unset still grants full write access
   * (back-compat) but logs a one-time warning. Set this when
   * unrestricted writes are genuinely intended.
   */
  allowAllPaths?: boolean;
}

/**
 * Build the tool catalog for an instance. Each `handler` goes through
 * the public API, so every agent-driven mutation is recorded,
 * replayable, and forkable — exactly as for a human user.
 */
export function createTools(spektrum: Spektrum, opts?: CreateToolsOptions): McpTool[];

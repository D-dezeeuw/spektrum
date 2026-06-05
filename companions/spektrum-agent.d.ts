/**
 * Type declarations for `spektrum/agent` — the in-page agent panel.
 * Mounts a chat surface wired to an LLM provider whose tool layer is
 * the `spektrum/mcp` catalog, so the model reads and drives the live
 * instance through the public, time-travel-recorded API.
 *
 * Source of truth: `companions/spektrum-agent.js`. When the runtime
 * shape changes, update this file in the same commit.
 *
 * Security: the agent is **read-only by default**. Pass
 * `protectedPaths` to allow writes except to sensitive paths, or
 * `allowAllPaths: true` to allow every write.
 */

import type { Spektrum } from '../spektrum.js';
import type { PathPattern } from './spektrum-mcp.js';

/** Corner the agent panel docks to (when not hosted in a dock). */
export type AgentPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Supported LLM providers. The user can switch in the panel. */
export type AgentProvider = 'anthropic' | 'openai' | 'openrouter';

/** Options for {@link mount}. */
export interface AgentOptions {
  /** Default provider; user can switch in the panel. */
  provider?: AgentProvider;
  /** API key for the chosen provider. If omitted, the panel prompts
   *  and stores it in `localStorage`. */
  apiKey?: string;
  /** Model id; the provider default applies if omitted. */
  model?: string;
  /** Corner for the panel. Defaults to `'bottom-left'`. Ignored when
   *  a dock owns layout. */
  position?: AgentPosition;
  /** Mount target. Defaults to `document.body`. */
  parent?: Element;
  /** Panel title. Defaults to `'spektrum agent'`. */
  title?: string;
  /** Override the system prompt entirely. */
  system?: string;
  /**
   * Paths the agent may not write ("allow all but these"). Forwarded
   * to the internal `createTools()` call; denied writes return an error
   * to the model, and a sentence enumerating the protected paths is
   * appended to the system prompt so the model doesn't waste tool calls
   * attempting them. Takes precedence over `allowAllPaths`.
   */
  protectedPaths?: PathPattern[];
  /**
   * Opt into unrestricted writes. The agent is **read-only by default**
   * (state-writing tools are rejected and the system prompt says so);
   * pass `protectedPaths` to allow all but specific paths, or
   * `allowAllPaths: true` to allow every write. Forwarded to
   * `createTools()`.
   */
  allowAllPaths?: boolean;
}

/**
 * Mount the agent panel for an instance. Returns an `unmount()` that
 * removes the panel and detaches from the dock if it was hosted there.
 */
export function mount(spektrum: Spektrum, opts?: AgentOptions): () => void;

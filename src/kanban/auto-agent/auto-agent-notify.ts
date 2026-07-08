// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Auto-agent notification helpers.
 *
 * Notify the auto-agent state machine when the agent is blocked
 * waiting for user input or when user provides input.
 */

import type { AutoAgentCallback } from "./auto-agent-state-machine.js";

/** Module-level ref to getAutoAgentCallback, set during initialization */
let _getAutoAgentCallback: (() => AutoAgentCallback | null) | null = null;

/** Set the getAutoAgentCallback implementation (called by orchestrator) */
export function setAutoAgentCallbackGetter(getter: () => AutoAgentCallback | null): void {
  _getAutoAgentCallback = getter;
}

/** Notify auto-agent that the agent is blocked waiting for user input */
export function notifyAutoAgentBlocked(slug: string): void {
  try {
    const autoAgentCb = _getAutoAgentCallback?.();
    if (autoAgentCb?.onBlock) {
      autoAgentCb.onBlock(slug);
    }
  } catch {
    // Auto-agent notification must not disrupt workflow
  }
}

/** Notify auto-agent that user provided input and agent can continue */
export function notifyAutoAgentUnblocked(slug: string): void {
  try {
    const autoAgentCb = _getAutoAgentCallback?.();
    if (autoAgentCb?.onUnblock) {
      autoAgentCb.onUnblock(slug);
    }
  } catch {
    // Auto-agent notification must not disrupt workflow
  }
}

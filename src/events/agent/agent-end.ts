// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * agent_end event router — delegate to the agent-lifecycle domain method.
 *
 * Clears the finish guardrail, resets the phase_ready guard, flags the agent
 * finished (for compaction), and notifies the auto-agent on non-retryable
 * execution-phase errors. The logic lives in the AgentLifecycle domain object.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IAgentLifecycle } from "../../shared/workflow-types.js";

export function registerAgentEnd(pi: ExtensionAPI, lifecycle: IAgentLifecycle): void {
  pi.on("agent_end", async (event, ctx) => {
    await lifecycle.onAgentEnd(event, ctx);
  });
}

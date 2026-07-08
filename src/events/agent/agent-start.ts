// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * agent_start event router — delegate to the agent-lifecycle domain method.
 *
 * Re-arms the finish-phase guardrail and signals a fresh agent turn to the
 * compaction module. The logic lives in the AgentLifecycle domain object.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IAgentLifecycle } from "../../shared/workflow-types.js";

export function registerAgentStart(pi: ExtensionAPI, lifecycle: IAgentLifecycle): void {
  pi.on("agent_start", async () => {
    await lifecycle.onAgentStart();
  });
}

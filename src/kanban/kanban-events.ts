// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Register the kanban tool_result heartbeat handler.
 *
 * turn_start, turn_end, and model_select were extracted to events/ (events/agent/
 * and events/session/); this module retains only the tool_result heartbeat refresh
 * (a subagent stream counts as agent activity). Registered from the kanban
 * extension setup as a domain co-handler alongside the events/ tool_result router.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
import type { KanbanContext } from "./kanban-context.js";

export function registerKanbanEvents(pi: ExtensionAPI, ctx: KanbanContext): void {
  // Refresh heartbeat on tool_result events (subagent streams count as heartbeat)
  pi.on("tool_result", async (_event, _extensionCtx) => {
    const sm = globalThis.__piKanban?.autoAgent;
    if (sm && sm.getState() === "working") {
      const featureId = sm.getCurrentFeatureId();
      if (featureId !== null) {
        try {
          const tools = await ctx.getTools();
          tools.kanbanHeartbeat(featureId, sm.sessionId);
        } catch (err) {
          log.warn(`[kanban] tool_result heartbeat failed for featureId=${featureId}, session=${sm.sessionId}: ${err}`);
          // Best-effort — heartbeat refresh failure shouldn't disrupt workflow
        }
      }
    }
  });
}

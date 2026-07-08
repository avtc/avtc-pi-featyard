// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Utility functions for auto-agent cleanup.
 */

import { log } from "../../log.js";
import type { GracePeriodManager } from "./auto-agent-grace-period.js";

/**
 * Remove the stopped/error agent, clean up its timers,
 * and remove the terminal input listener if no agent remains.
 * Called with no arguments — reads from globalThis.__piKanban.autoAgent.
 */
export function cleanupStoppedAgents(): void {
  const sm = globalThis.__piKanban?.autoAgent;
  if (!sm) return;
  if (sm.getState() === "stopped" || sm.getState() === "error") {
    sm.stopHeartbeat();
    sm.stopPollingTimer();
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = null;
    log.info(`[kanban] cleaned up ${sm.getRole()} agent (state: ${sm.getState()})`);
    // If this agent was in grace-period, stop the GPM immediately
    const gpm = globalThis.__piKanban?.gracePeriod as GracePeriodManager | undefined;
    if (gpm?.isActive()) gpm.stop();
  }
  // Clean up terminal input listener if no agent is running
  const currentAgent = globalThis.__piKanban?.autoAgent;
  if (!currentAgent || ["stopped", "error"].includes(currentAgent.getState())) {
    const unsub = globalThis.__piKanban?.terminalInputUnsubscribe as (() => void) | undefined;
    if (unsub) {
      unsub();
      if (globalThis.__piKanban) globalThis.__piKanban.terminalInputUnsubscribe = null;
    }
  }
}

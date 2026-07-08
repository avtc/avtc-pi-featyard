// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Kanban turn-handler domain module — the turn_start and turn_end handler
 * bodies as callable methods (no pi.on registration).
 *
 * turn_start pauses the grace-period timer and unblocks a "waiting" auto-agent
 * (a new agent turn means the session is active again). turn_end captures the
 * active model (for kanban title/topic generation) and resumes the grace-period
 * timer. The events/agent/ routers own the pi.on registration and call these.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
import { _kanbanModelRef } from "./kanban-bridge.js";
import { captureModel } from "./model-capture.js";

export interface KanbanTurnHandlers {
  /** turn_start handler body: pause grace timer + unblock waiting auto-agent. */
  onTurnStart(): void;
  /** turn_end handler body: capture model + resume grace timer. */
  onTurnEnd(ctx: ExtensionContext): void;
}

/**
 * Construct the kanban turn-handler domain object. `requestWidgetUpdate` refreshes
 * the widget after unblocking an auto-agent. Uses the shared `_kanbanModelRef`
 * singleton (same one the model_select event writes to).
 */
export function createKanbanTurnHandlers(requestWidgetUpdate: () => void): KanbanTurnHandlers {
  function onTurnStart(): void {
    const gpm = globalThis.__piKanban?.gracePeriod;
    gpm?.pause();
    // Unblock any auto-agent in "waiting" state — a new agent turn means
    // the session is active again (user sent a message or follow-up fired).
    const sm = globalThis.__piKanban?.autoAgent;
    if (sm && sm.getState() === "waiting") {
      log.info(`[kanban] turn_start: unblocking auto-${sm.getRole()} agent (was ${sm.getState()})`);
      sm.unblock();
      requestWidgetUpdate();
    }
  }

  function onTurnEnd(ctx: ExtensionContext): void {
    // Capture model + resume grace timer (two concerns coordinated in one handler).
    captureModel(_kanbanModelRef, ctx);
    const gpm = globalThis.__piKanban?.gracePeriod;
    gpm?.resume();
    // Also reset timer on user activity (agent turn ended = user is active)
    gpm?.onUserActivity();
  }

  return { onTurnStart, onTurnEnd };
}

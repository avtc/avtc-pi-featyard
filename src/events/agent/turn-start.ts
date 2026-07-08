// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * turn_start event router — delegate to the kanban turn-handler domain method.
 *
 * Pauses the grace-period timer and unblocks a "waiting" auto-agent (a new agent
 * turn means the session is active again). The logic lives in the
 * KanbanTurnHandlers domain object (kanban/).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KanbanTurnHandlers } from "../../kanban/kanban-turn-handlers.js";

export function registerTurnStart(pi: ExtensionAPI, handlers: KanbanTurnHandlers): void {
  pi.on("turn_start", () => {
    handlers.onTurnStart();
  });
}

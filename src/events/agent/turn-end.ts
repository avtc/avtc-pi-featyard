// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * turn_end event router — delegate to the kanban turn-handler domain method.
 *
 * Captures the active model (for kanban title/topic generation) and resumes the
 * grace-period timer. The logic lives in the KanbanTurnHandlers domain object
 * (kanban/). This coordinates the two turn_end concerns (model capture + grace
 * resume) that were previously separate pi.on handlers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KanbanTurnHandlers } from "../../kanban/kanban-turn-handlers.js";

export function registerTurnEnd(pi: ExtensionAPI, handlers: KanbanTurnHandlers): void {
  pi.on("turn_end", (_event, ctx) => {
    handlers.onTurnEnd(ctx);
  });
}

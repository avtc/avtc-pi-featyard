// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Helper to move a kanban feature to a lane with null-safe database access.
 *
 * Every call site follows the same pattern:
 *   const { getDatabaseInstance } = await import("./kanban/index.js");
 *   const kanbanDb = getDatabaseInstance();
 *   if (kanbanDb) { kanbanDb.moveFeature({...}); }
 *
 * This helper collapses that boilerplate into a single call.
 */

import { log } from "../../log.js";
import { getDatabaseInstance } from "../kanban-bridge.js";
import type { Lane } from "./kanban-types.js";

interface MoveFeatureOptions {
  featureId: number;
  toLane: Lane;
  changedBy?: string;
  note?: string;
  fromLane: Lane | undefined;
}

/**
 * Move a kanban feature to the specified lane.
 * No-ops if the database is not initialized or featureId is null/undefined.
 */
export async function moveFeatureToLane(opts: MoveFeatureOptions): Promise<void> {
  const kanbanDb = getDatabaseInstance();
  if (!kanbanDb) return;

  kanbanDb.moveFeature({
    featureId: opts.featureId,
    toLane: opts.toLane,
    changedBy: opts.changedBy ?? "system",
    note: opts.note ?? "",
    fromLane: opts.fromLane,
  });
  log.info(`kanban: moved feature ${opts.featureId} to ${opts.toLane} lane`);
}

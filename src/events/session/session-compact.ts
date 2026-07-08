// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * session_compact event router — deliver the stored compaction follow-up (new-phase
 * skill / task confirmation / todo details) after the context is compacted, or
 * delegate to the subagent-compact path. Clears any pending deferred follow-up first
 * (a newer compaction supersedes a prior one).
 *
 * Body lives in the compaction domain object (ICompaction.onSessionCompact).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ICompaction } from "../../shared/workflow-types.js";

export function registerSessionCompact(pi: ExtensionAPI, compaction: ICompaction): void {
  pi.on("session_compact", async (event) => {
    await compaction.onSessionCompact(event);
  });
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * session_shutdown event router — clear session-scoped state on teardown.
 *
 * Coordinates two shutdown concerns: clear any pending deferred compaction
 * follow-up (compaction domain object, so a deferred inject never fires into a
 * dead session) and stop the feature-flow artifact archive timer (best-effort).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ICompaction } from "../../shared/workflow-types.js";

export function registerSessionShutdown(pi: ExtensionAPI, compaction: ICompaction): void {
  pi.on("session_shutdown", () => {
    compaction.onSessionShutdown();
    const bridge = globalThis.__piWorkflowMonitor;
    if (bridge?.archiveTimer) {
      clearInterval(bridge.archiveTimer);
      bridge.archiveTimer = undefined;
    }
  });
}

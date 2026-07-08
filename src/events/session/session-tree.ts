// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * session_tree event router — restore workflow state from the session branch
 * (resume/fork entry), clearing if no state entry is found, via the session-lifecycle
 * domain object (ISessionLifecycle.onSessionTree).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ISessionLifecycle } from "../../shared/workflow-types.js";

export function registerSessionTree(pi: ExtensionAPI, lifecycle: ISessionLifecycle): void {
  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    await lifecycle.onSessionTree(ctx);
  });
}

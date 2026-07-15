// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * session_start event router — coordinates the kanban + state branches of the
 * session_start reaction (both fire on every session_start; kanban branch first,
 * then state branch).
 *
 * Kanban branch: refresh the stashed command context, capture the active model,
 * and pause an orphaned auto-agent if an external session replacement (manual
 * /new, /resume, /fork, /reload) left it pinned to a dead runner.
 *
 * State branch: bind/resume/reset the active feature per the session reason
 * (reload/startup/resume/fork/new + PI_FY_FEATURE binding), via the session-lifecycle
 * domain object (ISessionLifecycle.onSessionStart).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pauseOrphanedAutoAgent } from "../../kanban/auto-agent/auto-agent-pause.js";
import { _kanbanModelRef } from "../../kanban/kanban-bridge.js";
import { captureModel } from "../../kanban/model-capture.js";
import type { ISessionLifecycle } from "../../shared/workflow-types.js";

export function registerSessionStart(pi: ExtensionAPI, lifecycle: ISessionLifecycle): void {
  pi.on("session_start", async (event, extensionCtx: ExtensionContext) => {
    // --- kanban branch ---
    globalThis.__piCtx?.refresh(extensionCtx as unknown as ExtensionCommandContext);
    captureModel(_kanbanModelRef, extensionCtx);

    // Detect external (non-auto-agent) session replacement that orphans the agent.
    // new/resume/fork/reload each dispose the prior runner; startup is the initial load
    // (the agent is never running then). autoAgentInitiatingReplacement marks the
    // agent's own newSession/switchSession calls so they aren't mistaken for external.
    const reason = ((event as unknown as Record<string, unknown>).reason as string | undefined) ?? "startup";
    const isExternalReplacement =
      (reason === "new" || reason === "resume" || reason === "fork" || reason === "reload") &&
      globalThis.__piKanban?.autoAgentInitiatingReplacement !== true;
    if (isExternalReplacement) {
      pauseOrphanedAutoAgent(() => globalThis.__piWorkflowMonitor?.requestWidgetUpdate?.());
    }

    // --- state branch ---
    await lifecycle.onSessionStart(event, extensionCtx);
  });
}

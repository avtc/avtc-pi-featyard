// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyModelOverrideForPhase } from "../shared/workflow-refs.js";
import type { IGuardrails } from "../shared/workflow-types.js";
import type { FeatureSession } from "../state/feature-session.js";
import { persistState } from "../state/state-persistence.js";
import { NO_FEATURE_STATE, updateWidget } from "../ui/feature-flow-widget.js";
import type { RouteConfig } from "./workflow-router.js";

/**
 * Run the implement→verify transition side-effects (phase advance, mark verify
 * tests not-yet-passed, apply the verify model override, persist, refresh the widget).
 *
 * Called by `task_ready_advance`'s last-task branch. Does NOT reset
 * `implement.currentTask` or dispatch the verify skill — those are the caller's concern.
 */
export async function advanceImplementToVerify(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  handler: FeatureSession,
  guardrails: IGuardrails,
  routeConfig: RouteConfig,
): Promise<void> {
  handler.completeCurrentWorkflowPhase(routeConfig); // implement → verify
  guardrails.setVerifyTestsPassed(false);
  await applyModelOverrideForPhase(pi, ctx, "verify");
  persistState(pi, handler);
  updateWidget(handler, NO_FEATURE_STATE);
}

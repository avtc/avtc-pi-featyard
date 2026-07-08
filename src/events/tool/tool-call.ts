// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * tool_call event router — dispatch each tool to its focused domain method,
 * then own the shared coordination glue (persist + widget refresh).
 *
 * Per-tool gating logic lives in the guardrails domain object (onBashCall,
 * onWriteEditCall, onPhaseReadyCall, onTaskReadyAdvanceCall), each returning a
 * ToolCallDecision ({ block?, changed? }). The router owns the toolName
 * dispatch, applies the block decision, and persists + refreshes the widget
 * when state changed.
 *
 * Note: worktree path-rewriting for write/edit paths is handled by a separate
 * pi.on("tool_call") handler in worktrees/worktree-interception.ts (worktree-
 * domain guardrail), which runs alongside this one.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IGuardrails, ToolCallDecision } from "../../shared/workflow-types.js";
import type { FeatureSession } from "../../state/feature-session.js";
import { persistState } from "../../state/state-persistence.js";
import { NO_FEATURE_STATE, updateWidget } from "../../ui/feature-flow-widget.js";

const ALLOW: ToolCallDecision = {};

export function registerToolCall(pi: ExtensionAPI, guardrails: IGuardrails, handler: FeatureSession): void {
  pi.on("tool_call", async (event, ctx) => {
    let decision: ToolCallDecision = ALLOW;

    switch (event.toolName) {
      case "bash":
        decision = await guardrails.onBashCall(event, ctx);
        break;
      case "write":
      case "edit":
        decision = await guardrails.onWriteEditCall(event, ctx);
        break;
      case "phase_ready":
        decision = guardrails.onPhaseReadyCall(event);
        break;
      case "task_ready_advance":
        decision = guardrails.onTaskReadyAdvanceCall(event);
        break;
    }

    if (decision.block) {
      return { block: true, reason: decision.block };
    }

    if (decision.changed) {
      persistState(pi, handler);
      updateWidget(handler, NO_FEATURE_STATE);
    }

    return undefined;
  });
}

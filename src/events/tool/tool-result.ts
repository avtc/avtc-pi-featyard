// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * tool_result event router — dispatch each tool to its focused domain method,
 * then own the shared coordination glue (persist + widget refresh + warning
 * injection).
 *
 * Per-tool logic lives in the guardrails domain object (onReadResult,
 * onWriteEditResult, onBashResult), each returning a ToolResultAdvisory
 * ({ warnings, changed? }). The router owns the toolName dispatch, persists +
 * refreshes the widget when state changed, and assembles the content
 * (prepending pending warnings to the tool output).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IGuardrails, ToolResultAdvisory } from "../../shared/workflow-types.js";
import type { FeatureSession } from "../../state/feature-session.js";
import { persistState } from "../../state/state-persistence.js";
import { NO_FEATURE_STATE, updateWidget } from "../../ui/feature-flow-widget.js";

const EMPTY_ADVISORY: ToolResultAdvisory = { warnings: [] };

export function registerToolResult(pi: ExtensionAPI, guardrails: IGuardrails, handler: FeatureSession): void {
  pi.on("tool_result", async (event) => {
    let advisory: ToolResultAdvisory = EMPTY_ADVISORY;

    switch (event.toolName) {
      case "read":
        advisory = guardrails.onReadResult(event);
        break;
      case "write":
      case "edit":
        advisory = guardrails.onWriteEditResult(event.toolCallId);
        break;
      case "bash":
        advisory = guardrails.onBashResult(event, event.toolCallId);
        break;
    }

    if (advisory.changed) {
      persistState(pi, handler);
    }

    updateWidget(handler, NO_FEATURE_STATE);

    if (advisory.warnings.length > 0) {
      return {
        content: [{ type: "text", text: advisory.warnings.join("\n\n") }, ...event.content],
      };
    }
    return undefined;
  });
}

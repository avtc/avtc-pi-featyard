// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../../src/index.js";
import { setAutoAgentCallback } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import {
  createFakePi,
  enableSubagentMode,
  fireAllHandlers,
  NO_AUTO_AGENT_CALLBACK,
  writeFeatureStateFile,
} from "../../helpers/workflow-monitor-test-helpers.js";

const mockCtx = {
  hasUI: true,
  sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
  ui: { setWidget: () => {}, notify: vi.fn() },
};

describe("onBlock/onUnblock auto-agent notification", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  test("execution mode dialog notifies auto-agent blocked/unblocked", async () => {
    const fake = createFakePi();
    const slug = writeFeatureStateFile("2026-05-17-block-test", {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {
          design: "docs/featyard/designs/test-design.md",
          plan: "docs/plans/test-impl.md",
          implement: null,
          verify: null,
          review: null,
          uat: null,
          finish: null,
        },
      },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Reconstruct handler state
    enableSubagentMode();
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    // Set up auto-agent callback mock
    const onBlock = vi.fn();
    const onUnblock = vi.fn();
    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      onBlock,
      onUnblock,
      isActive: () => true,
    });

    // Find the auto-agent block/unblock by triggering the execute phase via fy:resume
    const selectMock = vi.fn().mockResolvedValue("Subagent-driven (Recommended)");
    const ctxWithSelect = {
      ...mockCtx,
      ui: { ...mockCtx.ui, select: selectMock },
    } as unknown as ExtensionContext;

    // Trigger execution mode dialog via fy:resume command
    const continueHandler = fake.registeredCommands?.get("fy:resume");
    if (continueHandler) {
      await (continueHandler as (args: string, ctx: ExtensionContext) => Promise<void>)("", ctxWithSelect);
    }

    // Verify onBlock was called before the select, onUnblock after
    expect(onBlock).toHaveBeenCalledWith(slug);
    expect(onUnblock).toHaveBeenCalledWith(slug);

    // Clean up
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
  });
});

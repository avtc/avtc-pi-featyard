// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../../src/index.js";
import { setAutoAgentCallback } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import {
  createFakePi,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  NO_AUTO_AGENT_CALLBACK,
  writeFeatureStateFile,
} from "../../helpers/workflow-monitor-test-helpers.js";

describe("auto-designer completion via phase_ready only", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(() => {
    _resetFeatureState();
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
  });

  test("agent_end does NOT trigger onFeatureComplete even when design artifact exists and auto-agent is active", async () => {
    // Design completion is handled exclusively by the phase_ready tool's design handler.
    // agent_end must NOT call onFeatureComplete based on artifact existence alone.
    const fake = createFakePi();
    writeFeatureStateFile("2026-05-17-design-complete-test", {
      workflow: {
        phases: {
          design: "done",
          plan: "pending",
          implement: "pending",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "design",
        artifacts: {
          design: "docs/featyard/designs/test-design.md",
          plan: null,
          implement: null,
          verify: null,
          review: null,
          uat: null,
          finish: null,
        },
      },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      {
        hasUI: false,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
        ui: { setWidget: () => {} },
      },
    );

    const onFeatureComplete = vi.fn();
    setAutoAgentCallback({
      onFeatureComplete,
      onFeatureError: async () => {},
      isActive: () => true,
    });

    const mockCtxUI = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;

    // Trigger agent_end
    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd(
      {
        messages: [{ role: "assistant", stopReason: "end_turn" } as unknown as AgentMessage],
      } as unknown as ExtensionEvent,
      mockCtxUI,
    );

    // agent_end must NOT trigger design completion — that's phase_ready's job
    expect(onFeatureComplete).not.toHaveBeenCalled();
  });

  test("agent_end does NOT trigger onFeatureComplete for designing when auto-agent is inactive", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("2026-05-17-no-auto-agent-test", {
      workflow: {
        phases: {
          design: "done",
          plan: "pending",
          implement: "pending",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "design",
        artifacts: {
          design: "docs/featyard/designs/test-design.md",
          plan: null,
          implement: null,
          verify: null,
          review: null,
          uat: null,
          finish: null,
        },
      },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      {
        hasUI: false,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
        ui: { setWidget: () => {} },
      },
    );

    const onFeatureComplete = vi.fn();
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);

    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd(
      {
        messages: [{ role: "assistant", stopReason: "end_turn" } as unknown as AgentMessage],
      } as unknown as ExtensionEvent,
      {
        hasUI: true,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(onFeatureComplete).not.toHaveBeenCalled();
  });
});

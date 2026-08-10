// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Regression tests for pi #7370 (v0.84.0): ctx.compact() aborts the in-flight run up front,
 * and that abort emits agent_end with stopReason "error" + "This operation was aborted"
 * (AbortController default). onAgentEnd must NOT classify this operational abort as a task
 * execution error — doing so would call onFeatureError → handleFeatureTransientError →
 * auto-agent state "waiting", blocking the agent on every todo/extension-triggered compaction
 * in implement/verify/review phases.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../../src/index.js";
import { setAutoAgentCallback } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import {
  createFakePi,
  fireAllHandlers,
  getSingleHandler,
  NO_AUTO_AGENT_CALLBACK,
  writeFeatureStateFile,
} from "../../helpers/workflow-monitor-test-helpers.js";

const UI_CTX = {
  hasUI: false,
  sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
} as unknown as ExtensionContext;

function writeImplementState(slug: string): string {
  return writeFeatureStateFile(slug, {
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
}

describe("agent_end compact-abort is not a feature error (pi #7370)", () => {
  afterEach(() => {
    _resetFeatureState();
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
    delete process.env.PI_FY_FEATURE;
  });

  test('compact abort ("This operation was aborted") does NOT notify onFeatureError', async () => {
    const fake = createFakePi();
    const slug = writeImplementState("2026-08-10-compact-abort-no-error");
    process.env.PI_FY_FEATURE = slug;
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, UI_CTX);

    const onFeatureError = vi.fn();
    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError,
      onBlock: async () => {},
      onUnblock: async () => {},
      onFeatureUatHandoff: async () => {},
      isActive: () => true,
    });

    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd(
      {
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" }],
      } as unknown as ExtensionEvent,
      UI_CTX,
    );

    // The compact abort must not be treated as a task execution error.
    expect(onFeatureError).not.toHaveBeenCalled();
    expect(slug).toBeDefined();
  });

  test("a real provider error STILL notifies onFeatureError", async () => {
    const fake = createFakePi();
    const slug = writeImplementState("2026-08-10-real-error-notifies");
    process.env.PI_FY_FEATURE = slug;
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, UI_CTX);

    const onFeatureError = vi.fn();
    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError,
      onBlock: async () => {},
      onUnblock: async () => {},
      onFeatureUatHandoff: async () => {},
      isActive: () => true,
    });

    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd(
      {
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "Invalid API key (401 Unauthorized)" }],
      } as unknown as ExtensionEvent,
      UI_CTX,
    );

    // A genuine (non-retryable, non-abort) error still surfaces to the auto-agent.
    expect(onFeatureError).toHaveBeenCalledTimes(1);
  });
});

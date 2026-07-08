// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  SessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  createPiWithToolCapture,
  fireAllHandlers,
  getSingleHandler,
  getToolHandlers,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Tests for automatic phase transitions:
 * - implement → verify (when the implementer calls phase_ready with all todos done)
 * - verify → review (when tests pass during verify phase)
 * - agent_end does not trigger boundary dialogs (removed)
 *
 * These transitions should happen automatically without human dialog prompts.
 * The extension sends a followUp message with the next skill via pi.sendUserMessage.
 */

/** No UI available (headless mode) */
const NO_UI = false;

/** No session entries */
const NO_BRANCH: SessionEntry[] | null = null;

function createCtx(hasUI: boolean, branch: SessionEntry[] | null): unknown {
  return {
    hasUI,
    sessionManager: {
      getBranch: () => branch ?? [],
    },
    ui: {
      setWidget: () => {},
      select: vi.fn().mockResolvedValue("Do verify now"),
      confirm: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
      setEditorText: () => {},
    },
  };
}
describe("auto phase transition execute → verify → review", () => {
  beforeEach(async () => {
    _resetFeatureState();
  });

  test("completing all tasks then task_ready_advance advances implement→verify and sends followUp", async () => {
    const slug = "2026-05-11-auto-trans";
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {
          design: "docs/ff/designs/2026-05-11-auto-trans-design.md",
          plan: ".ff/task-plans/2026-05-11-auto-trans-task-plan.md",
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      implement: { taskReviewRounds: { "1-final-task": 1 }, currentTask: "1. Final task" },
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      createCtx(NO_UI, NO_BRANCH),
    );

    // Last task: call task_ready_advance with nextTask omitted → advances to verify.
    // (phase_ready is blocked in implement by the guardrails interceptor.)
    const taskReadyAdvance = registeredTools.find((t) => (t as { name: string }).name === "task_ready_advance");
    const result = await (
      taskReadyAdvance as {
        execute: (
          id: string,
          params: object,
          signal: AbortSignal | undefined,
          onUpdate: unknown,
          ctx: ExtensionContext,
        ) => Promise<{ content: Array<{ text: string }> }>;
      }
    ).execute("tc-tra1", {}, undefined, undefined, {
      hasUI: false,
      ui: { setWidget: () => {}, select: vi.fn(), confirm: vi.fn(), input: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext);

    expect((result.content[0] as { text: string }).text).toMatch(/advancing to the next phase/i);
    // Should send exactly one followUp message with the verification skill
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toMatch(/^<skill name="ff-verify"/);
    expect(fake.sentMessages[0].options).toEqual({ deliverAs: "followUp" });

    // Current phase should now be verify
    const state = loadFeatureState(slug, null);
    expect(state?.workflow.currentPhase).toBe("verify");
  });

  test("passing tests in verify phase do not auto-advance (transition via phase_ready)", async () => {
    const slug = "2026-05-11-auto-trans-verify";
    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "in-progress",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "verify",
        artifacts: {
          design: "docs/ff/designs/2026-05-11-auto-trans-verify-design.md",
          plan: ".ff/task-plans/2026-05-11-auto-trans-verify-task-plan.md",
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const { onToolCall, onToolResult } = getToolHandlers(fake);
    const ctx = createCtx(NO_UI, NO_BRANCH);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Simulate running tests that pass
    await onToolCall(
      { type: "tool_call", toolCallId: "tc-test1", toolName: "bash", input: { command: "npx vitest run" } },
      ctx as unknown as ExtensionContext,
    );

    await onToolResult(
      {
        toolCallId: "tc-test1",
        toolName: "bash",
        input: { command: "npx vitest run" },
        content: [{ type: "text", text: "\n ✓ test 1\n ✓ test 2\n Tests: 2 passed\n" }],
        details: { exitCode: 0 },
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );

    // Passing tests alone should NOT trigger transition
    expect(fake.sentMessages.length).toBe(0);

    // Trigger agent_end — should NOT transition either (auto-transition removed)
    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd({} as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);

    // Still no transition from agent_end
    expect(fake.sentMessages.length).toBe(0);

    // Now call phase_ready to trigger the transition
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-pr1", {}, undefined, undefined, {
      hasUI: false,
      ui: { setWidget: () => {}, select: vi.fn(), confirm: vi.fn(), input: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext);

    // phase_ready triggers the transition — sends review skill
    expect((result.content[0] as { text: string }).text).toBe("");
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toMatch(/^<skill name="ff-review"/);
    expect(fake.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  test("agent_end does not show dialog after auto-transition", async () => {
    const slug = "2026-05-11-auto-no-prompt";
    const fake = createFakePi();
    setTestSettings(null);
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {
          design: "docs/ff/designs/2026-05-11-auto-no-prompt-design.md",
          plan: ".ff/task-plans/2026-05-11-auto-no-prompt-task-plan.md",
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      taskTracker: {
        tasks: [
          { name: "Task 1", status: "complete" },
          { name: "Task 2", status: "in_progress" },
        ],
      },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    const { onToolCall, onToolResult } = getToolHandlers(fake);

    let selectCalled = false;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        confirm: vi.fn(),
        input: vi.fn(),
        select: async () => {
          selectCalled = true;
          return "";
        },
        setEditorText: () => {},
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Simulate task_tracker update: mark last task complete (triggers auto-transition to verify)
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "tc-pt1",
        toolName: "task_tracker",
        input: { action: "update", index: 1, status: "complete" },
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    await onToolResult(
      {
        toolCallId: "tc-pt1",
        toolName: "task_tracker",
        input: { action: "update", index: 1, status: "complete" },
        content: [{ type: "text", text: 'Task 1 "Task 2" → complete' }],
        details: {
          action: "update",
          tasks: [
            { name: "Task 1", status: "complete" },
            { name: "Task 2", status: "complete" },
          ],
        },
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );

    // Now agent_end fires — should NOT show any dialog (boundary dialogs removed)
    await onAgentEnd({} as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);

    expect(selectCalled).toBe(false);
  });

  test("verify→review with maxFeatureReviewRounds enabled dispatches ff-review skill via phase_ready", async () => {
    const slug = "2026-05-12-verify-to-review-enabled";
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("featureReviewMode", "general");
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "in-progress",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "verify",
        artifacts: {
          design: `docs/ff/designs/${slug}-design.md`,
          plan: `.ff/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const { onToolCall, onToolResult } = getToolHandlers(fake);
    const ctx = createCtx(NO_UI, NO_BRANCH);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Fire a passing test to set verifyTestsPassed flag
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "tc-test1",
        toolName: "bash",
        input: { command: "npx vitest run" },
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    await onToolResult(
      {
        toolCallId: "tc-test1",
        toolName: "bash",
        input: { command: "npx vitest run" },
        content: [{ type: "text", text: "\n ✓ test 1\n Tests: 1 passed\n" }],
        details: { exitCode: 0 },
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );

    // Call phase_ready to trigger the transition
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-verify-loops", {}, undefined, undefined, {
      hasUI: false,
      ui: { setWidget: () => {}, select: vi.fn(), confirm: vi.fn(), input: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext);

    // maxFeatureReviewRounds='3' → should dispatch ff-review
    expect((result.content[0] as { text: string }).text).toBe("");
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toContain('<skill name="ff-review"');
    expect(fake.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  // agent_end does not trigger the verify→review transition; phase_ready does.
  // See phase-ready-tool.test.ts for verify phase tests.
});

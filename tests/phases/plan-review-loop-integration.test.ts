// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { isPhaseDone, type Phase } from "../../src/phases/phase-progression.js";
import { getPhaseReadyRef } from "../../src/shared/workflow-refs.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  BRAINSTORM_ACTIVE_STATE,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  NO_UI_CTX,
  PLAN_ACTIVE_STATE,
  setupPiCtx,
  TUI_MODE,
  withTempCwd,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Full lifecycle integration tests for design/plan review loops.
 *
 * In the new interceptor-based flow:
 * 1. Agent calls phase_ready() without stage → interceptor sends iteration skill as followUp with context prefix
 * 2. Agent calls phase_ready(review_iteration, issuesFound=N) → loop gate decides to loop or complete
 * 3. If looping: followUp with context prefix (loop number, slug, report file, review method)
 * 4. If not looping: falls through to phase completion
 */
describe("design review loop — full lifecycle integration", () => {
  beforeEach(() => {
    setTestSettings(null);
    enableSubagentMode();
    // Reset the once-per-agent-turn phase_ready guard so each test starts clean.
    getPhaseReadyRef()?.resetTracking();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FF_FEATURE;
    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("full lifecycle: interceptor → phase_ready loop → phase_ready no-loop → completion", async () => {
    withTempCwd();
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("integration-test-feature", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: {
        currentPhase: "design",
        designDoc: "docs/ff/designs/integration-test-feature-design.md",
        planDoc: null,
      },
      design: { doc: "docs/ff/designs/integration-test-feature-design.md", reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/integration-test-feature-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // --- Iteration 0: Interceptor fires on phase_ready() without stage ---
    const selectFn1 = vi.fn().mockResolvedValue("Proceed with implementation");
    const uiCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn1 },
    } as unknown as ExtensionContext;
    setupPiCtx(uiCtx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    await phaseReady.execute("tc-phase-intercept", {} as unknown as ExtensionContext, undefined, undefined, uiCtx);

    // Verify interceptor set designReviewLoopCount=1
    const state0 = loadFeatureState("integration-test-feature", null);
    expect(state0?.design.reviewLoopCount).toBe(1);

    // Verify followUp sent with context prefix (first iteration, loop 0)
    const followUp0 = fake.sentMessages[fake.sentMessages.length - 1];
    expect(followUp0.message).toContain("ff-design-review");
    expect(followUp0.message).toContain("**Feature:** `integration-test-feature`");
    expect(followUp0.message).toContain("**Review loop:** `0`");
    expect(followUp0.message).toContain("Dispatch reviewer"); // review method substituted into {{PI_FF_REVIEW_METHOD}}
    expect((followUp0?.options as { deliverAs?: string } | undefined)?.deliverAs).toBe("followUp");

    // Simulate agent turn ending before the next review iteration
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);

    // --- Iteration 1: phase_ready(review_iteration, issuesFound=2) → loop ---
    const phaseResult1 = await phaseReady.execute("tc-phase-1", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    // Should return empty success (looping)
    expect((phaseResult1.content[0] as { text: string }).text).toBe("");

    // Verify state: designReviewLoopCount = 2
    const state1 = loadFeatureState("integration-test-feature", null);
    expect(state1?.design.reviewLoopCount).toBe(2);

    // Verify followUp sent with context prefix (loop 1)
    const followUp1 = fake.sentMessages[fake.sentMessages.length - 1];
    expect(followUp1.message).toContain("ff-design-review");
    expect(followUp1.message).toContain("**Review loop:** `1`");
    expect(followUp1.message).toContain("integration-test-feature");
    expect((followUp1?.options as { deliverAs?: string } | undefined)?.deliverAs).toBe("followUp");

    // Simulate agent turn ending before the next review iteration
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);

    // --- Iteration 2: phase_ready(review_iteration, issuesFound=0) → no loop, completion ---
    const selectFn2 = vi.fn().mockResolvedValue("Proceed with implementation");
    const uiCtx2 = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn2 },
    } as unknown as ExtensionContext;
    setupPiCtx(uiCtx2.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    await phaseReady.execute("tc-phase-2", { issuesFound: 0 }, undefined, undefined, uiCtx2);

    // Should have fallen through to design completion
    expect(selectFn2).toHaveBeenCalled();

    // Brainstorm completed, plan active
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1];
    expect(
      isPhaseDone(
        {
          currentPhase:
            (
              lastEntry as {
                data: {
                  sessionEntries: unknown[];
                  featureState: {
                    design?: { reviewLoopCount: number };
                    workflow?: { reviewLoopCount: number; currentPhase: Phase };
                  };
                };
              }
            ).data.featureState.workflow?.currentPhase ?? null,
          completedAt: null,
        },
        "design",
      ),
    ).toBe(true);
    expect(
      (
        lastEntry as {
          data: {
            sessionEntries: unknown[];
            featureState: {
              design?: { reviewLoopCount: number };
              workflow?: { reviewLoopCount: number; currentPhase: Phase };
            };
          };
        }
      ).data.featureState.workflow?.currentPhase ?? null,
    ).toBe("plan");

    // Writing-plans skill dispatched
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("ff-plan");
  });

  test("full lifecycle: plan review loop — interceptor → phase_ready loop → phase_ready no-loop", async () => {
    withTempCwd();
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("plan-integration-feature", PLAN_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // --- Iteration 0: Plan interceptor fires on phase_ready() without stage ---
    await phaseReady.execute("tc-plan-intercept", {}, undefined, undefined, NO_UI_CTX);

    // Verify interceptor set planReviewLoopCount=1
    const state0 = loadFeatureState("plan-integration-feature", null);
    expect(state0?.plan.reviewLoopCount).toBe(1);

    // Verify followUp sent with context prefix
    const followUp0 = fake.sentMessages[fake.sentMessages.length - 1];
    expect(followUp0.message).toContain("ff-plan-review");
    expect(followUp0.message).toContain("**Feature:** `plan-integration-feature`");
    expect(followUp0.message).toContain("**Review loop:** `0`");
    expect((followUp0?.options as { deliverAs?: string } | undefined)?.deliverAs).toBe("followUp");

    // Simulate agent turn ending before the next review iteration
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);

    // --- Iteration 1: phase_ready(review_iteration, issuesFound=1) → loop ---
    const phaseResult1 = await phaseReady.execute(
      "tc-plan-phase-1",
      { issuesFound: 1 },
      undefined,
      undefined,
      NO_UI_CTX,
    );

    expect((phaseResult1.content[0] as { text: string }).text).toBe("");

    const state1 = loadFeatureState("plan-integration-feature", null);
    expect(state1?.plan.reviewLoopCount).toBe(2);

    const followUp1 = fake.sentMessages[fake.sentMessages.length - 1];
    expect(followUp1.message).toContain("plan review iteration");
    expect(followUp1.message).toContain("**Review loop:** `1`");

    // Simulate agent turn ending before the next review iteration
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);

    // --- Iteration 2: phase_ready(review_iteration, issuesFound=0) → no loop ---
    const phaseResult2 = await phaseReady.execute(
      "tc-plan-phase-2",
      { issuesFound: 0 },
      undefined,
      undefined,
      NO_UI_CTX,
    );

    // Plan phase no-loop returns no-op (empty success)
    expect((phaseResult2.content[0] as { text: string }).text).toBe("");
  });

  test("full lifecycle: minReviewLoops forces extra loop even with issuesFound=0", async () => {
    withTempCwd();
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 2);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("min-loop-feature", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: "docs/ff/designs/min-loop-feature-design.md", planDoc: null },
      design: { doc: "docs/ff/designs/min-loop-feature-design.md", reviewActive: false, reviewLoopCount: 1 },
    });

    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/min-loop-feature-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Iteration 1: loopCount=0, issuesFound=0, min=2 not met → should loop
    const result1 = await phaseReady.execute("tc-min-1", { issuesFound: 0 }, undefined, undefined, NO_UI_CTX);

    expect((result1.content[0] as { text: string }).text).toBe("");
    expect(loadFeatureState("min-loop-feature", null)?.design.reviewLoopCount).toBe(2);

    // Simulate agent turn ending before the next review iteration
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);

    // Iteration 2: loopCount=1, issuesFound=0, min=2 now met (loopsCompleted=2 >= 2) → should NOT loop
    // falls through to design completion
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const uiCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;
    setupPiCtx(uiCtx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const _result2 = await phaseReady.execute("tc-min-2", { issuesFound: 0 }, undefined, undefined, uiCtx);

    // Should fall through to design completion
    expect(selectFn).toHaveBeenCalled();
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1];
    expect(
      isPhaseDone(
        {
          currentPhase:
            (
              lastEntry as {
                data: {
                  sessionEntries: unknown[];
                  featureState: {
                    design?: { reviewLoopCount: number };
                    workflow?: { reviewLoopCount: number; currentPhase: Phase };
                  };
                };
              }
            ).data.featureState.workflow?.currentPhase ?? null,
          completedAt: null,
        },
        "design",
      ),
    ).toBe(true);
    expect(
      (
        lastEntry as {
          data: {
            sessionEntries: unknown[];
            featureState: {
              design?: { reviewLoopCount: number };
              workflow?: { reviewLoopCount: number; currentPhase: Phase };
            };
          };
        }
      ).data.featureState.workflow?.currentPhase ?? null,
    ).toBe("plan");
  });

  test("full lifecycle: maxPlanReviewRounds=off — no review skill, falls through to completion", async () => {
    withTempCwd();
    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("off-feature", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: "docs/ff/designs/off-feature-design.md", planDoc: null },
      design: { doc: "docs/ff/designs/off-feature-design.md", reviewActive: false, reviewLoopCount: 0 },
    });

    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/off-feature-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // phase_ready() without stage → design interceptor should NOT fire when maxPlanReviewRounds=off
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const uiCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;
    setupPiCtx(uiCtx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    await phaseReady.execute("tc-off-phase", {}, undefined, undefined, uiCtx);

    // Should fall through to design completion (no interceptor, no loop)
    expect(selectFn).toHaveBeenCalled();
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1];
    expect(
      (
        lastEntry as {
          data: {
            sessionEntries: unknown[];
            featureState: {
              design?: { reviewLoopCount: number };
              workflow?: { reviewLoopCount: number; currentPhase: Phase };
            };
          };
        }
      ).data.featureState.workflow?.currentPhase ?? null,
    ).toBe("plan");

    // No review skill followUp sent
    const reviewMessages = fake.sentMessages.filter(
      (m: unknown) =>
        (m as { message: string }).message.includes("ff-design-review") ||
        (m as { message: string }).message.includes("ff-plan-review"),
    );
    expect(reviewMessages).toHaveLength(0);
  });
});

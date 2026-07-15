// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _resetCompactGuard } from "../../src/compaction/compact-trigger.js";
import type { PiWorkflowMonitorBridge } from "../../src/shared/types.js";
import type { FeatureSession } from "../../src/state/feature-session.js";
import type { FeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  captureTaskReadyAdvanceTool,
  cleanupAfterTest,
  withTempCwd,
} from "../helpers/workflow-monitor-test-helpers.js";

/** Build a minimal ctx with a spyable compact. */
function makeCtx(compactImpl: () => void) {
  return {
    hasUI: false,
    ui: { setWidget: vi.fn() },
    sessionManager: { getBranch: () => [] },
    compact: compactImpl,
  } as unknown as ExtensionContext;
}

/** Build a fresh feature-state the tool can mutate. */
function makeFeatureState(): FeatureState {
  return {
    featureSlug: "test-slug",
    workflow: { currentPhase: "implement", designDoc: null, planDoc: null },
    git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    completedAt: null,
    sessionFiles: [],
    featureId: null,
    design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
    plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
    implement: { taskReviewRounds: {}, currentTask: null },
    verify: { verifyLoopCount: 0 },
    review: { reviewLoopCount: 0, reviewHistory: [] },
  } as unknown as FeatureState;
}

/** Install a fake handler so the tool's implement-phase gate passes. */
function installActiveImplementHandler(): FeatureState {
  const featureState = makeFeatureState();
  globalThis.__piWorkflowMonitor = {
    ...(globalThis.__piWorkflowMonitor ?? {}),
    handler: {
      getWorkflowState: () => ({ currentPhase: "implement" }),
      getActiveFeatureState: () => featureState,
      getFullState: () => ({ featureState, guardrailsState: null }),
    } as unknown as FeatureSession,
    requestWidgetUpdate: () => {},
  } as unknown as PiWorkflowMonitorBridge;
  return featureState;
}

/** Remove the fake handler so tests start/finish from a clean globalThis. */
function clearActiveHandler(): void {
  delete globalThis.__piWorkflowMonitor;
}

describe("inter-task compact (task_ready_advance)", () => {
  beforeEach(() => {
    setTestSettings(null);
    setSetting("interTaskCompact", "none");
    // Disable per-task gates so every START/advance compacts cleanly (this suite is about
    // the compact timing of the inter-task transition, not the gate cycle — gate behavior
    // is covered by task-ready-advance-gate.test.ts).
    setSetting("verifyPhases", "off");
    setSetting("perTaskReviewMode", "off");
    _resetCompactGuard();
    delete globalThis.__piCompactFollowUp;
    withTempCwd(); // isolate .featyard state writes from the real repo
    installActiveImplementHandler();
  });

  afterEach(() => {
    cleanupAfterTest();
    _resetCompactGuard();
    delete globalThis.__piCompactFollowUp;
    clearActiveHandler();
  });

  test("interTaskCompact=none: START does NOT compact", async () => {
    setSetting("interTaskCompact", "none");
    const { getTool } = captureTaskReadyAdvanceTool();
    const compactCalls: unknown[] = [];
    const ctx = makeCtx(() => compactCalls.push(true));

    await getTool()?.execute("id1", { nextTask: "1. First task" }, undefined, undefined, ctx);
    expect(compactCalls.length).toBe(0);
  });

  test("interTaskCompact=compact: START compacts and stores a task-naming follow-up", async () => {
    setSetting("interTaskCompact", "compact");
    const { getTool } = captureTaskReadyAdvanceTool();
    const compactCalls: unknown[] = [];
    const ctx = makeCtx(() => {
      compactCalls.push(true);
      // Simulate session_compact consuming the stored payload + clearing the guard
      const stored = globalThis.__piCompactFollowUp;
      delete globalThis.__piCompactFollowUp;
      stored?.onAfterFollowUp?.();
    });

    await getTool()?.execute("id1", { nextTask: "2. Wire the login form" }, undefined, undefined, ctx);

    expect(compactCalls.length).toBe(1);
    // Follow-up must name the task being advanced to
    expect(globalThis.__piCompactFollowUp).toBeUndefined(); // consumed by mock
  });

  test("follow-up message names the task being advanced to", async () => {
    setSetting("interTaskCompact", "compact");
    const { getTool } = captureTaskReadyAdvanceTool();
    let captured: { skillName?: string; message?: string } | undefined;
    const ctx = makeCtx(() => {
      captured = globalThis.__piCompactFollowUp;
      delete globalThis.__piCompactFollowUp;
      (captured as { onAfterFollowUp?: () => void })?.onAfterFollowUp?.();
    });

    await getTool()?.execute("id1", { nextTask: "3. Add the validator" }, undefined, undefined, ctx);

    expect(captured).toBeDefined();
    // skillName is intentionally NOT set — compaction.ts derives it from the current phase
    // via getExpectedSkill() (implement→fy-implement, review→fy-review), so the tool
    // does not hardcode the implement skill.
    expect(captured?.skillName).toBeUndefined();
    expect(captured?.message).toContain("3. Add the validator");
  });

  test("interTaskCompact=compact>NK: skips compact when context is below threshold", async () => {
    setSetting("interTaskCompact", "compact>125K");
    const { getTool } = captureTaskReadyAdvanceTool();
    const compactCalls: unknown[] = [];
    const ctx = makeCtx(() => compactCalls.push(true));
    // Below-threshold context: 1000 tokens
    (ctx as { getContextUsage?: () => unknown }).getContextUsage = () => ({ tokens: 1000 });

    await getTool()?.execute("id1", { nextTask: "1. Start" }, undefined, undefined, ctx);
    expect(compactCalls.length).toBe(0);
  });

  test("interTaskCompact=compact>NK: compacts when context exceeds threshold", async () => {
    setSetting("interTaskCompact", "compact>125K");
    const { getTool } = captureTaskReadyAdvanceTool();
    const compactCalls: unknown[] = [];
    const ctx = makeCtx(() => {
      compactCalls.push(true);
      const stored = globalThis.__piCompactFollowUp;
      delete globalThis.__piCompactFollowUp;
      stored?.onAfterFollowUp?.();
    });
    (ctx as { getContextUsage?: () => unknown }).getContextUsage = () => ({ tokens: 200_000 });

    await getTool()?.execute("id1", { nextTask: "1. Start" }, undefined, undefined, ctx);
    expect(compactCalls.length).toBe(1);
  });

  test("re-entrancy guard: a second START while compact is in-flight does not compact again", async () => {
    setSetting("interTaskCompact", "compact");
    const { getTool } = captureTaskReadyAdvanceTool();
    const compactCalls: unknown[] = [];
    // Compact that does NOT invoke onAfterFollowUp → guard stays active
    const ctx = makeCtx(() => compactCalls.push(true));

    // First call STARTs task 1 (compact). The second call ADVANCEs to task 2 — with gates
    // off it would compact too, but the in-flight compact guard suppresses a re-entrant
    // compact, so only one compact fires.
    await getTool()?.execute("id1", { nextTask: "1. First" }, undefined, undefined, ctx);
    await getTool()?.execute("id2", { nextTask: "2. Second" }, undefined, undefined, ctx);

    expect(compactCalls.length).toBe(1);
  });

  test("current task is recorded in feature state (durable across resume)", async () => {
    setSetting("interTaskCompact", "none");
    const { getTool } = captureTaskReadyAdvanceTool();
    const ctx = makeCtx(() => {});
    const featureState = globalThis.__piWorkflowMonitor?.handler.getActiveFeatureState();
    expect(featureState).not.toBeNull();

    expect(featureState?.implement.currentTask ?? null).toBeNull();
    await getTool()?.execute("id1", { nextTask: "4. Recorded task" }, undefined, undefined, ctx);
    expect(featureState?.implement.currentTask).toBe("4. Recorded task");
  });

  test("gate: blocked outside implement phase (returns reason, does not compact or record)", async () => {
    setSetting("interTaskCompact", "compact");
    // Handler reports a non-implement phase.
    globalThis.__piWorkflowMonitor = {
      ...(globalThis.__piWorkflowMonitor ?? {}),
      handler: { getWorkflowState: () => ({ currentPhase: "verify" }) } as unknown as FeatureSession,
    } as unknown as PiWorkflowMonitorBridge;
    const { getTool } = captureTaskReadyAdvanceTool();
    const compactCalls: unknown[] = [];
    const ctx = makeCtx(() => compactCalls.push(true));

    const result = await getTool()?.execute("id1", { nextTask: "5. Should be blocked" }, undefined, undefined, ctx);

    const out = (result?.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(out).toMatch(/Not available outside featyard implement phase/i);
    expect(compactCalls.length).toBe(0);
  });

  test("gate: blocked when no active workflow (no handler)", async () => {
    setSetting("interTaskCompact", "compact");
    delete globalThis.__piWorkflowMonitor; // no active workflow
    const { getTool } = captureTaskReadyAdvanceTool();
    const ctx = makeCtx(() => {});

    const result = await getTool()?.execute("id1", { nextTask: "6. No workflow" }, undefined, undefined, ctx);

    const out = (result?.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(out).toMatch(/Not available outside featyard implement phase/i);
  });
});

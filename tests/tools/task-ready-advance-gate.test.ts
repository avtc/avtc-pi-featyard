// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _resetCompactGuard } from "../../src/compaction/compact-trigger.js";
import { _setAreAllTodosDoneOverride } from "../../src/integrations/todo-integration.js";
import type { PiWorkflowMonitorBridge } from "../../src/shared/types.js";
import { setGuardrailsRef } from "../../src/shared/workflow-refs.js";
import type { IGuardrails } from "../../src/shared/workflow-types.js";
import type { FeatureSession } from "../../src/state/feature-session.js";
import type { FeatureState } from "../../src/state/feature-state.js";
import { schedulePostTurnDrain } from "../../src/state/post-turn-dispatch.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  captureTaskReadyAdvanceTool,
  cleanupAfterTest,
  type Sent,
  withTempCwd,
} from "../helpers/workflow-monitor-test-helpers.js";

const NOOP = () => {};

function makeCtx(compactImpl: () => void): ExtensionContext {
  return {
    hasUI: false,
    ui: { setWidget: vi.fn() },
    sessionManager: { getBranch: () => [] },
    compact: compactImpl,
  } as unknown as ExtensionContext;
}

function makeFeatureState(currentTask: string | null, rounds: Record<string, number> = {}): FeatureState {
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
    implement: { taskReviewRounds: { ...rounds }, currentTask },
    verify: { verifyLoopCount: 0 },
    review: { reviewLoopCount: 0, reviewHistory: [] },
  } as unknown as FeatureState;
}

function installHandler(currentTask: string | null, rounds: Record<string, number> = {}): FeatureState {
  const featureState = makeFeatureState(currentTask, rounds);
  globalThis.__piWorkflowMonitor = {
    ...(globalThis.__piWorkflowMonitor ?? {}),
    handler: {
      getWorkflowState: () => ({ currentPhase: "implement" }),
      getActiveFeatureState: () => featureState,
      getActiveFeatureSlug: () => "test-slug",
      getFullState: () => ({ featureState, guardrailsState: null }),
      completeCurrentWorkflowPhase: () => ({ kind: "advanced" as const, nextPhase: "verify" as const }),
    } as unknown as FeatureSession,
    requestWidgetUpdate: () => {},
  } as PiWorkflowMonitorBridge;
  return featureState;
}

function clearHandler(): void {
  delete globalThis.__piWorkflowMonitor;
}

/** Assert a gate round was dispatched via steer with the given gates. */
function expectGateDispatch(sent: Sent[], { verifier, reviewer }: { verifier: boolean; reviewer: boolean }) {
  const gate = sent.find((s) => s.text.includes("fy-task-gate"));
  if (!gate) throw new Error("expected a fy-task-gate steer dispatch");
  expect(gate.options.deliverAs).toBe("steer");
  if (verifier) expect(gate.text).toContain("#### Verify");
  else expect(gate.text).not.toContain("#### Verify");
  if (reviewer) expect(gate.text).toContain("#### Review");
  else expect(gate.text).not.toContain("#### Review");
  return gate;
}

describe("task_ready_advance gate cycle (dispatch model)", () => {
  beforeEach(() => {
    setTestSettings(null);
    setSetting("interTaskCompact", "none");
    setSetting("maxTaskReviewRounds", 3);
    setSetting("verifyPhases", "plan+implement+verify"); // verifier active
    setSetting("perTaskReviewMode", "general"); // reviewer active
    _resetCompactGuard();
    delete globalThis.__piCompactFollowUp;
    _setAreAllTodosDoneOverride(true);
    withTempCwd();
    installHandler("1. Task", { "1-task": 0 }); // entry round
  });

  afterEach(() => {
    cleanupAfterTest();
    _resetCompactGuard();
    delete globalThis.__piCompactFollowUp;
    _setAreAllTodosDoneOverride(null);
    setGuardrailsRef(null);
    clearHandler();
  });

  // entry dispatches round 1 with both active gates
  test("entry (round 0, both gates active) dispatches round 1 via steer with both gates", async () => {
    const featureState = installHandler("1. Task", { "1-task": 0 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", { nextTask: "2. Next" }, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /End your turn, wait for instructions/i,
    );
    expectGateDispatch(sent, { verifier: true, reviewer: true });
    expect(featureState.implement.taskReviewRounds["1-task"]).toBe(1);
  });

  // INVARIANT: history is immutable — the dispatched gate block must reach conversation
  // history with ALL {{PI_FY_*}} markers already resolved. No per-call re-substitution
  // exists to fix this later (that would mutate mid-history text on every rewind and
  // re-prefill local models). The block is resolved once, at dispatch time.
  test("dispatched gate block reaches history fully resolved (no {{PI_FY_ markers)", async () => {
    installHandler("1. Task", { "1-task": 0 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await getTool()?.execute("id", { nextTask: "2. Next" }, undefined, undefined, makeCtx(NOOP));
    const gate = expectGateDispatch(sent, { verifier: true, reviewer: true });
    // Zero unresolved markers in the message committed to history.
    expect(gate.text).not.toContain("{{PI_FY_");
    // The task-scoped known-issues marker resolved to a real reviews path (proves real
    // substitution, not marker-stripping). Resolves to the slug-based path when a feature
    // is active, or the date-based fallback otherwise — match loosely to avoid brittleness.
    expect(gate.text).toMatch(/\.featyard\/reviews\/[^\s]*known-issues\.md/);
  });

  // resume-safe: a task resumed with no prior counter entry coerces to 0 → ENTRY dispatch
  test("resume coerce: a missing taskReviewRounds entry is treated as round 0 → ENTRY dispatch", async () => {
    // No explicit { "1-task": 0 } — the entry is absent (e.g. task started before this field existed).
    const featureState = installHandler("1. Task", {});
    expect(featureState.implement.taskReviewRounds["1-task"]).toBeUndefined();
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await getTool()?.execute("id", { nextTask: "2. Next" }, undefined, undefined, makeCtx(NOOP));
    // Coerced ?? 0 → ENTRY → round 1 dispatched.
    expectGateDispatch(sent, { verifier: true, reviewer: true });
    expect(featureState.implement.taskReviewRounds["1-task"]).toBe(1);
  });

  // recall with fixed>0 & round<max → next round
  test("recall with verifier fixes (round 1 < max 3) → re-dispatches round 2", async () => {
    const featureState = installHandler("1. Task", { "1-task": 1 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 2, reviewerIssuesFixed: 0, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    // fixedV>0 → re-run verifier AND reviewer
    expectGateDispatch(sent, { verifier: true, reviewer: true });
    expect(featureState.implement.taskReviewRounds["1-task"]).toBe(2);
    // The dispatched gate skill must announce the round matching the counter.
    expect(sent.some((s) => /\bRound 2\b/.test(s.text))).toBe(true);
  });

  // fixedV>0 → both gates; fixedR>0 only → reviewer only
  test("recall with reviewer-only fixes → re-dispatches reviewer only", async () => {
    const featureState = installHandler("1. Task", { "1-task": 1 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 0, reviewerIssuesFixed: 1, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    // fixedV=0 → do NOT re-run verifier; fixedR>0 → re-run reviewer
    expectGateDispatch(sent, { verifier: false, reviewer: true });
    expect(featureState.implement.taskReviewRounds["1-task"]).toBe(2);
  });

  // both counts 0 → advances
  test("recall with both counts 0 → advances to nextTask (no dispatch)", async () => {
    const featureState = installHandler("1. Task", { "1-task": 1 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 0, reviewerIssuesFixed: 0, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /do not end your turn, work on it/i,
    );
    expect(featureState.implement.currentTask).toBe("2. Next");
    expect(featureState.implement.taskReviewRounds["2-next"]).toBe(0);
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined();
  });

  // negative counts are treated as 0 (no reloop, advance) — clamps like phase_ready
  test("negative counts are clamped to 0 → no reloop, advances", async () => {
    const featureState = installHandler("1. Task", { "1-task": 1 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute(
      "id",
      { verifierIssuesFixed: -5, reviewerIssuesFixed: -1, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /do not end your turn, work on it/i,
    );
    expect(featureState.implement.currentTask).toBe("2. Next");
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined();
  });

  // reviewer-inactive + reviewer-only-fixes quadrant: reviewer count can't drive a round
  test("reviewer-inactive + reviewer-only-fixes → advances (disabled reviewer cannot reloop)", async () => {
    setSetting("perTaskReviewMode", "off"); // reviewer off, verifier on
    const featureState = installHandler("1. Task", { "1-task": 1 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    // reviewerIssuesFixed>0 but reviewer inactive AND verifier has no findings → no reloop.
    const result = await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 0, reviewerIssuesFixed: 3, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /do not end your turn, work on it/i,
    );
    expect(featureState.implement.currentTask).toBe("2. Next");
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined();
  });

  // inactive gate's count ignored
  test("verifier-inactive: a non-zero verifierIssuesFixed does not drive a round", async () => {
    setSetting("verifyPhases", "off"); // verifier off, reviewer on
    const featureState = installHandler("1. Task", { "1-task": 1 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    // fixedV>0 but verifier inactive → no verifier respawn; reviewer only if fixedR>0
    await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 2, reviewerIssuesFixed: 0, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined(); // advances
    expect(featureState.implement.currentTask).toBe("2. Next");
  });

  // cap reached → advances, NO escalation (round < max, not <=)
  test("cap boundary maxTaskReviewRounds=1: round 1 with findings ADVANCES (round < max, not <=)", async () => {
    setSetting("maxTaskReviewRounds", 1);
    installHandler("1. Task", { "1-task": 1 }); // round 1, max 1
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 5, reviewerIssuesFixed: 5, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    // round(1) < max(1) is false → advances, no dispatch, no escalation
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /do not end your turn, work on it/i,
    );
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined();
  });

  // gate reads maxTaskReviewRounds (not maxVerifyRounds)
  test("cap is governed by maxTaskReviewRounds, not maxVerifyRounds", async () => {
    setSetting("maxTaskReviewRounds", 2);
    setSetting("maxVerifyRounds", 99); // a different setting that must NOT bound the per-task cap
    installHandler("1. Task", { "1-task": 2 }); // round 2 == maxTaskReviewRounds 2
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 1, reviewerIssuesFixed: 0, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    // round(2) < max(2) is false → advances despite maxVerifyRounds=99
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined();
  });

  // dispatch → NO compact (the gate skill must reach the agent); advance → compact.
  // Uses interTaskCompact=compact so a compact WOULD fire — asserting 0 on dispatch is meaningful.
  test("dispatch does not compact, but advance does", async () => {
    setSetting("interTaskCompact", "compact");
    // (a) dispatch round 1 → no compact.
    let dispatchCompact = 0;
    installHandler("1. Task", { "1-task": 0 });
    const { getTool } = captureTaskReadyAdvanceTool();
    const dispatchCtx = makeCtx(() => {
      dispatchCompact++;
      const stored = globalThis.__piCompactFollowUp;
      delete globalThis.__piCompactFollowUp;
      stored?.onAfterFollowUp?.();
    });
    await getTool()?.execute("id", { nextTask: "2. Next" }, undefined, undefined, dispatchCtx);
    expect(dispatchCompact).toBe(0);
    // (b) advance (both counts 0) → compacts.
    let advanceCompact = 0;
    installHandler("1. Task", { "1-task": 1 });
    const advanceCtx = makeCtx(() => {
      advanceCompact++;
      const stored = globalThis.__piCompactFollowUp;
      delete globalThis.__piCompactFollowUp;
      stored?.onAfterFollowUp?.();
    });
    await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 0, reviewerIssuesFixed: 0, nextTask: "2. Next" },
      undefined,
      undefined,
      advanceCtx,
    );
    expect(advanceCompact).toBe(1);
  });

  // both count params omitted → treated as 0/0, no error (advances on round 1)
  test("counts omitted on a recall → treated as 0/0 (advances)", async () => {
    installHandler("1. Task", { "1-task": 1 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", { nextTask: "2. Next" }, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /do not end your turn, work on it/i,
    );
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined();
  });

  // cannot-fix / false-positive excluded from counts (they are simply not reported)
  test("0 fixable (rest cannot-fix/fp) → advances (cannot-fix/fp are not in the count)", async () => {
    installHandler("1. Task", { "1-task": 1 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    // The model reports only FIXABLE counts; cannot-fix/fp are handled separately (escalated/noted),
    // so a 0/0 report means no re-dispatch is needed.
    await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 0, reviewerIssuesFixed: 0, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined();
  });

  // last-task reloop dispatch: recall on the last task with nextTask OMITTED + findings + round<max
  test("last-task reloop: nextTask omitted + findings + round<max → dispatches gate (not last→verify)", async () => {
    const featureState = installHandler("1. Only task", { "1-only-task": 1 }); // round 1, max 3
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 1, reviewerIssuesFixed: 0 },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    // nextTask omitted BUT round(1) < max(3) with fixes → dispatch a gate round (do NOT take last→verify)
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /End your turn, wait for instructions/i,
    );
    expectGateDispatch(sent, { verifier: true, reviewer: true });
    expect(featureState.implement.currentTask).toBe("1. Only task"); // unchanged
    // The dispatched skill omits nextTask in its example call (last-task reloop).
    const gate = sent.find((s) => s.text.includes("fy-task-gate"));
    if (!gate) throw new Error("expected a fy-task-gate dispatch");
    expect(gate.text).not.toContain("nextTask:");
  });

  // last→verify fires fy-verify on ANY !fired (interTaskCompact=none → !fired → fallback)
  test("last→verify dispatches fy-verify (guardrails wired)", async () => {
    // Gates off so the entry dispatch does not pre-empt the last→verify path.
    setSetting("verifyPhases", "off");
    setSetting("perTaskReviewMode", "off");
    installHandler("1. Final task", { "1-final-task": 0 });
    setGuardrailsRef({ setVerifyTestsPassed: () => {} } as unknown as IGuardrails);
    const { getTool, sent, pi } = captureTaskReadyAdvanceTool();
    await getTool()?.execute("id", {}, undefined, undefined, makeCtx(NOOP)); // nextTask omitted, todos done
    // fy-verify is staged for agent_settled delivery — schedule the deferred drain and flush the timer.
    vi.useFakeTimers();
    schedulePostTurnDrain(pi);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    expect(sent.some((s) => s.text.includes("fy-verify"))).toBe(true);
  });

  // R4-5: single-task plan with gates active — START (no dispatch), then ENTRY dispatch round 1,
  // then a clean recall (round 1, fixed 0, nextTask omitted) exits the gate cycle into last→verify.
  test("single-task plan: START → ENTRY dispatch round 1 → clean recall with nextTask omitted → last→verify", async () => {
    const featureState = installHandler(null); // no current task
    setGuardrailsRef({ setVerifyTestsPassed: () => {} } as unknown as IGuardrails);
    const { getTool, sent, pi } = captureTaskReadyAdvanceTool();

    // --- call 1: START the only task (cur null) → enter task, NO dispatch (deferred to recall) ---
    let result = await getTool()?.execute("id", { nextTask: "1. Only task" }, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(/Current task:/i);
    expect(featureState.implement.currentTask).toBe("1. Only task");
    expect(featureState.implement.taskReviewRounds["1-only-task"]).toBe(0); // round 0 until the ENTRY dispatch
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined();

    // --- call 2: recall (cur set, round 0, gates active) → ENTRY dispatch round 1 ---
    result = await getTool()?.execute("id", {}, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /End your turn, wait for instructions/i,
    );
    expectGateDispatch(sent, { verifier: true, reviewer: true });
    expect(featureState.implement.taskReviewRounds["1-only-task"]).toBe(1);

    // --- call 3: model implemented, clean recall (fixed 0), nextTask omitted (last task) ---
    const beforeVerify = sent.length;
    result = await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 0, reviewerIssuesFixed: 0 }, // nextTask omitted
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    // No NEW gate dispatch (clean), and fy-verify dispatched via the last→verify fallback.
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /wait for instructions for advancing to the next phase/i,
    );
    // fy-verify is staged for agent_settled delivery — schedule the deferred drain and flush the timer.
    vi.useFakeTimers();
    schedulePostTurnDrain(pi);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    const newSent = sent.slice(beforeVerify);
    expect(newSent.some((s) => s.text.includes("fy-verify"))).toBe(true);
    expect(newSent.some((s) => s.text.includes("fy-task-gate"))).toBe(false);
    // currentTask reset to null on the implement→verify transition.
    expect(featureState.implement.currentTask).toBeNull();
  });

  // R4-7: a task→task ADVANCE (nextTask provided) succeeds when todos are NOT all done —
  // the areAllTodosDone() gate is scoped to the last→verify branch only.
  test("task→task advance succeeds when todos are NOT all done (areAllTodosDone scoped to last→verify)", async () => {
    _setAreAllTodosDoneOverride(false);
    const featureState = installHandler("1. Task", { "1-task": 1 }); // round 1, model is mid-implementation
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 0, reviewerIssuesFixed: 0, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /do not end your turn, work on it/i,
    );
    expect(featureState.implement.currentTask).toBe("2. Next");
    expect(sent.find((s) => s.text.includes("fy-task-gate"))).toBeUndefined();
  });
});

// Single-gate activeness — single-gate ENTRY and reviewer-inactive reloop coverage.
// Guards against a regression that swaps the runVerifier/runReviewer activeness sources.
describe("task_ready_advance single-gate activeness", () => {
  beforeEach(() => {
    setSetting("interTaskCompact", "none");
    setSetting("maxTaskReviewRounds", 3);
    _resetCompactGuard();
    delete globalThis.__piCompactFollowUp;
    _setAreAllTodosDoneOverride(true);
    withTempCwd();
  });
  afterEach(() => {
    cleanupAfterTest();
    _resetCompactGuard();
    delete globalThis.__piCompactFollowUp;
    _setAreAllTodosDoneOverride(null);
    setGuardrailsRef(null);
    clearHandler();
  });

  test("ENTRY with only the reviewer active dispatches round 1 with reviewer only", async () => {
    setSetting("verifyPhases", "off"); // verifier off
    setSetting("perTaskReviewMode", "general"); // reviewer on
    installHandler("1. Task", { "1-task": 0 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await getTool()?.execute("id", { nextTask: "2. Next" }, undefined, undefined, makeCtx(NOOP));
    expectGateDispatch(sent, { verifier: false, reviewer: true });
  });

  test("ENTRY with only the verifier active dispatches round 1 with verifier only", async () => {
    setSetting("verifyPhases", "plan+implement+verify"); // verifier on
    setSetting("perTaskReviewMode", "off"); // reviewer off
    installHandler("1. Task", { "1-task": 0 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await getTool()?.execute("id", { nextTask: "2. Next" }, undefined, undefined, makeCtx(NOOP));
    expectGateDispatch(sent, { verifier: true, reviewer: false });
  });

  test("reviewer-inactive reloop: verifier fixes re-dispatch verifier ONLY (no reviewer)", async () => {
    setSetting("verifyPhases", "plan+implement+verify"); // verifier on
    setSetting("perTaskReviewMode", "off"); // reviewer off
    const featureState = installHandler("1. Task", { "1-task": 1 });
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await getTool()?.execute(
      "id",
      { verifierIssuesFixed: 2, reviewerIssuesFixed: 0, nextTask: "2. Next" },
      undefined,
      undefined,
      makeCtx(NOOP),
    );
    // verifier active + fixedV>0 → re-run verifier; reviewer inactive → NOT re-run.
    expectGateDispatch(sent, { verifier: true, reviewer: false });
    expect(featureState.implement.taskReviewRounds["1-task"]).toBe(2);
  });
});

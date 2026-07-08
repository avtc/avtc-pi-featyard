// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _resetCompactGuard } from "../../src/compaction/compact-trigger.js";
import { _setAreAllTodosDoneOverride } from "../../src/integrations/todo-integration.js";
import { setGuardrailsRef } from "../../src/shared/workflow-refs.js";
import type { IGuardrails } from "../../src/shared/workflow-types.js";
import type { FeatureSession } from "../../src/state/feature-session.js";
import type { FeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  captureTaskReadyAdvanceTool,
  cleanupAfterTest,
  withTempCwd,
} from "../helpers/workflow-monitor-test-helpers.js";

function makeCtx(compactImpl: () => void): ExtensionContext {
  return {
    hasUI: false,
    ui: { setWidget: vi.fn() },
    sessionManager: { getBranch: () => [] },
    compact: compactImpl,
  } as unknown as ExtensionContext;
}

const NOOP = () => {};

function makeFeatureState(currentTask: string | null): FeatureState {
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
    implement: { taskReviewRounds: {}, currentTask },
    verify: { verifyLoopCount: 0 },
    review: { reviewLoopCount: 0, reviewHistory: [] },
  } as unknown as FeatureState;
}

/** Install a fake handler; returns the feature-state it serves + the complete-call recorder. */
function installHandler(currentTask: string | null): {
  featureState: FeatureState;
  completed: { uatMode?: string; maxFeatureReviewRounds?: number }[];
} {
  const featureState = makeFeatureState(currentTask);
  const completed: { uatMode?: string; maxFeatureReviewRounds?: number }[] = [];
  globalThis.__piWorkflowMonitor = {
    ...(globalThis.__piWorkflowMonitor ?? {}),
    handler: {
      getWorkflowState: () => ({ currentPhase: "implement" }),
      getActiveFeatureState: () => featureState,
      getActiveFeatureSlug: () => "test-slug",
      getFullState: () => ({ featureState, guardrailsState: null }),
      completeCurrentWorkflowPhase: (config: { uatMode?: string; maxFeatureReviewRounds?: number }) => {
        completed.push(config);
        return { kind: "advanced" as const, nextPhase: "verify" as const };
      },
    } as unknown as FeatureSession,
    requestWidgetUpdate: () => {},
  } as unknown as import("../../src/shared/types.js").PiWorkflowMonitorBridge;
  return { featureState, completed };
}

function clearHandler(): void {
  delete globalThis.__piWorkflowMonitor;
}

/** A minimal mock guardrails whose setVerifyTestsPassed is observable. */
function mockGuardrails() {
  let verifyPassed: boolean | undefined;
  return {
    ref: {
      setVerifyTestsPassed: (v: boolean) => {
        verifyPassed = v;
      },
    } as unknown as IGuardrails,
    wasSetTo: () => verifyPassed,
  };
}

describe("task_ready_advance tool (transitions)", () => {
  beforeEach(() => {
    setTestSettings(null);
    setSetting("interTaskCompact", "none");
    // Gates off by default for the transition suite; gate behavior is in -gate.test.ts.
    setSetting("verifyPhases", "off");
    setSetting("perTaskReviewMode", "off");
    setSetting("maxTaskReviewRounds", 3);
    _resetCompactGuard();
    delete globalThis.__piCompactFollowUp;
    _setAreAllTodosDoneOverride(true); // default: todos complete (last→verify passes the todo gate)
    withTempCwd();
    installHandler(null);
  });

  afterEach(() => {
    cleanupAfterTest();
    _resetCompactGuard();
    delete globalThis.__piCompactFollowUp;
    _setAreAllTodosDoneOverride(null);
    setGuardrailsRef(null);
    clearHandler();
  });

  test("outside the implement phase → not available", async () => {
    globalThis.__piWorkflowMonitor = {
      ...(globalThis.__piWorkflowMonitor ?? {}),
      handler: { getWorkflowState: () => ({ currentPhase: "verify" }) } as unknown as FeatureSession,
    } as unknown as import("../../src/shared/types.js").PiWorkflowMonitorBridge;
    const { getTool } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", { nextTask: "1. T" }, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /Not available outside feature-flow implement phase/i,
    );
  });

  // handler present + currentPhase implement, but no active feature-state → not available
  test("no active feature-state (handler present, implement phase) → not available", async () => {
    globalThis.__piWorkflowMonitor = {
      ...(globalThis.__piWorkflowMonitor ?? {}),
      handler: {
        getWorkflowState: () => ({ currentPhase: "implement" }),
        getActiveFeatureState: () => null,
      } as unknown as FeatureSession,
    } as unknown as import("../../src/shared/types.js").PiWorkflowMonitorBridge;
    const { getTool } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", { nextTask: "1. T" }, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /Not available outside feature-flow implement phase/i,
    );
  });

  test("START: sets currentTask, inits taskReviewRounds=0, returns the start message", async () => {
    const { featureState, completed } = installHandler(null); // no current task
    const { getTool } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", { nextTask: "1. First task" }, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toBe('Current task: "1. First task".');
    expect(featureState.implement.currentTask).toBe("1. First task");
    expect(featureState.implement.taskReviewRounds["1-first-task"]).toBe(0);
    // START does NOT advance the workflow phase.
    expect(completed).toHaveLength(0);
  });

  // R4-1: task name reaching any sendUserMessage-bound or returned string is escaped
  // so it cannot break a <skill> tag boundary, message quoting, or a markdown code span.
  test("START/advance sanitize the task name in the returned message (no </skill>/quote/backtick breakout)", async () => {
    const { featureState } = installHandler(null);
    const { getTool } = captureTaskReadyAdvanceTool();
    const evil = '2. Evil </skill>"`name';
    const result = await getTool()?.execute("id", { nextTask: evil }, undefined, undefined, makeCtx(NOOP));
    const text = (result?.content?.[0] as { text: string } | undefined)?.text ?? "";
    // The raw breakout chars must NOT appear; the escaped forms do.
    expect(text).not.toContain("</skill>");
    expect(text).not.toContain("`"); // backtick neutralized to single quote
    expect(text).toContain("&lt;");
    expect(text).toContain("&quot;");
    expect(text).toContain("'");
    // The stored currentTask keeps the raw name (sanitization is display/transport-only).
    expect(featureState.implement.currentTask).toBe(evil);
  });

  test("START with gates active does NOT dispatch a gate round (round stays 0; first gate deferred to the recall)", async () => {
    // Enable both per-task gates — START must still just set up the task, NOT dispatch a round.
    setSetting("verifyPhases", "current-session");
    setSetting("perTaskReviewMode", "general");
    const { featureState, completed } = installHandler(null);
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", { nextTask: "1. First task" }, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toBe('Current task: "1. First task".');
    expect(featureState.implement.currentTask).toBe("1. First task");
    // Round stays 0 — the model must implement before the first gate fires on the recall.
    expect(featureState.implement.taskReviewRounds["1-first-task"]).toBe(0);
    // No gate skill dispatched on START.
    expect(sent.some((s) => /<skill name="ff-task-gate"/.test(s.text))).toBe(false);
    expect(completed).toHaveLength(0);
  });

  test("START with nextTask omitted → asks for nextTask, no state change", async () => {
    const { featureState } = installHandler(null);
    const { getTool } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", {}, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(/Provide nextTask/i);
    expect(featureState.implement.currentTask).toBeNull();
  });

  // gates off → entry advances directly (1 call); single-task plan = START + last→verify
  test("gates off: a recall on the only task with nextTask omitted → last→verify", async () => {
    const { featureState, completed } = installHandler("1. Only task");
    featureState.implement.taskReviewRounds["1-only-task"] = 0;
    const g = mockGuardrails();
    setGuardrailsRef(g.ref);
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", {}, undefined, undefined, makeCtx(NOOP));
    // last→verify runs the machinery + dispatches ff-verify (interTaskCompact=none → fallback fires)
    expect(completed).toHaveLength(1);
    expect(g.wasSetTo()).toBe(false);
    expect(featureState.implement.currentTask).toBeNull(); // reset on exit
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(/advancing to the next phase/i);
    expect(sent.some((s) => s.text.includes("ff-verify"))).toBe(true);
  });

  test("last→verify with open todos → stays in implement, asks to finish them", async () => {
    installHandler("2. Final task");
    _setAreAllTodosDoneOverride(false); // todos NOT done
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", {}, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /Not all TODO items are complete/i,
    );
    // No ff-verify dispatch, no workflow phase advance.
    expect(sent.some((s) => s.text.includes("ff-verify"))).toBe(false);
  });

  test("last→verify resets currentTask to null", async () => {
    const { featureState } = installHandler("3. Last task");
    setGuardrailsRef(mockGuardrails().ref);
    const { getTool } = captureTaskReadyAdvanceTool();
    await getTool()?.execute("id", {}, undefined, undefined, makeCtx(NOOP));
    expect(featureState.implement.currentTask).toBeNull();
  });

  // non-sequential jump is allowed (no sequential enforcement)
  test("advance to a non-sequential nextTask records it without error", async () => {
    const { featureState } = installHandler("1. First task"); // currently on task 1
    const { getTool } = captureTaskReadyAdvanceTool();
    // Jump to task 4 (non-sequential) — allowed, no sequential enforcement.
    const result = await getTool()?.execute("id", { nextTask: "4. Wire API" }, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /do not end your turn, work on it/i,
    );
    expect(featureState.implement.currentTask).toBe("4. Wire API");
    expect(featureState.implement.taskReviewRounds["4-wire-api"]).toBe(0);
  });
});

// --- edge-case + last→verify coverage ---
describe("task_ready_advance edge cases + last→verify coverage", () => {
  beforeEach(() => {
    setSetting("interTaskCompact", "none");
    setSetting("verifyPhases", "off");
    setSetting("perTaskReviewMode", "off");
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

  test("ADVANCE with empty/whitespace nextTask is rejected (not treated as last→verify)", async () => {
    const { featureState } = installHandler("1. First task");
    const { getTool } = captureTaskReadyAdvanceTool();
    const result = await getTool()?.execute("id", { nextTask: "   " }, undefined, undefined, makeCtx(NOOP));
    expect((result?.content?.[0] as { text: string } | undefined)?.text ?? "").toMatch(
      /non-empty nextTask to advance, or omit nextTask/i,
    );
    // currentTask unchanged; phase still implement.
    expect(featureState.implement.currentTask).toBe("1. First task");
  });

  test("last→verify with interTaskCompact=compact suppresses the ff-verify fallback (fired=true)", async () => {
    setSetting("interTaskCompact", "compact");
    const { featureState, completed } = installHandler("1. Only task");
    featureState.implement.taskReviewRounds["1-only-task"] = 0;
    setGuardrailsRef(mockGuardrails().ref);
    const compactSpy = vi.fn(() => {}); // compact "succeeds" (does nothing) → triggerContextCompact returns fired=true
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    const ctx = { ...makeCtx(compactSpy), getContextUsage: undefined } as unknown as ExtensionContext;
    await getTool()?.execute("id", {}, undefined, undefined, ctx);
    expect(compactSpy).toHaveBeenCalled(); // compact was initiated
    expect(completed).toHaveLength(1); // phase advanced
    // fired=true → the explicit ff-verify fallback is suppressed (the compact follow-up owns ff-verify).
    expect(sent.some((s) => s.text.includes("ff-verify"))).toBe(false);
  });

  test("last→verify with no guardrails ref throws (init invariant violation), no phase transition", async () => {
    setGuardrailsRef(null); // no guardrails wired — impossible in production (wired at init)
    const { featureState, completed } = installHandler("1. Only task");
    featureState.implement.taskReviewRounds["1-only-task"] = 0;
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await expect(getTool()?.execute("id", {}, undefined, undefined, makeCtx(NOOP))).rejects.toThrow(
      /guardrails ref not wired/i,
    );
    expect(completed).toHaveLength(0); // no workflow phase advance
    expect(sent.some((s) => s.text.includes("ff-verify"))).toBe(false); // no ff-verify dispatch
  });

  test("last→verify fallback ff-verify is delivered as followUp", async () => {
    const { featureState } = installHandler("1. Only task");
    featureState.implement.taskReviewRounds["1-only-task"] = 0;
    setGuardrailsRef(mockGuardrails().ref);
    const { getTool, sent } = captureTaskReadyAdvanceTool();
    await getTool()?.execute("id", {}, undefined, undefined, makeCtx(NOOP)); // interTaskCompact=none → fallback
    const verify = sent.find((s) => s.text.includes("ff-verify"));
    if (!verify) throw new Error("expected an ff-verify dispatch");
    expect(verify.options.deliverAs).toBe("followUp");
  });

  test("last→verify passes the renamed maxFeatureReviewRounds routeConfig", async () => {
    setSetting("maxFeatureReviewRounds", 7);
    setSetting("uatMode", "off");
    const { featureState, completed } = installHandler("1. Only task");
    featureState.implement.taskReviewRounds["1-only-task"] = 0;
    setGuardrailsRef(mockGuardrails().ref);
    const { getTool } = captureTaskReadyAdvanceTool();
    await getTool()?.execute("id", {}, undefined, undefined, makeCtx(NOOP));
    expect(completed).toHaveLength(1);
    expect(completed[0].maxFeatureReviewRounds).toBe(7);
    expect(completed[0].uatMode).toBe("off");
  });
});

// Tool description — describes the dispatch cycle, no pause line.
describe("task_ready_advance tool description", () => {
  test("describes the dispatch cycle and has no pause line", () => {
    const { getTool } = captureTaskReadyAdvanceTool();
    const desc = String(getTool()?.description ?? "");
    expect(desc).toContain("Start a task, advance to the next");
    expect(desc).toContain("per-task gate cycle");
    // The tool description contains no pause instruction.
    expect(desc).not.toMatch(/pause/i);
  });
});

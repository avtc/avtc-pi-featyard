// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Regression: review-loop increments (reviewLoopCount / reviewActive / reviewHistory)
// are durable FeatureState. They were written to the disk file (saveFeatureState) but
// NOT appended to the session log (persistState/appendEntry). On session resume, the
// active feature's state is reconstructed from the session log, so the counter reset to
// its pre-loop value and the review restarted at round 1 — even though the disk file
// held the correct count. These tests pin the contract that a review-loop increment is
// reflected in the latest featyard_state session entry AND survives a session resume.

import type {
  ExtensionAPI,
  ExtensionEvent,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createPiWithToolCapture,
  DESIGN_ACTIVE_STATE,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  NO_UI_CTX,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

interface FeatyardEntry {
  featureState: {
    featureSlug: string;
    completedAt: string | null;
    design: { reviewLoopCount: number; reviewActive: boolean };
    plan: { reviewLoopCount: number; reviewActive: boolean };
    review: { reviewLoopCount: number; reviewHistory: unknown[] };
  } | null;
}

function latestFeatyardEntry(appendedEntries: Array<{ customType: string; data: unknown }>): FeatyardEntry | undefined {
  for (let i = appendedEntries.length - 1; i >= 0; i--) {
    const e = appendedEntries[i];
    if (e.customType === "featyard_state") return e.data as FeatyardEntry;
  }
  return undefined;
}

/** Build a session branch (for getBranch) from captured featyard_state entries. */
function branchFromEntries(entries: Array<{ customType: string; data: unknown }>) {
  return entries
    .filter((e) => e.customType === "featyard_state")
    .map((e, i) => ({ id: `entry-${i}`, type: "custom", customType: e.customType, data: e.data }));
}

function makeResumeCtx(branch: ReturnType<typeof branchFromEntries>): ExtensionToolContext {
  return {
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: { setWidget: () => {}, select: async () => "x", info: () => {}, setEditorText: () => {} },
  } as unknown as ExtensionToolContext;
}

describe("review-loop increment survives session resume (session log)", () => {
  beforeEach(() => {
    setTestSettings(null);
    enableSubagentMode();
  });

  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("design review loop: incremented reviewLoopCount is in the session log and survives resume", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-30-design-resume";
    writeFeatureStateFile(slug, {
      ...DESIGN_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-design-resume", { issuesFound: 3 }, undefined, undefined, NO_UI_CTX);

    // Disk file is correct (the pre-fix behavior)...
    expect(loadFeatureState(slug, null)?.design.reviewLoopCount).toBe(2);

    // ...and the latest featyard_state session entry MUST also carry the increment
    // (this is what resume reads). Pre-fix this was stale (still 1) → round 1 on resume.
    const latest = latestFeatyardEntry(fake.appendedEntries as Array<{ customType: string; data: unknown }>);
    expect(latest?.featureState?.design.reviewLoopCount).toBe(2);
    expect(latest?.featureState?.design.reviewActive).toBe(true);

    // Simulate exit + resume: reset in-memory state, restore from the captured session log.
    _resetFeatureState();
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "resume" },
      makeResumeCtx(branchFromEntries(fake.appendedEntries as Array<{ customType: string; data: unknown }>)),
    );

    const restored = globalThis.__piWorkflowMonitor?.handler.getActiveFeatureState();
    expect(restored?.design.reviewLoopCount).toBe(2);
    expect(restored?.design.reviewActive).toBe(true);
  });

  test("plan review loop: incremented reviewLoopCount survives resume", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-30-plan-resume";
    writeFeatureStateFile(slug, {
      workflow: { currentPhase: "plan", designDoc: `docs/featyard/designs/${slug}-design.md`, planDoc: null },
      completedAt: null,
      design: { doc: `docs/featyard/designs/${slug}-design.md`, reviewActive: false, reviewLoopCount: 1 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-plan-resume", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    expect(loadFeatureState(slug, null)?.plan.reviewLoopCount).toBe(2);

    const latest = latestFeatyardEntry(fake.appendedEntries as Array<{ customType: string; data: unknown }>);
    expect(latest?.featureState?.plan.reviewLoopCount).toBe(2);

    _resetFeatureState();
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "resume" },
      makeResumeCtx(branchFromEntries(fake.appendedEntries as Array<{ customType: string; data: unknown }>)),
    );

    const restored = globalThis.__piWorkflowMonitor?.handler.getActiveFeatureState();
    expect(restored?.plan.reviewLoopCount).toBe(2);
  });

  test("review phase loop: incremented review.reviewLoopCount + history survive resume", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-30-reviewphase-resume";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "review",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
      completedAt: null,
      review: { reviewLoopCount: 1, reviewActive: false },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-reviewphase-resume", { issuesFound: 4 }, undefined, undefined, NO_UI_CTX);

    expect(loadFeatureState(slug, null)?.review.reviewLoopCount).toBe(2);
    expect(loadFeatureState(slug, null)?.review.reviewHistory).toHaveLength(1);

    const latest = latestFeatyardEntry(fake.appendedEntries as Array<{ customType: string; data: unknown }>);
    expect(latest?.featureState?.review.reviewLoopCount).toBe(2);
    expect(latest?.featureState?.review.reviewHistory).toHaveLength(1);

    _resetFeatureState();
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "resume" },
      makeResumeCtx(branchFromEntries(fake.appendedEntries as Array<{ customType: string; data: unknown }>)),
    );

    const restored = globalThis.__piWorkflowMonitor?.handler.getActiveFeatureState();
    expect(restored?.review.reviewLoopCount).toBe(2);
    expect(restored?.review.reviewHistory).toHaveLength(1);
  });
});

describe("feature completion (completedAt) survives session resume", () => {
  beforeEach(() => {
    setTestSettings(null);
  });

  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
  });

  /** Drive a feature to the finish pointer (all prior phases derived done). */
  async function setupAtFinish(slug: string) {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: `docs/featyard/designs/${slug}-design.md` },
      } as unknown as ExtensionEvent,
      NO_UI_CTX,
    );
    const featureState = loadFeatureState(slug, null);
    if (!featureState) throw new Error("Feature state not found");
    featureState.workflow.currentPhase = "finish";
    saveFeatureState(featureState, null);
    enableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);
    disableSubagentMode();
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    return { fake, phaseReady };
  }

  test("completedAt set at finish is in the session log and survives resume", async () => {
    const slug = "2026-07-30-finish-resume";
    const { fake, phaseReady } = await setupAtFinish(slug);

    const finishCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, select: async () => "next", setEditorText: () => {}, notify: () => {} },
    } as unknown as ExtensionToolContext;
    await phaseReady.execute("tc-finish-resume", {}, undefined, undefined, finishCtx);

    expect(loadFeatureState(slug, null)?.completedAt).not.toBeNull();

    // The latest featyard_state session entry must carry completedAt — resume reads
    // this tier. Pre-fix it was stale (null) → a resumed completed feature looked incomplete.
    const latest = latestFeatyardEntry(fake.appendedEntries as Array<{ customType: string; data: unknown }>);
    expect(latest?.featureState?.completedAt).not.toBeNull();

    _resetFeatureState();
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "resume" },
      makeResumeCtx(branchFromEntries(fake.appendedEntries as Array<{ customType: string; data: unknown }>)),
    );

    const restored = globalThis.__piWorkflowMonitor?.handler.getActiveFeatureState();
    expect(restored?.completedAt).not.toBeNull();
  });
});

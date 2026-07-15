// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { isPhaseActive, isPhaseDone, type PhaseProgressionView } from "../../src/phases/phase-progression.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  cleanupAfterTest,
  createPiWithToolCapture,
  enableSubagentMode,
  fireAllHandlers,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("UAT auto-skip for off mode", () => {
  beforeEach(() => {
    setTestSettings(null);
    enableSubagentMode();
  });

  afterEach(() => {
    _resetFeatureState();
    cleanupAfterTest();
  });

  const noUICtx = {
    hasUI: false,
    sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
    ui: { setWidget: () => {} },
  };

  const mockCtx = {
    hasUI: true,
    sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
    ui: { setWidget: () => {}, notify: () => {} },
  } as unknown as ExtensionContext;

  /** Review-in-progress fixture: pointer at review, review loop count 0. */
  function reviewActiveOverrides() {
    return {
      workflow: {
        currentPhase: "review",
        designDoc: "docs/featyard/designs/test-design.md",
        planDoc: "docs/plans/test-impl.md",
      },
      review: { reviewLoopCount: 0, reviewHistory: [] },
    };
  }

  function view(state: { workflow: { currentPhase: string | null }; completedAt: string | null }) {
    return { currentPhase: state.workflow.currentPhase, completedAt: state.completedAt };
  }

  test("off mode: UAT auto-bypassed and finish auto-proceeds after review loop ends", async () => {
    setSetting("uatMode", "off");
    setSetting("maxFeatureReviewRounds", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = writeFeatureStateFile("2026-05-16-uat-off-auto-test", reviewActiveOverrides());

    workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Reconstruct handler state from the feature file
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, noUICtx);

    // Simulate review loop end: 1 fix task complete with result "fixed" → issuesFound=1, cannotFix=0
    await phaseReady.execute("tc-review-end", { issuesFound: 1, cannotFix: 0 }, undefined, undefined, mockCtx);

    // Verify UAT is skipped (done, derived) and finish is the current phase
    const state = loadFeatureState(slug, null);
    expect(
      isPhaseDone(
        view(
          state as unknown as { workflow: { currentPhase: string | null }; completedAt: string | null },
        ) as unknown as PhaseProgressionView,
        "uat",
      ),
    ).toBe(true);
    expect(
      isPhaseDone(
        view(
          state as unknown as { workflow: { currentPhase: string | null }; completedAt: string | null },
        ) as unknown as PhaseProgressionView,
        "review",
      ),
    ).toBe(true);
    expect(state?.workflow.currentPhase).toBe("finish");
  });

  test("after-review mode: UAT is active and feature pauses for user", async () => {
    setSetting("uatMode", "after-review");
    setSetting("maxFeatureReviewRounds", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = writeFeatureStateFile("2026-05-16-uat-after-review-test", reviewActiveOverrides());

    workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, noUICtx);

    // Simulate review loop end: 1 fix task complete with result "fixed" → issuesFound=1, cannotFix=0
    await phaseReady.execute("tc-review-end", { issuesFound: 1, cannotFix: 0 }, undefined, undefined, mockCtx);

    const state = loadFeatureState(slug, null);
    expect(
      isPhaseActive(
        view(
          state as unknown as { workflow: { currentPhase: string | null }; completedAt: string | null },
        ) as unknown as PhaseProgressionView,
        "uat",
      ),
    ).toBe(true);
    expect(
      isPhaseDone(
        view(
          state as unknown as { workflow: { currentPhase: string | null }; completedAt: string | null },
        ) as unknown as PhaseProgressionView,
        "review",
      ),
    ).toBe(true);
    expect(state?.workflow.currentPhase).toBe("uat");
  });

  test("after-finish mode: proceeds to finish (after-finish UAT driven by derived check)", async () => {
    setSetting("uatMode", "after-finish");
    setSetting("maxFeatureReviewRounds", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = writeFeatureStateFile("2026-05-16-uat-after-finish-test", reviewActiveOverrides());

    workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, noUICtx);

    // Simulate review loop end: 1 fix task complete with result "fixed" → issuesFound=1, cannotFix=0
    await phaseReady.execute("tc-review-end", { issuesFound: 1, cannotFix: 0 }, undefined, undefined, mockCtx);

    const state = loadFeatureState(slug, null);
    expect(
      isPhaseDone(
        view(
          state as unknown as { workflow: { currentPhase: string | null }; completedAt: string | null },
        ) as unknown as PhaseProgressionView,
        "review",
      ),
    ).toBe(true);
    expect(state?.workflow.currentPhase).toBe("finish");
    // uat is before finish in the phase order, so it is derived done (the
    // after-finish UAT pause is driven by a separate derived check at finish).
    expect(
      isPhaseDone(
        view(
          state as unknown as { workflow: { currentPhase: string | null }; completedAt: string | null },
        ) as unknown as PhaseProgressionView,
        "uat",
      ),
    ).toBe(true);
  });
});

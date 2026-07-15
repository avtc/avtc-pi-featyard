// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, test } from "vitest";
import { isPhaseActive, isPhaseDone, type PhaseProgressionView } from "../../src/phases/phase-progression.js";
import { createFeatureSession, type FeatureSession } from "../../src/state/feature-session.js";

/** The handler owns only a pointer (no completedAt); status is derived with a null completedAt. */
function view(state: { currentPhase: PhaseProgressionView["currentPhase"] }): PhaseProgressionView {
  return { currentPhase: state.currentPhase, completedAt: null };
}

describe("transitionToUat", () => {
  let handler: FeatureSession;

  beforeEach(() => {
    handler = createFeatureSession(null);
  });

  test("sets currentPhase to uat and derives uat as active", () => {
    // Advance through phases to review complete
    handler.processSkillInput("/skill:fy-design");
    handler.recordDoc("docs/featyard/designs/2026-05-16-test-design.md");
    handler.processSkillInput("/skill:fy-plan");
    handler.recordDoc(".featyard/task-plans/2026-05-16-test-task-plan.md");
    handler.processSkillInput("/skill:fy-implement");
    handler.processSkillInput("/skill:fy-verify");
    handler.processSkillInput("/skill:fy-review");
    handler.completeCurrentWorkflowPhase({ uatMode: "off" as const, maxFeatureReviewRounds: 3 as const }); // complete review → finish

    // Now transition to UAT (new model: explicit pointer move to uat)
    handler.setCurrentPhase("uat");

    const state = handler.getWorkflowState();
    if (!state) throw new Error("No workflow state");
    expect(state.currentPhase).toBe("uat");
    expect(isPhaseActive(view(state), "uat")).toBe(true);
    expect(isPhaseDone(view(state), "review")).toBe(true);
  });

  test("after-finish mode: re-enter uat by moving the pointer (uat becomes active)", () => {
    // Advance all the way through finish
    handler.processSkillInput("/skill:fy-design");
    handler.recordDoc("docs/featyard/designs/2026-05-16-test-design.md");
    handler.processSkillInput("/skill:fy-plan");
    handler.recordDoc(".featyard/task-plans/2026-05-16-test-task-plan.md");
    handler.processSkillInput("/skill:fy-implement");
    handler.processSkillInput("/skill:fy-verify");
    handler.processSkillInput("/skill:fy-review");
    handler.completeCurrentWorkflowPhase({ uatMode: "off" as const, maxFeatureReviewRounds: 3 as const }); // complete review → finish
    handler.completeCurrentWorkflowPhase({ uatMode: "off" as const, maxFeatureReviewRounds: 3 as const }); // complete finish → completed

    // After-finish mode: re-enter uat by moving the pointer.
    handler.setCurrentPhase("uat");

    const state = handler.getWorkflowState();
    if (!state) throw new Error("No workflow state");
    expect(state.currentPhase).toBe("uat");
    expect(isPhaseActive(view(state), "uat")).toBe(true);
    // all earlier phases (design..review) remain derived done
    expect(isPhaseDone(view(state), "review")).toBe(true);
  });

  test("skipping UAT moves the pointer to finish (uat derived done)", () => {
    handler.processSkillInput("/skill:fy-design");
    handler.recordDoc("docs/featyard/designs/2026-05-16-test-design.md");
    handler.processSkillInput("/skill:fy-plan");
    handler.recordDoc(".featyard/task-plans/2026-05-16-test-task-plan.md");
    handler.processSkillInput("/skill:fy-implement");
    handler.processSkillInput("/skill:fy-verify");
    handler.processSkillInput("/skill:fy-review");
    handler.completeCurrentWorkflowPhase({ uatMode: "off" as const, maxFeatureReviewRounds: 3 as const }); // complete review → finish

    // skip=true → setCurrentPhase("finish")
    handler.setCurrentPhase("finish");

    const state = handler.getWorkflowState();
    if (!state) throw new Error("No workflow state");
    expect(state.currentPhase).toBe("finish");
    expect(isPhaseDone(view(state), "uat")).toBe(true); // uat before finish → derived done
  });
});

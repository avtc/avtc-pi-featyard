// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, test } from "vitest";
import { isPhaseActive, isPhaseDone, PhaseProgression } from "../../src/phases/phase-progression.js";
import type { RouteConfig } from "../../src/phases/workflow-router.js";
import { routeNext, toRouteConfig, WorkflowRouter } from "../../src/phases/workflow-router.js";
import type { FeatureFlowSettings } from "../../src/settings/settings-ui.js";

// Helper: build a minimal PhaseProgressionView from state for the status predicates.
function view(state: { currentPhase: import("../../src/phases/phase-progression.js").Phase | null }) {
  return {
    currentPhase: state.currentPhase,
    completedAt: null,
    phases: {},
  };
}

// Route config helper: maxFeatureReviewRounds > 0 keeps review; 0 skips it.
function cfg(uatMode: "after-review" | "after-finish" | "off", maxFeatureReviewRounds: number): RouteConfig {
  return { uatMode, maxFeatureReviewRounds };
}

describe("routeNext (pure routing decision)", () => {
  test("design→plan", () => {
    expect(routeNext("design", cfg("off", 1))).toEqual({ phase: "plan" });
  });
  test("plan→implement", () => {
    expect(routeNext("plan", cfg("off", 1))).toEqual({ phase: "implement" });
  });
  test("implement→verify", () => {
    expect(routeNext("implement", cfg("off", 1))).toEqual({ phase: "verify" });
  });
  test("verify→review when review enabled", () => {
    expect(routeNext("verify", cfg("off", 1))).toEqual({ phase: "review" });
  });
  test("verify→finish (skips review) when maxFeatureReviewRounds is 0", () => {
    expect(routeNext("verify", cfg("off", 0))).toEqual({ phase: "finish" });
  });
  test("review→finish when uatMode is off", () => {
    expect(routeNext("review", cfg("off", 1))).toEqual({ phase: "finish" });
  });
  test("review→uat when uatMode is after-review", () => {
    expect(routeNext("review", cfg("after-review", 1))).toEqual({ phase: "uat" });
  });
  test("finish→completed when uatMode is off", () => {
    expect(routeNext("finish", cfg("off", 1))).toEqual({ completed: true });
  });
  test("finish→uat when uatMode is after-finish", () => {
    expect(routeNext("finish", cfg("after-finish", 1))).toEqual({ phase: "uat" });
  });
  test("uat→finish when uatMode is off", () => {
    expect(routeNext("uat", cfg("off", 1))).toEqual({ phase: "finish" });
  });
  test("uat→completed when uatMode is after-finish", () => {
    expect(routeNext("uat", cfg("after-finish", 1))).toEqual({ completed: true });
  });
  test("returns null when there is no current phase", () => {
    expect(routeNext(null, cfg("off", 1))).toBeNull();
  });
});

describe("toRouteConfig (settings → config)", () => {
  test("maps uatMode + maxFeatureReviewRounds from settings", () => {
    const settings = { uatMode: "after-review", maxFeatureReviewRounds: 3 } as FeatureFlowSettings;
    expect(toRouteConfig(settings)).toEqual({ uatMode: "after-review", maxFeatureReviewRounds: 3 });
  });
});

describe("WorkflowRouter.completeCurrent (routing + pointer advance)", () => {
  let progression: PhaseProgression;
  let router: WorkflowRouter;

  beforeEach(() => {
    progression = new PhaseProgression();
    router = new WorkflowRouter(progression);
  });

  test("advances design→plan and moves the pointer", () => {
    progression.setCurrentPhase("design");
    expect(isPhaseActive(view(progression.getState()), "design")).toBe(true);

    const result = router.completeCurrent(cfg("off", 1));

    expect(result).toEqual({ phase: "plan" });
    expect(progression.getState().currentPhase).toBe("plan");
    expect(isPhaseDone(view(progression.getState()), "design")).toBe(true);
  });

  test("advances plan→implement", () => {
    progression.setCurrentPhase("plan");
    expect(router.completeCurrent(cfg("off", 1))).toEqual({ phase: "implement" });
    expect(progression.getState().currentPhase).toBe("implement");
  });

  test("routes implement/verify forward (two steps)", () => {
    progression.setCurrentPhase("implement");
    expect(router.completeCurrent(cfg("off", 1))).toEqual({ phase: "verify" });
    expect(progression.getState().currentPhase).toBe("verify");

    expect(router.completeCurrent(cfg("off", 1))).toEqual({ phase: "review" });
    expect(progression.getState().currentPhase).toBe("review");
  });

  test("skips review (verify→finish) when maxFeatureReviewRounds is off", () => {
    progression.setCurrentPhase("verify");
    expect(router.completeCurrent(cfg("off", 0))).toEqual({ phase: "finish" });
    expect(progression.getState().currentPhase).toBe("finish");
  });

  test("routes review→finish when uatMode is off", () => {
    progression.setCurrentPhase("review");
    expect(router.completeCurrent(cfg("off", 1))).toEqual({ phase: "finish" });
    expect(progression.getState().currentPhase).toBe("finish");
  });

  test("routes review→uat when uatMode is after-review", () => {
    progression.setCurrentPhase("review");
    expect(router.completeCurrent(cfg("after-review", 1))).toEqual({ phase: "uat" });
    expect(progression.getState().currentPhase).toBe("uat");
  });

  test("marks completed when finish→done and uatMode is off (pointer stays)", () => {
    progression.setCurrentPhase("finish");
    expect(router.completeCurrent(cfg("off", 1))).toEqual({ completed: true });
    expect(progression.getState().currentPhase).toBe("finish");
  });

  test("routes finish→uat when uatMode is after-finish", () => {
    progression.setCurrentPhase("finish");
    expect(router.completeCurrent(cfg("after-finish", 1))).toEqual({ phase: "uat" });
    expect(progression.getState().currentPhase).toBe("uat");
  });

  test("routes uat→finish when uatMode is off", () => {
    progression.setCurrentPhase("uat");
    expect(router.completeCurrent(cfg("off", 1))).toEqual({ phase: "finish" });
    expect(progression.getState().currentPhase).toBe("finish");
  });

  test("marks completed from uat when uatMode is after-finish", () => {
    progression.setCurrentPhase("uat");
    expect(router.completeCurrent(cfg("after-finish", 1))).toEqual({ completed: true });
  });

  test("returns null when there is no current phase (nothing to advance from)", () => {
    expect(router.completeCurrent(cfg("off", 1))).toBeNull();
    expect(progression.getState().currentPhase).toBeNull();
  });
});

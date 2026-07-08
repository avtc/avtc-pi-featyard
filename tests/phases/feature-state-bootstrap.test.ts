// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import type { Phase } from "../../src/phases/phase-progression.js";
import { isPhaseActive, isPhaseDone, isPhasePending } from "../../src/phases/phase-progression.js";
import { createFeatureStateFromKanban } from "../../src/state/feature-state.js";

function view(state: { workflow: { currentPhase: string | null }; completedAt: string | null }) {
  return { currentPhase: state.workflow.currentPhase as unknown as Phase, completedAt: state.completedAt };
}

describe("createFeatureStateFromKanban", () => {
  test("creates state at design phase for design lane feature", () => {
    const state = createFeatureStateFromKanban("test-feature", { lane: "design", branch: null, worktreePath: null });
    expect(state.featureSlug).toBe("test-feature");
    expect(isPhasePending(view(state), "design")).toBe(true);
    expect(state.workflow.currentPhase).toBeNull();
  });

  test("creates state with phases advanced for ready lane feature", () => {
    // ready lane → pointer at implement (design+plan derived done, implement active)
    const state = createFeatureStateFromKanban("test-feature", { lane: "ready", branch: null, worktreePath: null });
    expect(isPhaseDone(view(state), "design")).toBe(true);
    expect(isPhaseDone(view(state), "plan")).toBe(true);
    expect(isPhaseActive(view(state), "implement")).toBe(true);
    expect(state.workflow.currentPhase).toBe("implement");
  });

  test("creates state with phases advanced for in-progress lane feature", () => {
    // in-progress lane → pointer at implement (design+plan derived done, implement active)
    const state = createFeatureStateFromKanban("test-feature", {
      lane: "in-progress",
      branch: null,
      worktreePath: null,
    });
    expect(isPhaseDone(view(state), "design")).toBe(true);
    expect(isPhaseDone(view(state), "plan")).toBe(true);
    expect(isPhaseActive(view(state), "implement")).toBe(true);
    expect(state.workflow.currentPhase).toBe("implement");
  });

  test("creates state with all fields initialized", () => {
    const state = createFeatureStateFromKanban("test-feature", { lane: "backlog", branch: null, worktreePath: null });
    expect(state.completedAt).toBeNull();
    expect(state.design.doc).toBeNull();
    expect(state.plan.doc).toBeNull();
    expect(state.git.branch).toBeNull();
    expect(state.git.worktreePath).toBeNull();
    expect(state.sessionFiles).toEqual([]);
    // tdd/verification are session-only (GuardrailsState), no longer on FeatureState.
  });

  test("bootstraps branch from slug when branch option provided", () => {
    const state = createFeatureStateFromKanban("my-feature", {
      lane: "ready",
      branch: "feature/my-feature",
      worktreePath: null,
    });
    expect(state.git.branch).toBe("feature/my-feature");
    expect(state.git.worktreePath).toBeNull();
  });

  test("bootstraps worktreePath when provided", () => {
    const state = createFeatureStateFromKanban("my-feature", {
      lane: "in-progress",
      branch: "feature/my-feature",
      worktreePath: "/repo/.worktrees/my-feature",
    });
    expect(state.git.branch).toBe("feature/my-feature");
    expect(state.git.worktreePath).toBe("/repo/.worktrees/my-feature");
  });

  test("defaults branch and worktreePath to null when not provided", () => {
    const state = createFeatureStateFromKanban("my-feature", { lane: "ready", branch: null, worktreePath: null });
    expect(state.git.branch).toBeNull();
    expect(state.git.worktreePath).toBeNull();
  });

  test("design-approval lane creates state with default phases (kanban-only lane)", () => {
    const state = createFeatureStateFromKanban("test-feature", {
      lane: "design-approval",
      branch: null,
      worktreePath: null,
    });
    expect(isPhasePending(view(state), "design")).toBe(true);
    expect(isPhasePending(view(state), "plan")).toBe(true);
    expect(isPhasePending(view(state), "implement")).toBe(true);
    expect(state.workflow.currentPhase).toBeNull();
    expect(state.completedAt).toBeNull();
  });

  test("uat lane advances design through review phases and sets uat active", () => {
    // uat lane → pointer at uat (design..review derived done, uat active)
    const state = createFeatureStateFromKanban("test-feature", { lane: "uat", branch: null, worktreePath: null });
    expect(isPhaseDone(view(state), "design")).toBe(true);
    expect(isPhaseDone(view(state), "plan")).toBe(true);
    expect(isPhaseDone(view(state), "implement")).toBe(true);
    expect(isPhaseDone(view(state), "verify")).toBe(true);
    expect(isPhaseDone(view(state), "review")).toBe(true);
    expect(isPhaseActive(view(state), "uat")).toBe(true);
    expect(state.workflow.currentPhase).toBe("uat");
    expect(state.completedAt).toBeNull();
  });

  test("done lane marks all phases complete and status done", () => {
    // done lane → completedAt set (every phase derived done)
    const state = createFeatureStateFromKanban("test-feature", { lane: "done", branch: null, worktreePath: null });
    expect(isPhaseDone(view(state), "design")).toBe(true);
    expect(isPhaseDone(view(state), "plan")).toBe(true);
    expect(isPhaseDone(view(state), "implement")).toBe(true);
    expect(isPhaseDone(view(state), "verify")).toBe(true);
    expect(isPhaseDone(view(state), "review")).toBe(true);
    expect(isPhaseDone(view(state), "uat")).toBe(true);
    expect(isPhaseDone(view(state), "finish")).toBe(true);
    expect(state.completedAt).not.toBeNull();
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  createFeatureState,
  createFeatureStateFromKanban,
  createFeatureStateFromPlan,
  loadFeatureState,
  saveFeatureState,
} from "../../src/state/feature-state.js";
import { withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

describe("FeatureState featureId field", () => {
  it("createFeatureState includes featureId as null", () => {
    const state = createFeatureState("2026-05-16-test-feature", "docs/test-design.md");
    expect(state).toHaveProperty("featureId", null);
  });

  it("createFeatureStateFromPlan includes featureId as null", () => {
    const state = createFeatureStateFromPlan("2026-05-16-test-feature", "docs/test-plan.md");
    expect(state).toHaveProperty("featureId", null);
  });

  it("createFeatureStateFromKanban includes featureId", () => {
    const state = createFeatureStateFromKanban("2026-05-16-test-feature", {
      lane: "ready",
      branch: null,
      worktreePath: null,
    });
    expect(state).toHaveProperty("featureId", null);
  });

  it("featureId is persisted through save/load cycle", () => {
    withTempCwd();
    const state = createFeatureState("2026-05-16-kanban-id-test", "docs/test-design.md");
    state.featureId = 42;
    saveFeatureState(state, null);

    const loaded = loadFeatureState("2026-05-16-kanban-id-test", null);
    expect(loaded).not.toBeNull();
    expect(loaded?.featureId).toBe(42);
  });
});

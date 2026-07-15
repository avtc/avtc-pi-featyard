// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFeatureStateCache,
  createFeatureState,
  createFeatureStateFromKanban,
  createFeatureStateFromPlan,
  loadFeatureState,
  saveFeatureState,
} from "../../src/state/feature-state.js";

describe("FeatureState loop count fields", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-fs-"));
  });

  afterEach(() => {
    clearFeatureStateCache();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("createFeatureState initializes design.reviewLoopCount and plan.reviewLoopCount to 0", () => {
    const state = createFeatureState("test-feature", "docs/featyard/designs/test-feature-design.md");
    expect(state.design.reviewLoopCount).toBe(0);
    expect(state.plan.reviewLoopCount).toBe(0);
  });

  it("createFeatureStateFromPlan initializes design.reviewLoopCount and plan.reviewLoopCount to 0", () => {
    const state = createFeatureStateFromPlan("test-feature", ".featyard/task-plans/test-feature-task-plan.md");
    expect(state.design.reviewLoopCount).toBe(0);
    expect(state.plan.reviewLoopCount).toBe(0);
  });

  it("createFeatureStateFromKanban initializes design.reviewLoopCount and plan.reviewLoopCount to 0", () => {
    const state = createFeatureStateFromKanban("test-feature", {
      lane: "in-progress",
      branch: null,
      worktreePath: null,
    });
    expect(state.design.reviewLoopCount).toBe(0);
    expect(state.plan.reviewLoopCount).toBe(0);
  });

  it("loadFeatureState preserves existing design.reviewLoopCount and plan.reviewLoopCount", () => {
    const state = createFeatureState("test-feature", "docs/featyard/designs/test-feature-design.md");
    state.design.reviewLoopCount = 3;
    state.plan.reviewLoopCount = 2;
    saveFeatureState(state, tmpDir);

    const loaded = loadFeatureState("test-feature", tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.design.reviewLoopCount).toBe(3);
    expect(loaded?.plan.reviewLoopCount).toBe(2);
  });
});

describe("FeatureState verify loop count fields", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-fs-verify-"));
  });

  afterEach(() => {
    clearFeatureStateCache();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("createFeatureState initializes verify.verifyLoopCount, plan.verifyLoopCount to defaults", () => {
    const state = createFeatureState("test-feature", "docs/featyard/designs/test-feature-design.md");
    expect(state.verify.verifyLoopCount).toBe(0);
    expect(state.plan.verifyLoopCount).toBe(0);
    expect(state.implement.taskReviewRounds).toEqual({});
  });

  it("createFeatureStateFromPlan initializes verify loop fields to defaults", () => {
    const state = createFeatureStateFromPlan("test-feature", ".featyard/task-plans/test-feature-task-plan.md");
    expect(state.verify.verifyLoopCount).toBe(0);
    expect(state.plan.verifyLoopCount).toBe(0);
    expect(state.implement.taskReviewRounds).toEqual({});
  });

  it("createFeatureStateFromKanban initializes verify loop fields to defaults", () => {
    const state = createFeatureStateFromKanban("test-feature", {
      lane: "in-progress",
      branch: null,
      worktreePath: null,
    });
    expect(state.verify.verifyLoopCount).toBe(0);
    expect(state.plan.verifyLoopCount).toBe(0);
    expect(state.implement.taskReviewRounds).toEqual({});
  });

  it("verify.verifyLoopCount persists and loads correctly", () => {
    const state = createFeatureState("test-feature", "docs/featyard/designs/test-feature-design.md");
    state.verify.verifyLoopCount = 3;
    saveFeatureState(state, tmpDir);

    const loaded = loadFeatureState("test-feature", tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.verify.verifyLoopCount).toBe(3);
  });

  it("plan.verifyLoopCount persists and loads correctly", () => {
    const state = createFeatureState("test-feature", "docs/featyard/designs/test-feature-design.md");
    state.plan.verifyLoopCount = 2;
    saveFeatureState(state, tmpDir);

    const loaded = loadFeatureState("test-feature", tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.plan.verifyLoopCount).toBe(2);
  });

  it("taskReviewRounds keys default to absent (count derived on first review)", () => {
    const state = createFeatureState("test-feature", "docs/featyard/designs/test-feature-design.md");
    state.implement.taskReviewRounds = {};
    saveFeatureState(state, tmpDir);

    const loaded = loadFeatureState("test-feature", tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.implement.taskReviewRounds["1-first-task"]).toBeUndefined();
  });
});

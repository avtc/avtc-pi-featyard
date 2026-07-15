// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFeatureStateCache,
  createFeatureState,
  createFeatureStateFromPlan,
  loadFeatureState,
  type ReviewHistoryEntry,
  recordReviewHistory,
  saveFeatureState,
} from "../../src/state/feature-state.js";

const TEMP_DIRS: string[] = [];
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-state-review-"));
  TEMP_DIRS.push(dir);
  process.chdir(dir);
});

afterEach(() => {
  clearFeatureStateCache();
  process.chdir(ORIGINAL_CWD);
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("FeatureState review fields", () => {
  it("createFeatureState includes reviewLoopCount=0 and empty reviewHistory", () => {
    const state = createFeatureState("2026-05-11-test", "docs/featyard/designs/2026-05-11-test-design.md");
    expect(state.review.reviewLoopCount).toBe(0);
    expect(state.review.reviewHistory).toEqual([]);
  });

  it("createFeatureStateFromPlan includes reviewLoopCount=0 and empty reviewHistory", () => {
    const state = createFeatureStateFromPlan("2026-05-11-test", ".featyard/task-plans/2026-05-11-test-task-plan.md");
    expect(state.review.reviewLoopCount).toBe(0);
    expect(state.review.reviewHistory).toEqual([]);
  });

  it("reviewLoopCount and reviewHistory persist to disk and reload", () => {
    const state = createFeatureState("2026-05-11-test", "docs/featyard/designs/2026-05-11-test-design.md");
    state.review.reviewLoopCount = 2;
    state.review.reviewHistory = [
      {
        phase: "review",
        loopNumber: 1,
        issuesFound: 3,
        falsePositives: 2,
        cannotFixIssues: 0,
        timestamp: "2026-05-11T22:00:00.000Z",
      },
    ];
    saveFeatureState(state, null);
    const loaded = loadFeatureState("2026-05-11-test", null);
    expect(loaded?.review.reviewLoopCount).toBe(2);
    expect(loaded?.review.reviewHistory).toHaveLength(1);
    expect(loaded?.review.reviewHistory[0].phase).toBe("review");
    expect(loaded?.review.reviewHistory[0].loopNumber).toBe(1);
    expect(loaded?.review.reviewHistory[0].issuesFound).toBe(3);
    expect(loaded?.review.reviewHistory[0].falsePositives).toBe(2);
    expect(loaded?.review.reviewHistory[0].cannotFixIssues).toBe(0);
  });

  it("ReviewHistoryEntry type accepts all expected fields", () => {
    const entry: ReviewHistoryEntry = {
      phase: "plan",
      loopNumber: 3,
      issuesFound: 6,
      falsePositives: 2,
      cannotFixIssues: 1,
      timestamp: "2026-05-11T23:00:00.000Z",
    };
    expect(entry.phase).toBe("plan");
    expect(entry.loopNumber).toBe(3);
    expect(entry.cannotFixIssues).toBe(1);
  });

  it("reviewHistory with multiple entries persists correctly", () => {
    const state = createFeatureState("2026-05-11-test", "docs/featyard/designs/2026-05-11-test-design.md");
    state.review.reviewLoopCount = 3;
    state.review.reviewHistory = [
      {
        phase: "design",
        loopNumber: 1,
        issuesFound: 3,
        falsePositives: 2,
        cannotFixIssues: 0,
        timestamp: "2026-05-11T22:00:00.000Z",
      },
      {
        phase: "design",
        loopNumber: 2,
        issuesFound: 1,
        falsePositives: 1,
        cannotFixIssues: 0,
        timestamp: "2026-05-11T22:30:00.000Z",
      },
      {
        phase: "design",
        loopNumber: 3,
        issuesFound: 0,
        falsePositives: 0,
        cannotFixIssues: 0,
        timestamp: "2026-05-11T23:00:00.000Z",
      },
    ];
    saveFeatureState(state, null);
    const loaded = loadFeatureState("2026-05-11-test", null);
    expect(loaded?.review.reviewLoopCount).toBe(3);
    expect(loaded?.review.reviewHistory).toHaveLength(3);
    expect(loaded?.review.reviewHistory[2].issuesFound).toBe(0);
  });

  it("recordReviewHistory caps at MAX_REVIEW_HISTORY entries", () => {
    const state = createFeatureState("2026-05-11-test", "docs/featyard/designs/2026-05-11-test-design.md");

    // Add 102 entries to exceed the cap (100)
    for (let i = 0; i < 102; i++) {
      recordReviewHistory(state, {
        phase: "review",
        loopNumber: i,
        issuesFound: 0,
        falsePositives: 0,
        cannotFixIssues: 0,
      });
    }

    // Should be capped at 100
    expect(state.review.reviewHistory).toHaveLength(100);
    // Oldest entries (0, 1) should be pruned, keeping 2-101
    expect(state.review.reviewHistory[0].loopNumber).toBe(2);
    expect(state.review.reviewHistory[99].loopNumber).toBe(101);
  });
});

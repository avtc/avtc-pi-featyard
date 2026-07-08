// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { EmptyLoopTracker } from "../../src/review/review-empty-loop-tracking.js";

describe("EmptyLoopTracker", () => {
  it("starts with zero empty loops for unknown slug", () => {
    const tracker = new EmptyLoopTracker();
    expect(tracker.getEmptyLoopsForSlug("unknown-slug")).toEqual({});
  });

  it("increments empty loop count for a reviewer", () => {
    const tracker = new EmptyLoopTracker();
    tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
    expect(tracker.getEmptyLoopsForSlug("slug-1")).toEqual({ "ff-quality-reviewer": 1 });
  });

  it("increments empty loop count multiple times", () => {
    const tracker = new EmptyLoopTracker();
    tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
    tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
    tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
    expect(tracker.getEmptyLoopsForSlug("slug-1")).toEqual({ "ff-quality-reviewer": 3 });
  });

  it("tracks multiple reviewers independently", () => {
    const tracker = new EmptyLoopTracker();
    tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
    tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
    tracker.incrementEmptyLoop("slug-1", "ff-testing-reviewer");
    expect(tracker.getEmptyLoopsForSlug("slug-1")).toEqual({
      "ff-quality-reviewer": 2,
      "ff-testing-reviewer": 1,
    });
  });

  it("tracks multiple slugs independently", () => {
    const tracker = new EmptyLoopTracker();
    tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
    tracker.incrementEmptyLoop("slug-2", "ff-quality-reviewer");
    expect(tracker.getEmptyLoopsForSlug("slug-1")).toEqual({ "ff-quality-reviewer": 1 });
    expect(tracker.getEmptyLoopsForSlug("slug-2")).toEqual({ "ff-quality-reviewer": 1 });
    expect(tracker.getReviewerEmptyLoops()).toEqual({
      "slug-1": { "ff-quality-reviewer": 1 },
      "slug-2": { "ff-quality-reviewer": 1 },
    });
  });

  it("resets empty loop count for a specific reviewer", () => {
    const tracker = new EmptyLoopTracker();
    tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
    tracker.incrementEmptyLoop("slug-1", "ff-testing-reviewer");
    tracker.resetEmptyLoop("slug-1", "ff-quality-reviewer");
    expect(tracker.getEmptyLoopsForSlug("slug-1")).toEqual({ "ff-testing-reviewer": 1 });
  });

  it("resets all empty loops", () => {
    const tracker = new EmptyLoopTracker();
    tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
    tracker.incrementEmptyLoop("slug-2", "ff-testing-reviewer");
    tracker.resetAllEmptyLoops();
    expect(tracker.getReviewerEmptyLoops()).toEqual({});
  });

  describe("isReviewerSkipped", () => {
    it("returns false when threshold is 0 (disabled)", () => {
      const tracker = new EmptyLoopTracker();
      tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
      tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
      expect(tracker.isReviewerSkipped("slug-1", "ff-quality-reviewer", 0)).toBe(false);
    });

    it("returns false when count is below threshold", () => {
      const tracker = new EmptyLoopTracker();
      tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
      expect(tracker.isReviewerSkipped("slug-1", "ff-quality-reviewer", 3)).toBe(false);
    });

    it("returns true when count meets threshold", () => {
      const tracker = new EmptyLoopTracker();
      tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
      tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
      expect(tracker.isReviewerSkipped("slug-1", "ff-quality-reviewer", 2)).toBe(true);
    });

    it("returns true when count exceeds threshold", () => {
      const tracker = new EmptyLoopTracker();
      tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
      tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
      tracker.incrementEmptyLoop("slug-1", "ff-quality-reviewer");
      expect(tracker.isReviewerSkipped("slug-1", "ff-quality-reviewer", 2)).toBe(true);
    });

    it("returns false for unknown reviewer", () => {
      const tracker = new EmptyLoopTracker();
      expect(tracker.isReviewerSkipped("slug-1", "ff-quality-reviewer", 2)).toBe(false);
    });
  });
});

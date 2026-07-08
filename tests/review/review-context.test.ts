// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { isReviewPhase, reviewSkillName, toDisplayLoopNumber } from "../../src/review/review-context.js";

/**
 * Unit tests for the pure helpers exported from review-context.ts:
 * toDisplayLoopNumber (loop-count display math) and the review-phase helpers
 * (isReviewPhase, reviewSkillName) shared by the substitution pipeline and
 * phase-ready dispatch.
 */

describe("toDisplayLoopNumber", () => {
  it("converts raw iteration count to 0-indexed display number", () => {
    // Raw count 1 = first iteration started → display as iteration #0.
    expect(toDisplayLoopNumber(1)).toBe(0);
    expect(toDisplayLoopNumber(5)).toBe(4);
  });

  it("clamps to 0 when raw count has not started yet", () => {
    expect(toDisplayLoopNumber(0)).toBe(0);
  });

  it("clamps negative counts to 0 (defensive)", () => {
    expect(toDisplayLoopNumber(-3)).toBe(0);
  });
});

describe("isReviewPhase", () => {
  it("returns true for design and plan phases", () => {
    expect(isReviewPhase("design")).toBe(true);
    expect(isReviewPhase("plan")).toBe(true);
  });

  it("returns false for non-review phases", () => {
    expect(isReviewPhase("implement")).toBe(false);
    expect(isReviewPhase("verify")).toBe(false);
    expect(isReviewPhase("review")).toBe(false);
    expect(isReviewPhase("finish")).toBe(false);
  });

  it("returns false when phase is undefined", () => {
    expect(isReviewPhase(undefined)).toBe(false);
  });
});

describe("reviewSkillName", () => {
  it("maps design phase to design-review skill", () => {
    expect(reviewSkillName("design")).toBe("ff-design-review");
  });

  it("maps plan phase to plan-review skill", () => {
    expect(reviewSkillName("plan")).toBe("ff-plan-review");
  });
});

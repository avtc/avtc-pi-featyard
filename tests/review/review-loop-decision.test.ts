// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { resolveReviewLoopDecision } from "../../src/index.js";

describe("resolveReviewLoopDecision", () => {
  test("returns shouldLoop=false when maxFeatureReviewRounds is 0 (disabled)", () => {
    const result = resolveReviewLoopDecision({ reviewLoops: 0, minReviewLoops: 0 }, 0, 1);
    expect(result).toEqual({ shouldLoop: false });
  });

  test("maxFeatureReviewRounds=0 disables minReviewLoops (min is ignored even when set)", () => {
    // reviewLoops=0 → no looping regardless of minReviewLoops
    const result = resolveReviewLoopDecision({ reviewLoops: 0, minReviewLoops: 3 }, 0, 1);
    expect(result).toEqual({ shouldLoop: false });
  });

  test("returns shouldLoop=true when real issues exist and loops remaining", () => {
    const result = resolveReviewLoopDecision({ reviewLoops: 3, minReviewLoops: 0 }, 0, 1);
    expect(result).toEqual({ shouldLoop: true });
  });

  test("returns shouldLoop=false when no real issues and min met", () => {
    const result = resolveReviewLoopDecision({ reviewLoops: 3, minReviewLoops: 0 }, 0, 0);
    expect(result).toEqual({ shouldLoop: false });
  });

  test("returns shouldLoop=true when no real issues but min not met", () => {
    const result = resolveReviewLoopDecision({ reviewLoops: 3, minReviewLoops: 2 }, 0, 0);
    expect(result).toEqual({ shouldLoop: true });
  });

  test("returns shouldLoop=false when max numeric loops reached", () => {
    // currentLoop=2 means 3 loops completed (0-indexed), maxFeatureReviewRounds=3
    const result = resolveReviewLoopDecision({ reviewLoops: 3, minReviewLoops: 0 }, 2, 1);
    expect(result).toEqual({ shouldLoop: false });
  });

  test("minReviewLoops raises ceiling above maxFeatureReviewRounds", () => {
    // maxFeatureReviewRounds=1, minReviewLoops=3 → effectiveMax=max(1,3)=3
    // currentLoop=0 → loopsCompleted=1 < 3 → should loop even with 0 issues
    const result = resolveReviewLoopDecision({ reviewLoops: 1, minReviewLoops: 3 }, 0, 0);
    expect(result).toEqual({ shouldLoop: true });
  });

  test("minReviewLoops ceiling stops when reached", () => {
    // maxFeatureReviewRounds=1, minReviewLoops=3 → effectiveMax=3
    // currentLoop=2 → loopsCompleted=3 >= 3 → stop
    const result = resolveReviewLoopDecision({ reviewLoops: 1, minReviewLoops: 3 }, 2, 0);
    expect(result).toEqual({ shouldLoop: false });
  });
});

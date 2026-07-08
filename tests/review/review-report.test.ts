// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { generateReviewReport, getReportableReviewHistory } from "../../src/review/review-report.js";
import type { FeatureState, ReviewHistoryEntry } from "../../src/state/feature-state.js";

function makeFeatureState(reviewHistory: FeatureState["review"]["reviewHistory"]): FeatureState {
  return {
    featureSlug: "test-feature",
    review: { reviewLoopCount: 0, reviewHistory },
  } as FeatureState;
}

function entry(
  phase: "design" | "plan" | "review",
  loopNumber: number,
  issuesFound: number,
  falsePositives: number,
  cannotFixIssues: number,
) {
  return {
    phase,
    loopNumber,
    issuesFound,
    falsePositives,
    cannotFixIssues,
    timestamp: "2026-06-07T10:00:00Z",
  };
}

describe("generateReviewReport", () => {
  test("empty history produces header and zero totals", () => {
    const report = generateReviewReport(makeFeatureState([]));

    expect(report).toContain("Review Round Summary");
    expect(report).toContain("Totals: 0 issues found across 0 rounds");
    expect(report).toContain("False positives: 0");
    // Cannot-fix should NOT appear when total is 0
    expect(report).not.toContain("Cannot fix");
    // No "Fixed" line (field removed)
    expect(report).not.toContain("Fixed:");
  });

  test("single code-review phase: per-round lines + per-phase total, Round naming", () => {
    const report = generateReviewReport(
      makeFeatureState([entry("review", 0, 5, 1, 1), entry("review", 1, 3, 1, 1), entry("review", 2, 2, 0, 0)]),
    );

    expect(report).toContain("Code Review");
    expect(report).toContain("Round #0: 5 issues found, 1 false positive, 1 cannot-fix");
    expect(report).toContain("Round #1: 3 issues found, 1 false positive, 1 cannot-fix");
    expect(report).toContain("Round #2: 2 issues found, 0 false positives, 0 cannot-fix");
    expect(report).toContain("Code Review total: 10 issues found, 2 false positives, 2 cannot-fix");
    expect(report).toContain("Totals: 10 issues found across 3 rounds");
    expect(report).toContain("False positives: 2");
    expect(report).toContain("⚠️ Cannot fix: 2");
  });

  test("phases grouped in design → plan → review order with per-phase totals", () => {
    const report = generateReviewReport(
      makeFeatureState([
        entry("review", 0, 2, 0, 0),
        entry("plan", 0, 4, 0, 0),
        entry("design", 0, 6, 0, 0),
        entry("design", 1, 6, 0, 0),
      ]),
    );

    // Design section before plan before review (phase order), regardless of insertion order
    const designIdx = report.indexOf("Design Review");
    const planIdx = report.indexOf("Plan Review");
    const reviewIdx = report.indexOf("Code Review");
    expect(designIdx).toBeLessThan(planIdx);
    expect(planIdx).toBeLessThan(reviewIdx);

    expect(report).toContain("Design Review total: 12 issues found, 0 false positives, 0 cannot-fix");
    expect(report).toContain("Plan Review total: 4 issues found, 0 false positives, 0 cannot-fix");
    expect(report).toContain("Code Review total: 2 issues found, 0 false positives, 0 cannot-fix");
    expect(report).toContain("Totals: 18 issues found across 4 rounds");
  });

  test("design/plan entries carry real falsePositives/cannotFix (no longer hardcoded 0)", () => {
    const report = generateReviewReport(makeFeatureState([entry("design", 0, 3, 2, 1), entry("plan", 0, 4, 1, 2)]));

    expect(report).toContain("Design Review total: 3 issues found, 2 false positives, 1 cannot-fix");
    expect(report).toContain("Plan Review total: 4 issues found, 1 false positive, 2 cannot-fix");
    expect(report).toContain("⚠️ Cannot fix: 3");
  });

  test("legacy untagged entries are excluded entirely", () => {
    // Legacy entries (no phase) — cast to simulate pre-tagging on-disk data
    const legacy = [
      { loopNumber: 0, issuesFound: 6, falsePositives: 0, cannotFixIssues: 0, timestamp: "t" },
      { loopNumber: 1, issuesFound: 6, falsePositives: 0, cannotFixIssues: 0, timestamp: "t" },
    ] as unknown as FeatureState["review"]["reviewHistory"];

    const report = generateReviewReport(makeFeatureState(legacy));

    expect(report).toContain("Review Round Summary");
    expect(report).toContain("Totals: 0 issues found across 0 rounds");
    expect(report).not.toContain("Round #");
    expect(report).not.toContain("Code Review");
  });

  test("mixed: tagged entries shown, legacy excluded", () => {
    const mixed = [
      ...([
        { loopNumber: 0, issuesFound: 6, falsePositives: 0, cannotFixIssues: 0, timestamp: "t" },
      ] as unknown as FeatureState["review"]["reviewHistory"]),
      entry("review", 0, 2, 0, 0),
    ];
    const report = generateReviewReport(makeFeatureState(mixed));

    expect(report).toContain("Code Review");
    expect(report).toContain("Round #0: 2 issues found, 0 false positives, 0 cannot-fix");
    expect(report).toContain("Totals: 2 issues found across 1 round");
  });

  test("singular forms: 1 issue / 1 round / 1 false positive", () => {
    const report = generateReviewReport(makeFeatureState([entry("review", 0, 1, 1, 0)]));

    expect(report).toContain("Round #0: 1 issue found, 1 false positive, 0 cannot-fix");
    expect(report).toContain("Totals: 1 issue found across 1 round");
  });

  test("no markdown markers (plain-text notify rendering)", () => {
    const report = generateReviewReport(makeFeatureState([entry("review", 0, 2, 0, 1)]));

    expect(report).not.toContain("##");
    expect(report).not.toContain("**");
    expect(report).not.toMatch(/^\s*-\s/m);
  });

  test("handles reviewHistory = undefined gracefully", () => {
    const state = makeFeatureState([]);
    state.review.reviewHistory = undefined as unknown as ReviewHistoryEntry[];
    const report = generateReviewReport(state);

    expect(report).toContain("Review Round Summary");
    expect(report).toContain("Totals: 0 issues found across 0 rounds");
  });

  test("handles reviewHistory = null gracefully", () => {
    const state = makeFeatureState([]);
    state.review.reviewHistory = null as unknown as ReviewHistoryEntry[];
    const report = generateReviewReport(state);

    expect(report).toContain("Review Round Summary");
    expect(report).toContain("Totals: 0 issues found across 0 rounds");
  });
});

describe("getReportableReviewHistory", () => {
  test("returns only tagged entries, drops legacy", () => {
    const mixed = [
      { loopNumber: 0, issuesFound: 6, falsePositives: 0, cannotFixIssues: 0, timestamp: "t" },
      entry("design", 0, 1, 0, 0),
      entry("review", 0, 2, 0, 1),
    ] as unknown as FeatureState["review"]["reviewHistory"];

    const reportable = getReportableReviewHistory(makeFeatureState(mixed));
    expect(reportable).toHaveLength(2);
    expect(reportable.every((e) => e.phase === "design" || e.phase === "plan" || e.phase === "review")).toBe(true);
  });

  test("cannot-fix level scan over reportable history (legacy excluded)", () => {
    // Legacy entry has cannot-fix but must be excluded from the level scan
    const mixed = [
      { loopNumber: 0, issuesFound: 1, falsePositives: 0, cannotFixIssues: 1, timestamp: "t" },
      entry("review", 0, 0, 0, 0),
    ] as unknown as FeatureState["review"]["reviewHistory"];

    const hasCannotFix = getReportableReviewHistory(makeFeatureState(mixed)).some((e) => e.cannotFixIssues > 0);
    expect(hasCannotFix).toBe(false);
  });
});

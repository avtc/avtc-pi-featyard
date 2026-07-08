// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Review report generation.
 *
 * Produces a plain-text summary of review-round history from feature state.
 *
 * History partitioning: every entry carries a `phase` tag (design | plan | review).
 * The report groups entries by phase (in phase order) and shows a per-phase subtotal,
 * then overall totals. Entries that predate phase tagging (legacy) lack the tag and
 * are excluded entirely — they cannot be reliably attributed to a phase.
 *
 * NOTE: the report is delivered via `ui.notify`, which renders PLAIN TEXT (a single
 * Text component, no markdown parsing). Do not use markdown markers (##, **, |, -).
 */

import type { FeatureState, ReviewHistoryEntry, ReviewPhase } from "../state/feature-state.js";

const PHASE_ORDER: ReviewPhase[] = ["design", "plan", "review"];

const PHASE_LABEL: Record<ReviewPhase, string> = {
  design: "Design Review",
  plan: "Plan Review",
  review: "Code Review",
};

/** A tagged entry belongs to a known review phase. Legacy entries (no phase) are excluded. */
function isTaggedEntry(entry: ReviewHistoryEntry): entry is ReviewHistoryEntry & { phase: ReviewPhase } {
  return entry.phase === "design" || entry.phase === "plan" || entry.phase === "review";
}

/**
 * Entries that carry a phase tag and thus appear in reports. Legacy untagged entries
 * (from before phase tagging) are excluded — they cannot be reliably attributed to a
 * phase and would misattribute stats. Shared by the report and the cannot-fix level scan
 * so they stay consistent.
 */
export function getReportableReviewHistory(featureState: FeatureState): ReviewHistoryEntry[] {
  return (featureState.review.reviewHistory ?? []).filter(isTaggedEntry);
}

/** `1 issue` / `2 issues`, `1 false positive` / `2 false positives`. */
function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

/** Format one count line: `5 issues found, 1 false positive, 2 cannot-fix`. */
function formatCounts(issues: number, falsePositives: number, cannotFix: number): string {
  return (
    `${issues} ${plural(issues, "issue", "issues")} found, ` +
    `${falsePositives} ${plural(falsePositives, "false positive", "false positives")}, ` +
    `${cannotFix} cannot-fix`
  );
}

export function generateReviewReport(featureState: FeatureState): string {
  const history = getReportableReviewHistory(featureState);
  const lines: string[] = ["Review Round Summary"];

  let totalIssues = 0;
  let totalFalsePositives = 0;
  let totalCannotFix = 0;

  for (const phase of PHASE_ORDER) {
    const entries = history.filter((e) => e.phase === phase);
    if (entries.length === 0) continue;

    const label = PHASE_LABEL[phase];
    lines.push("");
    lines.push(label);

    let phaseIssues = 0;
    let phaseFalsePositives = 0;
    let phaseCannotFix = 0;
    for (const entry of entries) {
      lines.push(
        `  Round #${entry.loopNumber}: ${formatCounts(entry.issuesFound, entry.falsePositives, entry.cannotFixIssues)}`,
      );
      phaseIssues += entry.issuesFound;
      phaseFalsePositives += entry.falsePositives;
      phaseCannotFix += entry.cannotFixIssues;
    }
    lines.push(`  ${label} total: ${formatCounts(phaseIssues, phaseFalsePositives, phaseCannotFix)}`);

    totalIssues += phaseIssues;
    totalFalsePositives += phaseFalsePositives;
    totalCannotFix += phaseCannotFix;
  }

  lines.push("");
  lines.push(
    `Totals: ${totalIssues} ${plural(totalIssues, "issue", "issues")} found across ${history.length} ${plural(history.length, "round", "rounds")}`,
  );
  lines.push(`  False positives: ${totalFalsePositives}`);
  if (totalCannotFix > 0) {
    lines.push(`  ⚠️ Cannot fix: ${totalCannotFix}`);
  }

  return lines.join("\n");
}

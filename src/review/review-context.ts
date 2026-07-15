// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Review iteration context helpers.
 *
 * Small shared utilities consumed by the placeholder substitution pipeline
 * and phase dispatch: review-method strings, the display loop-number
 * transform, phase→review-skill-name mapping, and the review-phase guard.
 */

import type { Phase } from "../phases/phase-progression.js";

/**
 * Check if a task is a commit task (not a review fix task).
 */
export function isCommitTask(task: { name: string | null; result: string | null }): boolean {
  return task.result === "committed" || /Commit:/.test(task.name ?? "");
}

/**
 * Convert a raw "iterations started" review loop count (1-indexed: 1 = first
 * iteration has started) into the 0-indexed "iteration being reviewed" display
 * number. Clamped at 0 to avoid negatives. Centralized so the off-by-one is
 * defined once across phase-ready and the substitution pipeline.
 */
export function toDisplayLoopNumber(rawCount: number): number {
  return Math.max(0, rawCount - 1);
}

/** True for the two phases that drive design/plan review loops. Undefined-safe. */
export function isReviewPhase(phase: Phase | undefined): phase is "design" | "plan" {
  return phase === "design" || phase === "plan";
}

export function reviewSkillName(phase: "design" | "plan"): "fy-design-review" | "fy-plan-review" {
  return phase === "design" ? "fy-design-review" : "fy-plan-review";
}

/**
 * Compute the review method string for design/plan review iteration skills.
 */
export function computeReviewMethod(isDesign: boolean, settings: { planReviewMode: string }): string {
  const mode = settings.planReviewMode;
  if (mode === "parallel-subagents") {
    if (isDesign) {
      return "Dispatch reviewer: `subagent({ agent: 'fy-design-reviewer', task: 'Review the design document for design mistakes. Read the design doc and relevant project files, then output findings following the fy-design-review skill format.' })`";
    } else {
      return "Dispatch reviewer: `subagent({ agent: 'fy-plan-reviewer', task: 'Review the implementation plan against the design document for gaps, inconsistencies, and mistakes. Read both documents and relevant project files, then output findings.' })`";
    }
  }
  if (isDesign) {
    return "Read the full assembled design document carefully. Review for logical consistency (contradictions, missing transitions, circular deps), architectural soundness (abstraction boundaries, reinvented solutions, coupling), design clarity (vague specs, missing interfaces), feasibility & scope (too large, unrelated concerns), and common-sense (over/under-engineering). Output findings with severity and suggested resolutions, plus a scope assessment.";
  }
  return "Read the design document and implementation plan. Review the plan against the design for: inconsistencies, gaps, missing pieces, incorrect steps, unclear instructions.";
}

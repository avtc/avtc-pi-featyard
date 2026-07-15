// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Compaction message building.
 *
 * The compact-handler (compaction.ts) assembles ONE followUp message from parts:
 *   [skill block] + [framing line] + [caller note] + [✅ completedId] + [In progress item]
 *
 * This module provides the skill block and the framing line. The skill reference is passed
 * through expandSkillCommand, which resolves all `{{PI_FY_*}}` placeholders (including
 * review-iteration context for fy-design-review/fy-plan-review skills) — no post-hoc substitution needed.
 *
 * Framing is owned here (single source of truth) so callers never restate it, which is what
 * caused the old duplicate-skill / double-framing in the stored-message path.
 */

import { NO_AGENT_NAME, NO_FEATURE_STATE_OVERRIDE } from "../shared/workflow-refs.js";
import type { ExpandSkillCommandFn } from "../state/feature-state.js";

/** Whether a skill is a review-iteration skill (gets a review-specific framing). */
function isReviewSkill(skill: string | null | undefined): boolean {
  return skill === "fy-design-review" || skill === "fy-plan-review";
}

/**
 * The single compaction framing line, always emitted once. Declarative ("Reminder of planned
 * work") with an appended precedence directive so the agent prioritizes the user's most recent
 * instruction over this auto-injected follow-up (prevents the verbose skill block from burying a
 * concurrent user steer).
 * - review skill → "Context was compacted. Reminder of planned work: continue the review from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive."
 * - phase skill  → "Context was compacted. Reminder of planned work: you are in ${phase} phase; continue from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive."
 * - no skill     → "Context was compacted. Reminder of planned work: continue from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive."
 */
export function buildCompactFraming(skill: string | null | undefined, phase: string | undefined): string {
  if (isReviewSkill(skill)) {
    return "Context was compacted. Reminder of planned work: continue the review from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive.";
  }
  if (phase) {
    return `Context was compacted. Reminder of planned work: you are in ${phase} phase; continue from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive.`;
  }
  return "Context was compacted. Reminder of planned work: continue from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive.";
}

/** The expanded `<skill>` block for the given skill, or "" when there is no skill. */
export function buildCompactSkillBlock(
  skill: string | null | undefined,
  expandSkillCommand: ExpandSkillCommandFn,
): string {
  if (!skill) return "";
  return expandSkillCommand(`/skill:${skill}`, NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME);
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Review iteration counter — single source of truth for incrementing the
 * design/plan review loop counter and persisting feature state.
 *
 * Used by both the code-driven path (phase_ready handler) and the manual
 * invocation path (events/input/, when the user types /skill:ff-design-review or
 * /skill:ff-plan-review). Compaction recovery does NOT use this — it resumes the
 * current iteration rather than starting a new one.
 */

import { log } from "../log.js";
import type { FeatureSession } from "../state/feature-session.js";
import { DEFAULT_DIR, type FeatureState, saveFeatureState } from "../state/feature-state.js";

/** Marks the review loop as active when persisting a new iteration counter. */
const REVIEW_ACTIVE = true;

/** Map a review phase to its phase-data object. Single source of truth for the
 *  phase→object mapping (used by startReviewIteration). */
export function reviewPhaseData(phase: "design" | "plan"): "design" | "plan" {
  return phase;
}

/** Back-compat alias retained for callers that still reference the field selector. */
export function reviewLoopStateField(phase: "design" | "plan"): "design" | "plan" {
  return phase;
}

/**
 * Start a new review iteration: increment the phase's review loop counter, mark
 * the review as active, and persist feature state.
 *
 * @param featureState - Pre-loaded state to mutate (e.g. one that already carries
 *   unsaved mutations such as recorded review history). Pass `null`
 *   (NO_FEATURE_STATE_OVERRIDE) to load fresh from disk. Either way it is saved
 *   after incrementing.
 *
 * @returns the saved FeatureState (with the incremented counter), or `null` if no
 *   feature state exists (counter unchanged). Callers reuse the returned state for
 *   downstream env/widget sync to avoid a redundant disk read.
 */
export function startReviewIteration(
  handler: FeatureSession,
  slug: string,
  phase: "design" | "plan",
  featureState: FeatureState | null,
): FeatureState | null {
  const state = featureState ?? handler.getActiveFeatureState();
  if (!state) {
    log.warn(`startReviewIteration: no feature state for '${slug}' — counter unchanged`);
    return null;
  }

  const obj = phase === "design" ? state.design : state.plan;
  const current = obj.reviewLoopCount ?? 0;
  obj.reviewLoopCount = current + 1;
  obj.reviewActive = REVIEW_ACTIVE;
  handler.setReviewActiveFlag(phase, REVIEW_ACTIVE);
  saveFeatureState(state, DEFAULT_DIR);

  log.info(`[workflow] startReviewIteration: phase=${phase} slug=${slug} counter ${current}→${current + 1}`);
  return state;
}

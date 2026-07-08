// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * WorkflowRouter — sub-loop-aware phase routing policy.
 *
 * Owns the "advance one step" routing decision (review/UAT-aware per settings),
 * kept separate from PhaseProgression (pure pointer math: advance/jump/status/
 * derive). The router reads the current pointer from a PhaseProgression, decides
 * the next phase via {@link routeNext}, and applies the move via the progression's
 * setCurrentPhase — keeping the pointer as the single phase-state source.
 *
 * Routing order: design→plan→implement→verify→{review?}→{uat?}→finish→{uat?}→done.
 * The review phase is skipped when `maxFeatureReviewRounds` is 0. UAT position is
 * honored per `uatMode`.
 */

import { log } from "../log.js";
import type { FeatureFlowSettings } from "../settings/settings-ui.js";
import type { Phase, PhaseProgression } from "./phase-progression.js";

export type UatMode = "after-review" | "after-finish" | "off";

/** Whether/how many feature-review rounds run; 0 skips the review phase entirely. */
export type MaxFeatureReviewRounds = number;

/** Routing configuration derived from feature-flow settings. The machine routes one
 *  step per extension advance, honoring both the UAT position and whether the review
 *  phase is enabled. */
export interface RouteConfig {
  uatMode: UatMode;
  maxFeatureReviewRounds: MaxFeatureReviewRounds;
}

/** Build the routing config from feature-flow settings. Centralizes the field selection so
 *  every phase-advance call site stays in sync with the settings rename. */
export function toRouteConfig(settings: FeatureFlowSettings): RouteConfig {
  return {
    uatMode: settings.uatMode,
    maxFeatureReviewRounds: settings.maxFeatureReviewRounds,
  };
}

/** Result of routing: advance to a phase, or mark the feature completed. */
export type RouteResult = { phase: Phase } | { completed: true } | null;

/**
 * Decide the next phase when the current phase is done (extension-initiated).
 * User moves call PhaseProgression.setCurrentPhase directly; this encodes ONLY the
 * "advance one step" rule, routed per settings. Returns null when there is no
 * current phase.
 */
export function routeNext(currentPhase: Phase | null, config: RouteConfig): RouteResult {
  if (currentPhase === null) return null;
  switch (currentPhase) {
    case "design":
      return { phase: "plan" };
    case "plan":
      return { phase: "implement" };
    case "implement":
      return { phase: "verify" };
    case "verify":
      // Skip the review phase entirely when code review is disabled; otherwise review.
      return config.maxFeatureReviewRounds === 0 ? routeNext("review", config) : { phase: "review" };
    case "review":
      return config.uatMode === "after-review" ? { phase: "uat" } : { phase: "finish" };
    case "uat":
      return config.uatMode === "after-finish" ? { completed: true } : { phase: "finish" };
    case "finish":
      return config.uatMode === "after-finish" ? { phase: "uat" } : { completed: true };
  }
}

/**
 * Sub-loop-aware phase router. Wraps a {@link PhaseProgression} (the pointer owner)
 * and applies one-step routing decisions, moving the pointer forward or signaling
 * completion. Stateless beyond the injected progression — all phase state lives on
 * the progression.
 */
export class WorkflowRouter {
  constructor(private readonly progression: PhaseProgression) {}

  /**
   * Extension-initiated advance: the caller has verified the current phase is
   * done. Routes one step forward (review/uat-aware per settings) and either moves
   * the pointer or signals completion. Does NOT check completion criteria itself —
   * that is the caller's responsibility (artifact/task/verification gates).
   * Returns the routing decision for the handler to apply.
   */
  completeCurrent(config: RouteConfig): RouteResult {
    const result = routeNext(this.progression.getState().currentPhase, config);
    if (result && "phase" in result) {
      this.progression.setCurrentPhase(result.phase);
    }
    log.info(`[phase] WorkflowRouter.completeCurrent → ${JSON.stringify(result)}`);
    return result;
  }
}

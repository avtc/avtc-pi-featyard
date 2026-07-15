// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Review loop logic — deciding whether to continue review, generating reports,
 * and transitioning to UAT/finish after review completion.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NO_COMPACT_CALLBACK, triggerContextCompact } from "../compaction/compact-trigger.js";
import type { AutoAgentCallback } from "../kanban/auto-agent/auto-agent-state-machine.js";
import { log } from "../log.js";
import { syncEnvVarsFromState } from "../phases/env-sync.js";
import { transitionToFinishPhase, transitionToUatPhase } from "../phases/phase-transitions.js";
import { toRouteConfig } from "../phases/workflow-router.js";
import { type FeatyardSettings, getSettings, resolveReviewSkill } from "../settings/settings-ui.js";
import { NO_AGENT_NAME, NO_FEATURE_STATE_OVERRIDE } from "../shared/workflow-refs.js";
import type { FeatureSession } from "../state/feature-session.js";
import { DEFAULT_DIR, type ExpandSkillCommandFn, type FeatureState, saveFeatureState } from "../state/feature-state.js";
import { schedulePostTurnFollowUp } from "../state/post-turn-dispatch.js";
import { worthNotesPointerFor } from "../state/worth-notes.js";
import { NO_FEATURE_STATE, updateWidget } from "../ui/featyard-widget.js";
import { generateReviewReport } from "./review-report.js";

/** Sentinel for "no review-report context to merge" at the off/after-finish UAT paths and the
 *  non-loop call sites (manual /fy:next, verify re-entry). Required (no-optional-params convention);
 *  pass this instead of a bare `null`. */
export const NO_REVIEW_CONTEXT: {
  report: string | null;
  level: "info" | "warning";
  pointer: string | null;
} | null = null;

/**
 * Decide whether a review loop should continue based on settings and results.
 */
export function resolveReviewLoopDecision(
  settings: { reviewLoops: number; minReviewLoops: number },
  currentLoop: number,
  issuesFound: number,
): { shouldLoop: boolean } {
  const numericMax = settings.reviewLoops;
  const numericMin = settings.minReviewLoops;
  const effectiveMax = Math.max(numericMax, numericMin);
  const loopsCompleted = currentLoop + 1;
  const minMet = loopsCompleted >= numericMin;
  const shouldLoop = numericMax !== 0 && (issuesFound > 0 || !minMet) && loopsCompleted < effectiveMax;
  return { shouldLoop };
}

/** Dependencies injected from the factory closure */
export interface ReviewLoopDeps {
  handler: FeatureSession;
  expandSkillCommand: ExpandSkillCommandFn;
  applyModelOverrideForPhase: (pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>;
  getAutoAgentCallback: () => AutoAgentCallback | null;
  /** Recover a failed ctx.compact — injected from the compaction module. */
  recoverCompactFailure: () => void;
  pi: ExtensionAPI;
}

export function createReviewLoopHandlers(deps: ReviewLoopDeps) {
  const { handler, expandSkillCommand, applyModelOverrideForPhase, getAutoAgentCallback, recoverCompactFailure, pi } =
    deps;

  async function handleReviewLoopEnd(
    ctx: ExtensionContext,
    opts: {
      slug: string;
      featureState: FeatureState;
      issuesFound: number;
      cannotFixIssues: number;
      logPrefix: string;
    },
  ): Promise<void> {
    const { slug, featureState, issuesFound, cannotFixIssues, logPrefix } = opts;
    const settings = getSettings();
    const currentLoop = featureState.review.reviewLoopCount ?? 0;
    const { shouldLoop } = resolveReviewLoopDecision(
      { reviewLoops: settings.maxFeatureReviewRounds, minReviewLoops: settings.minReviewLoops },
      currentLoop,
      issuesFound,
    );
    log.info(
      `[workflow] DIAGNOSTICS: handleReviewLoopEnd slug=${slug}, currentLoop=${currentLoop}, issuesFound=${issuesFound}, maxFeatureReviewRounds=${settings.maxFeatureReviewRounds}, minReviewLoops=${settings.minReviewLoops}, shouldLoop=${shouldLoop}`,
    );

    if (shouldLoop) {
      featureState.review.reviewLoopCount = currentLoop + 1;
      saveFeatureState(featureState, DEFAULT_DIR);
      syncEnvVarsFromState(handler);
      updateWidget(handler, NO_FEATURE_STATE);
      const reviewSkill = resolveReviewSkill(settings);
      log.info(`[workflow] DIAGNOSTICS: resolveReviewSkill returned=${reviewSkill}`);
      if (reviewSkill) {
        // Compact between review loops (reviewIterationCompact). triggerContextCompact
        // re-injects the phase skill (fy-review) after compaction; if it doesn't
        // compact (none / below threshold), fall back to re-dispatching directly.
        const compacted = await triggerContextCompact(
          ctx,
          {
            settingValue: settings.reviewIterationCompact,
            skillName: reviewSkill,
            message: `Run code review iteration #${currentLoop + 1}`,
            logLabel: "code-review loop compact",
          },
          NO_COMPACT_CALLBACK,
          recoverCompactFailure,
        );
        if (!compacted) {
          const skillText = expandSkillCommand(`/skill:${reviewSkill}`, NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME);
          schedulePostTurnFollowUp(skillText);
        }
      }
    } else {
      // Loop ends — clean up and transition
      saveFeatureState(featureState, DEFAULT_DIR);

      // Generate the review report and its level (always computed — needed by the after-review
      // MERGE below even in headless mode; level is hoisted above the hasUI guard for that).
      const report = generateReviewReport(featureState);
      const level: "info" | "warning" = cannotFixIssues > 0 ? "warning" : "info";
      // Worth-notes pointer (existence + path) for the active feature — merged into the boundary
      // notify so it never stands alone (notifications are exclusive). Absent/empty → null.
      const pointer = worthNotesPointerFor(slug);

      // uatMode after-review: the report + UAT-handoff + worth-notes pointer are MERGED into ONE
      // notification — the standalone report notify is suppressed on this path so the
      // handoff doesn't hide it (pre-existing data-loss bug). off/after-finish keep the standalone
      // report notify (the natural review-completion boundary) with the worth-notes pointer appended.
      const guard = globalThis.__piCtx;
      const hasUi = guard?.hasUI && guard?.ui?.notify;
      if (settings.uatMode !== "after-review" && hasUi) {
        guard.ui.notify(pointer ? `${report}\n\n${pointer}` : report, level);
      }
      // Always log the report in headless mode (or after-review, where the standalone notify is
      // suppressed in favor of the merged handoff) so the review stats remain observable there.
      if (!hasUi) {
        log.info(`[workflow] ${logPrefix} — report: ${report}`);
      }

      // Transition to UAT based on uatMode setting. For after-review, thread the report + level
      // + pointer so handleReviewToUatTransition builds the combined notify (report + handoff +
      // pointer) in ONE notification with the report's level.
      await handleReviewToUatTransition(ctx, slug, settings, { report, level, pointer });
    }
  }

  /**
   * Handle transition from completed review phase to UAT/finish based on uatMode.
   * Called after review loop ends (shouldLoop=false) or zero-issues review.
   */
  async function handleReviewToUatTransition(
    ctx: ExtensionContext,
    slug: string,
    settings: FeatyardSettings,
    // Optional review-report context. Provided by handleReviewLoopEnd on the
    // after-review path so the report + UAT-handoff + worth-notes pointer MERGE into ONE notify
    // (notifications are exclusive — otherwise the handoff hides the report). null at the
    // off/after-finish paths and the non-loop call sites (no merge there) — required per the
    // project's no-optional-params convention; explicit null passed from those call sites.
    reportCtx: { report: string | null; level: "info" | "warning"; pointer: string | null } | null,
  ): Promise<void> {
    const uatMode = settings.uatMode;
    log.info(`[workflow] handleReviewToUatTransition: uatMode=${uatMode}, slug=${slug}`);

    // Complete the review phase FIRST
    handler.completeCurrentWorkflowPhase(toRouteConfig(settings)); // marks review as "complete"

    // Load feature state once — each branch syncs handler workflow state into it
    const featureState = handler.getActiveFeatureState();

    if (uatMode === "off") {
      // Skip UAT, auto-proceed to finish
      handler.setCurrentPhase("finish"); // skip
      await transitionToFinishPhase(featureState, { pi, ctx, handler, applyModelOverrideForPhase, expandSkillCommand });
    } else if (uatMode === "after-review") {
      // Pause at UAT — user advances via /fy:next (works in place, then advances).
      // MERGE the review report + UAT-handoff + worth-notes pointer into ONE notification (design
      // ): the report notify was already suppressed in handleReviewLoopEnd for this path,
      // so the combined message here is the single boundary notify that carries everything. The
      // report's level (warning if cannot-fix) is preserved via notifyLevel.
      const handoffMsg = `Feature "${slug}" is ready for UAT. Work in place, then /fy:next to advance.`;
      const report = reportCtx?.report;
      const pointer = reportCtx?.pointer;
      const notifyMessage =
        report != null
          ? pointer
            ? `${report}\n\n${handoffMsg}\n${pointer}`
            : `${report}\n\n${handoffMsg}`
          : pointer
            ? `${handoffMsg}\n${pointer}`
            : handoffMsg;
      await transitionToUatPhase(
        ctx,
        slug,
        featureState,
        {
          pi,
          handler,
          applyModelOverrideForPhase,
          getAutoAgentCallback,
        },
        {
          kanbanNote: "review complete — UAT handoff",
          notifyMessage,
          notifyLevel: reportCtx?.level,
        },
      );
    } else if (uatMode === "after-finish") {
      // Proceed to finish; after-finish UAT is driven by the derived check in phase_ready.
      await transitionToFinishPhase(featureState, { pi, ctx, handler, applyModelOverrideForPhase, expandSkillCommand });
    }
  }

  return { handleReviewLoopEnd, handleReviewToUatTransition };
}

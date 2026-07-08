// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Phase transition helpers — model override resolution, loop index calculation,
 * and phase-aware loop count lookup.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  cleanupWorktreeOnFinishWrapper as _cleanupWorktreeOnFinish,
  syncWorktreeStatus,
} from "../git/worktrees/worktree-helpers.js";
import { moveFeatureToLane } from "../kanban/data/kanban-move-feature.js";
import { log, NO_ERROR } from "../log.js";
import { DEFAULT_GLOBAL_DIR, loadFeatureFlowConfig, resolveModelOverride } from "../settings/settings-ui.js";
import { NO_AGENT_NAME, NO_FEATURE_STATE_OVERRIDE } from "../shared/workflow-refs.js";
import type { FeatureSession } from "../state/feature-session.js";
import {
  DEFAULT_DIR,
  type ExpandSkillCommandFn,
  type FeatureState,
  markFeatureDone,
  saveFeatureState,
  syncAndSaveFeatureState,
} from "../state/feature-state.js";
import { persistState } from "../state/state-persistence.js";
import { notifyFeatureCompleted } from "../state/worth-notes.js";
import { NO_FEATURE_STATE, updateWidget } from "../ui/feature-flow-widget.js";

/**
 * Get the appropriate loop count for a given phase from feature state.
 */
export function getLoopCountForPhase(featureState: FeatureState | null, phase: string): number {
  if (!featureState) return 0;
  if (phase === "design") return featureState.design.reviewLoopCount ?? 0;
  if (phase === "plan") return featureState.plan.reviewLoopCount ?? 0;
  return featureState.review.reviewLoopCount ?? 0;
}

/**
 * Parse a "provider/id" model reference string.
 */
export function parseModelRef(ref: string): { provider: string; id: string } {
  const idx = ref.indexOf("/");
  return { provider: ref.slice(0, idx), id: ref.slice(idx + 1) };
}

/**
 * Apply model override for in-session skill dispatch (review, design).
 * Resolves override from config, looks up full Model via modelRegistry,
 * and calls pi.setModel. No-op when no override is configured.
 */
export async function applyModelOverride(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stage: string,
  loopIndex: number,
): Promise<void> {
  const config = loadFeatureFlowConfig(DEFAULT_GLOBAL_DIR, process.cwd());
  const ref = resolveModelOverride(stage, loopIndex, config);
  if (!ref) return;

  const { provider, id } = parseModelRef(ref);
  const model = ctx.modelRegistry?.find?.(provider, id);
  if (!model) {
    log.warn(`[workflow] Model override not found in registry: ${provider}/${id}`);
    return;
  }

  await pi.setModel(model);
  log.info(`[workflow] Model override applied for stage '${stage}': ${provider}/${id}`);
}

/** Dependencies for transitionToFinishPhase. */
export interface FinishTransitionDeps {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  handler: FeatureSession;
  applyModelOverrideForPhase: (pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>;
  expandSkillCommand: ExpandSkillCommandFn;
}

/**
 * Execute the finish-phase transition sequence shared by the review loop and the workflow commands.
 *
 * Encapsulates: advance to finish, model override, feature state sync, persistence, widget
 * update, and dispatch of the ff-finish skill as a followUp. Does NOT touch UAT — callers
 * handle the UAT decision (skip / hand off) separately, before or instead of this call.
 */
export async function transitionToFinishPhase(
  featureState: FeatureState | null,
  deps: FinishTransitionDeps,
): Promise<void> {
  const { pi, ctx, handler, applyModelOverrideForPhase, expandSkillCommand } = deps;

  handler.setCurrentPhase("finish");
  await applyModelOverrideForPhase(pi, ctx, "finish");
  if (featureState) {
    syncAndSaveFeatureState(featureState, handler);
  }
  persistState(pi, handler);
  updateWidget(handler, NO_FEATURE_STATE);
  pi.sendUserMessage(expandSkillCommand("/skill:ff-finish", NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME), {
    deliverAs: "followUp",
  });
}

/** Dependencies for completeFeature. */
export interface CompleteFeatureDeps {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  handler: FeatureSession;
  getAutoAgentCallback: () => { onFeatureComplete?: (slug: string) => void } | null | undefined;
}

/**
 * Finalize a completed feature — the completion side-effects shared by every
 * terminal routing path (ff:next from the terminal phase, uat-accept after-finish).
 *
 * Clears the finish-phase guardrail flag, cleans up the worktree, marks the
 * feature done, clears the active-feature pointer + env, notifies the user, and
 * fires the auto-agent onFeatureComplete callback. Idempotent in effect: callers
 * route here ONLY on a {completed:true} RouteResult.
 */
export async function completeFeature(
  slug: string,
  featureState: FeatureState,
  deps: CompleteFeatureDeps,
): Promise<void> {
  const { pi, ctx, handler, getAutoAgentCallback } = deps;

  await _cleanupWorktreeOnFinish(featureState, ctx);
  // Mark done (completedAt) and keep the slot active with the done state, so the
  // widget renders a terminal DONE line until the next feature displaces it.
  // (done = visible: do NOT clear the active feature / env on completion)
  const doneState = markFeatureDone(featureState);
  saveFeatureState(doneState, DEFAULT_DIR);
  handler.setActiveFeatureState(doneState);
  // Sync the worktree status icon for the done state (completion is the off-signal
  // clears the icon regardless of whether worktree removal succeeded).
  syncWorktreeStatus(doneState);
  // Emit the completion notify with the worth-notes pointer merged in.
  notifyFeatureCompleted(slug);

  try {
    const autoAgentCb = getAutoAgentCallback();
    if (autoAgentCb?.onFeatureComplete) {
      autoAgentCb.onFeatureComplete(slug);
    }
  } catch (err) {
    log.error(`[workflow] auto-agent callback error on feature completion: ${err}`, NO_ERROR);
  }

  persistState(pi, handler);
  updateWidget(handler, NO_FEATURE_STATE);
}
export interface UatTransitionDeps {
  pi: ExtensionAPI;
  handler: FeatureSession;
  applyModelOverrideForPhase: (pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>;
  getAutoAgentCallback: () => { onFeatureUatHandoff?: (slug: string) => void } | null | undefined;
}

/**
 * Execute the full UAT phase transition sequence.
 *
 * Encapsulates: handler transition, model override, feature state sync,
 * kanban lane move, persistence, widget update, user notification,
 * and auto-agent callback.
 *
 * @param opts.skipUat - If true, marks UAT as complete/bypassed (no kanban move, no notification)
 * @param opts.kanbanNote - Custom note for kanban lane move
 * @param opts.notifyMessage - Custom notification message; if omitted, no notification is sent
 * @param opts.notifyLevel - Level for the notifyMessage ("info" | "warning"); defaults to "info".
 *  Used by the worth-notes merge to preserve a review report's warning level when the
 *  merged notify had cannot-fix issues.
 */
export async function transitionToUatPhase(
  ctx: ExtensionContext,
  slug: string,
  featureState: FeatureState | null,
  deps: UatTransitionDeps,
  opts: { skipUat?: boolean; kanbanNote?: string; notifyMessage?: string; notifyLevel?: "info" | "warning" } = {},
): Promise<void> {
  const { pi, handler, applyModelOverrideForPhase, getAutoAgentCallback } = deps;

  handler.setCurrentPhase(opts.skipUat ? "finish" : "uat");
  await applyModelOverrideForPhase(pi, ctx, "uat");

  if (featureState) {
    syncAndSaveFeatureState(featureState, handler);

    if (!opts.skipUat && featureState.featureId != null) {
      try {
        await moveFeatureToLane({
          featureId: featureState.featureId,
          toLane: "uat",
          fromLane: undefined,
          note: opts.kanbanNote ?? "review complete — UAT handoff",
        });
      } catch (err) {
        log.warn(`[workflow] kanban lane move to uat failed: ${err}`);
      }
    }
  }

  persistState(pi, handler);
  updateWidget(handler, NO_FEATURE_STATE);

  if (opts.notifyMessage) {
    const guard = globalThis.__piCtx;
    if (guard?.hasUI && guard?.ui?.notify) {
      guard.ui.notify(opts.notifyMessage, opts.notifyLevel ?? "info");
    }
  }

  try {
    const autoAgentCb = getAutoAgentCallback();
    if (autoAgentCb?.onFeatureUatHandoff) {
      log.info(`[workflow] notifying auto-agent UAT handoff for ${slug}`);
      autoAgentCb.onFeatureUatHandoff(slug);
    }
  } catch (err) {
    log.error(`[workflow] auto-agent UAT handoff callback error: ${err}`, NO_ERROR);
  }
}

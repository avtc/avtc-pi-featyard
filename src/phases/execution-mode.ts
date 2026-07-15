// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Execution mode applier — applies the settings-configured execution mode
 * when the plan phase completes.
 *
 * Reads `implementMode` from settings and advances to the implement
 * phase: creates a worktree if needed, then dispatches the fy-implement
 * skill in the current session (checkpoint / subagent / subagent-fork modes).
 *
 * No interactive dialog — the mode always comes from settings.
 *
 * All factory-coupled dependencies are injected via ExecutionModeDeps.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettings } from "../settings/settings-ui.js";
import { NO_AGENT_NAME, NO_FEATURE_STATE_OVERRIDE } from "../shared/workflow-refs.js";
import type { FeatureSession } from "../state/feature-session.js";
import { DEFAULT_DIR, type ExpandSkillCommandFn, type FeatureState, saveFeatureState } from "../state/feature-state.js";
import { schedulePostTurnFollowUp } from "../state/post-turn-dispatch.js";
import { persistState } from "../state/state-persistence.js";
import { NO_FEATURE_STATE, updateWidget } from "../ui/featyard-widget.js";

export interface ExecutionModeDeps {
  pi: ExtensionAPI;
  handler: FeatureSession;
  expandSkillCommand: ExpandSkillCommandFn;
  applyModelOverrideForPhase: (pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>;
  resolveBaseBranch: (ctx: ExtensionContext) => Promise<string>;
  ensureWorktreeForExecution: (featureState: FeatureState, ctx: ExtensionContext) => Promise<FeatureState>;
}

export function createExecutionModeApplier(deps: ExecutionModeDeps) {
  const { pi, handler, expandSkillCommand, applyModelOverrideForPhase, resolveBaseBranch, ensureWorktreeForExecution } =
    deps;

  /**
   * Apply the settings-configured execution mode and advance plan → implement.
   * Advances to implement, ensures a worktree when needed, and dispatches the
   * fy-implement skill in the current session.
   */
  async function applyExecutionMode(ctx: ExtensionContext): Promise<void> {
    const ws = handler.getWorkflowState();
    if (!ws) return;

    handler.setCurrentPhase("implement");
    await applyModelOverrideForPhase(pi, ctx, "implement");
    persistState(pi, handler);
    updateWidget(handler, NO_FEATURE_STATE);

    const slug = handler.getActiveFeatureSlug();
    if (slug) {
      const featureState = handler.getActiveFeatureState();
      if (featureState) {
        const settings = getSettings();
        const worktreeMode = settings.branchPolicy === "worktree";
        if (worktreeMode) {
          await resolveBaseBranch(ctx);
        }
        const updated = await ensureWorktreeForExecution(featureState, ctx);
        if (updated.git.worktreePath) {
          saveFeatureState(updated, DEFAULT_DIR);
        } else if (worktreeMode) {
          // Worktree setup failed in worktree mode. Execution cannot fall back to the main
          // repo here (the implementer is dispatched into the worktree with path-rewriting
          // interception), and the failure was already notified + logged inside
          // ensureWorktreeForExecution. Halt: do NOT dispatch the fy-implement skill.
          return;
        }
      }
    }

    schedulePostTurnFollowUp(expandSkillCommand("/skill:fy-implement", NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME));
  }

  return applyExecutionMode;
}

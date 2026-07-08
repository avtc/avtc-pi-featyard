// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Skill expansion — template substitution and skill command expansion.
 * Handles all {{PI_FF_*}} placeholder resolution and finish instruction generation.
 */

import { getBranchOrShortSha } from "../git/git-queries.js";
import { resolveMainRepoPathSync } from "../git/worktrees/worktree-lifecycle.js";
import type { AutoAgentCallback } from "../kanban/auto-agent/auto-agent-state-machine.js";
import { getLoopCountForPhase } from "../phases/phase-transitions.js";
import {
  buildCurrentBranchAutoAgentSection,
  buildCurrentBranchInteractiveSection,
  buildWorktreeAutoAgentSection,
  buildWorktreeInteractiveSection,
  type FinishContext,
} from "../prompts/finish-instructions.js";
import { expandSkillCommand as _expandSkillCommand } from "../prompts/skill-block-builder.js";
import { substitutePlaceholders } from "../prompts/template-engine.js";
import { IMPLEMENTER_GUIDANCE } from "../prompts/text-blocks.js";
import { getSettings } from "../settings/settings-ui.js";
import type { FeatureSession } from "../state/feature-session.js";
import { type FeatureState, flowToExecutionMode, isSubagentMode } from "../state/feature-state.js";

/** Pass as `handler` when no handler reference is available. */
export const NO_HANDLER: FeatureSession | null = null;
/** Function type of the `getEmptyLoopsForSlug` skill-expansion param (empty-loop counts per slug, or null). */
export type GetEmptyLoopsForSlug = ((slug: string) => Record<string, number> | undefined) | null;
/** Function type of the `getAutoAgentCb` skill-expansion param (auto-agent callback provider, or null). */
export type GetAutoAgentCb = (() => AutoAgentCallback | null) | null;
/** Pass as `getEmptyLoopsForSlug` when no empty-loop tracking is available. */
export const NO_EMPTY_LOOPS_FN: GetEmptyLoopsForSlug = null;
/** Pass as `featureStateOverride` when no override is needed. */
export const NO_FEATURE_STATE_OVERRIDE: FeatureState | null = null;
/** Pass as `getAutoAgentCb` when no auto-agent callback is available. */
export const NO_AUTO_AGENT_CB: GetAutoAgentCb = null;

export interface SubstitutionResult {
  text: string;
}

function buildWorktreeContextSection(
  worktreePath: string,
  slug: string,
  baseBranch: string,
  mainRepoPath: string | null,
): string {
  return [
    "## Worktree Context",
    "",
    "You are working in a git worktree created by the extension.",
    `- Worktree path: ${worktreePath}`,
    ...(mainRepoPath ? [`- Main repo path: ${mainRepoPath}`] : []),
    `- Feature branch: feature/${slug}`,
    `- Base branch: ${baseBranch}`,
    "",
    "You are working in a git worktree. The extension rewrites all tool paths automatically — use relative paths as normal.",
    "",
    `All subagent dispatches MUST include \`cwd: "${worktreePath}"\` — this applies to all modes: single (\`cwd\`), parallel (\`tasks[].cwd\`), and chain (\`chain[].cwd\`). Subagents without \`cwd\` start in the main repo, not the worktree.`,
    "",
    "To sync from base branch:",
    "1. `git remote` — check if remote exists",
    `2. If remote exists: \`git fetch origin && git merge origin/${baseBranch}\``,
    `3. If no remote: \`git merge ${baseBranch}\` (local branch only)`,
    "",
    "Do NOT create or remove worktrees — the extension manages them.",
  ].join("\n");
}

/**
 * Substitute all known PI_FF_* template placeholders in the given text.
 * Returns the modified text (or original if no placeholders found) and
 * metadata about whether the guardrail whitelist should be activated.
 */
export function substituteTemplates(
  text: string,
  handler: FeatureSession | null,
  getEmptyLoopsForSlug: GetEmptyLoopsForSlug,
  featureStateOverride: FeatureState | null,
  getAutoAgentCb: GetAutoAgentCb,
  agentName: string | null,
): SubstitutionResult {
  const settings = getSettings();

  // Cache feature state for the active slug — avoids repeated disk reads + JSON.parse.
  // Derive the slug from the handler when available, else from the override (so generic
  // placeholders like {{PI_FF_WORTH_NOTES_PATH}} resolve in tests/dispatch without a handler).
  const cachedFeatureState = featureStateOverride ?? handler?.getActiveFeatureState() ?? undefined;
  const activeSlug = handler?.getActiveFeatureSlug() ?? cachedFeatureState?.featureSlug ?? undefined;

  // {{PI_FF_IMPLEMENT_MODE}} — inject ff-implementer guidance (current-session) or orchestrator
  // dispatch instructions (subagent) based on executionMode.
  // - current-session: the main agent implements directly, so it gets the FULL ff-implementer guidance
  //   (IMPLEMENTER_GUIDANCE — pre-resolved with architecture principles + attention inlined, so no
  //   nested substitution; it carries Blockers, so ff-implement needs no separate When-to-Stop).
  // - subagent: the main agent is the orchestrator (dispatches ff-implementer subagents that carry their
  //   own guidance); it gets dispatch instructions + escalation (when to stop/escalate to the user).
  if (text.includes("{{PI_FF_IMPLEMENT_MODE}}")) {
    const subagent = isSubagentMode(flowToExecutionMode(getSettings().implementMode));
    const instruction = subagent
      ? [
          "Dispatch an ff-implementer subagent:",
          "",
          "```ts",
          'subagent({ agent: "ff-implementer", task: "... task prompt ..." })',
          "```",
          "",
          "Task prompt should include: task number, design section, scene-setting context (dependencies from previous tasks), working directory.",
          "",
          "If the ff-implementer reports uncertainties or assumptions: re-dispatch with clarifications if critical, or accept and note for review.",
          "",
          "⚠️ Never dispatch multiple implementation subagents in parallel (file conflicts).",
          "⚠️ Never write code yourself — you are the orchestrator.",
          "",
          "**Escalate to the user and stop if an ff-implementer subagent:** reports a blocker it cannot resolve, reports that the plan is wrong, or fails twice on the same task. Do not silently work around it.",
        ].join("\n")
      : IMPLEMENTER_GUIDANCE;
    text = text.replaceAll("{{PI_FF_IMPLEMENT_MODE}}", instruction);
  }

  // {{PI_FF_WORTH_NOTES}} — worth-notes handling, branches on executionMode.
  // Subagent mode: the implementer reports worth-notes; the orchestrator appends them.
  // Direct mode: the in-session implementer appends its own worth-notes directly.
  if (text.includes("{{PI_FF_WORTH_NOTES}}")) {
    const subagent = isSubagentMode(flowToExecutionMode(getSettings().implementMode));
    const instruction = subagent
      ? "Collect worth-notes from each implementer subagent's final report and append them to `{{PI_FF_WORTH_NOTES_PATH}}`: out-of-scope code smells needing refactoring, bugs you could not fix, and anything strange (what and where)."
      : "When you notice an out-of-scope code smell, a bug you cannot fix, or anything strange during your work, append it to `{{PI_FF_WORTH_NOTES_PATH}}` (what and where).";
    text = text.replaceAll("{{PI_FF_WORTH_NOTES}}", instruction);
  }

  // {{PI_FF_WORKTREE_CONTEXT}} — worktree paths, subagent CWD, sync commands
  if (text.includes("{{PI_FF_WORKTREE_CONTEXT}}")) {
    if (settings.branchPolicy === "worktree") {
      const slug = handler?.getActiveFeatureSlug() ?? null;
      if (!slug) {
        // No active feature — expand to empty (not a worktree failure)
        text = text.replaceAll("{{PI_FF_WORKTREE_CONTEXT}}", "");
      } else {
        const fsData = cachedFeatureState;
        if (fsData?.git?.worktreePath) {
          const mainRepoPath = resolveMainRepoPathSync();
          const baseBranch = fsData.git.baseBranch ?? settings.baseBranch ?? "main";
          text = text.replaceAll(
            "{{PI_FF_WORKTREE_CONTEXT}}",
            buildWorktreeContextSection(fsData.git.worktreePath, slug, baseBranch, mainRepoPath),
          );
        } else {
          // Worktree creation failed
          text = text.replaceAll(
            "{{PI_FF_WORKTREE_CONTEXT}}",
            "⚠️ Worktree creation failed. You are working in the main repo directory. Do NOT set cwd on subagent dispatches — let them inherit the main repo path.",
          );
        }
      }
    } else {
      // current-branch policy — no worktree context
      text = text.replaceAll("{{PI_FF_WORKTREE_CONTEXT}}", "");
    }
  }

  // {{PI_FF_FINISH_INSTRUCTIONS}}
  // 4 variants: branchPolicy × autoAgentActive
  const hasFinishPlaceholder = text.includes("{{PI_FF_FINISH_INSTRUCTIONS}}");
  if (hasFinishPlaceholder) {
    const autoAgentCb = getAutoAgentCb?.();
    const isActive = autoAgentCb?.isActive?.();
    const branchPolicy = settings.branchPolicy ?? "current-branch";
    const settingsBaseBranch = settings.baseBranch ?? null;
    // Feature state baseBranch takes precedence (set during worktree creation — see DD-11)
    let baseBranch = settingsBaseBranch;
    let featureWorktreePath: string | null = null;
    if (activeSlug) {
      const featureState = cachedFeatureState;
      if (featureState?.git?.baseBranch) {
        baseBranch = featureState.git.baseBranch;
      }
      if (featureState?.git?.worktreePath) {
        featureWorktreePath = featureState.git.worktreePath;
      }
    }
    const currentBranch = getBranchOrShortSha(process.cwd());

    const finishCtx: FinishContext = {
      baseBranch,
      currentBranch,
      worktreePath: featureWorktreePath,
      mainRepoPath: null,
      slug: activeSlug,
      worktreeFallbackWarning:
        branchPolicy === "worktree" && !featureWorktreePath
          ? "⚠️ Worktree creation failed — code is on feature branch, NOT merged to baseBranch. Merge manually."
          : null,
    };

    let section: string;

    if (branchPolicy === "worktree" && featureWorktreePath) {
      // --- Worktree policy ---
      finishCtx.mainRepoPath = resolveMainRepoPathSync();

      section = isActive ? buildWorktreeAutoAgentSection(finishCtx) : buildWorktreeInteractiveSection(finishCtx);
    } else {
      // --- Current-branch policy (or worktree without worktreePath — fallback) ---
      section = isActive
        ? buildCurrentBranchAutoAgentSection(finishCtx)
        : buildCurrentBranchInteractiveSection(finishCtx);
    }

    text = text.replaceAll("{{PI_FF_FINISH_INSTRUCTIONS}}", section);
  }

  // Apply generic placeholder substitution (PI_FF_REVIEWER_SKIP, etc.)
  const emptyLoops = activeSlug ? getEmptyLoopsForSlug?.(activeSlug) : undefined;

  // Current workflow phase — drives review-iteration context placeholders
  // (REVIEW_LOOP_CONTEXT, REVIEW_METHOD) and loop-index derivation.
  const phase = handler?.getWorkflowState()?.currentPhase;

  // Derive loop index from feature state based on current phase for report file naming
  let loopIndex: number | undefined;
  if (activeSlug && phase) {
    loopIndex = getLoopCountForPhase(cachedFeatureState ?? null, phase);
  }

  return {
    text: substitutePlaceholders(text, {
      emptyLoops,
      slug: activeSlug,
      loopIndex,
      baseCommitSha: cachedFeatureState?.git?.baseCommitSha ?? undefined,
      agentName,
      phase: phase ?? undefined,
      taskName: cachedFeatureState?.implement.currentTask ?? undefined,
    }),
  };
}

/**
 * Expand a /skill:name command into the <skill> XML block that pi core
 * would produce via _expandSkillCommand(). Also substitutes {{PI_FF_*}}
 * template placeholders in the skill body.
 *
 * Returns the expanded text, or the original text if the skill is not found
 * or on error (matching pi core's _expandSkillCommand behavior).
 */
export function expandSkillCommand(
  text: string,
  handler: FeatureSession | null,
  getEmptyLoopsForSlug: GetEmptyLoopsForSlug,
  featureStateOverride: FeatureState | null,
  getAutoAgentCb: GetAutoAgentCb,
  agentName: string | null,
): string {
  const result = _expandSkillCommand(
    text,
    (t) => substituteTemplates(t, handler, getEmptyLoopsForSlug, featureStateOverride, getAutoAgentCb, agentName).text,
  );
  return result;
}

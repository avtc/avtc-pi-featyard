// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Base branch resolution — extracts UI interaction, settings persistence,
 * and git operations from the workflow-monitor factory for SRP.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as autoAgentNotify from "../kanban/auto-agent/auto-agent-notify.js";
import { log } from "../log.js";
import { getSettings, updateSetting } from "../settings/settings-ui.js";
import { UserCancelledError, ValidationError } from "../shared/errors.js";
import { getActiveFeatureSlug } from "../shared/workflow-refs.js";
import { withCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import { getLastMessage, withAttention } from "../snippets/vendored/subscribe-to-notifications.js";
import { isSubagentSession } from "../state/state-persistence.js";
import { createGitExec } from "./worktrees/worktree-helpers.js";
import { detectBaseBranch, getBaseBranchCandidates } from "./worktrees/worktree-lifecycle.js";

/**
 * Resolve the base branch for the current project.
 *
 * Priority: saved setting > user selection (with git detection) > auto-detection > "main"
 */
export async function resolveBaseBranch(ctx: ExtensionContext): Promise<string> {
  const settings = getSettings();
  if (settings.baseBranch) return settings.baseBranch;

  const gitExec = createGitExec(ctx);

  try {
    const detected = (await detectBaseBranch(gitExec)) ?? undefined;
    const candidates = await getBaseBranchCandidates(gitExec);

    // Always prompt user to confirm base branch (when not set in settings)
    if (candidates.length > 0 && ctx.hasUI && !isSubagentSession()) {
      return await promptBaseBranch(gitExec, detected, candidates);
    } else if (detected) {
      log.info(`[workflow] Auto-detected base branch: ${detected}`);
      return detected;
    } else {
      log.warn(
        `[workflow] Could not auto-detect base branch and no UI for prompt, defaulting to 'main'. Set baseBranch in settings to override.`,
      );
      return "main";
    }
  } catch (err) {
    if (err instanceof UserCancelledError) throw err; // propagate cancel to caller
    if (err instanceof ValidationError) throw err; // propagate validation errors
    log.warn(`[workflow] Base branch detection failed, defaulting to 'main'. Set baseBranch in settings to override.`);
    return "main";
  }
}

/** Prompt user to select or enter a base branch, then persist the choice. */
async function promptBaseBranch(
  gitExec: ReturnType<typeof createGitExec>,
  detected: string | undefined,
  candidates: string[],
): Promise<string> {
  const guard = globalThis.__piCtx;
  const ui = guard?.ui;
  if (!ui?.select) {
    log.warn("[workflow] No UI available for base branch selection");
    throw new UserCancelledError("Base branch selection requires interactive mode");
  }
  const CUSTOM_BRANCH_OPTION = "Type your own...";
  const labels = [...candidates.map((b) => (b === detected ? `${b} (detected)` : b)), CUSTOM_BRANCH_OPTION];

  const activeSlug = getActiveFeatureSlug();
  if (activeSlug) autoAgentNotify.notifyAutoAgentBlocked(activeSlug);
  const pickedLabel = await withAttention(
    "workflow",
    ["base branch selection", activeSlug, getLastMessage()].filter(Boolean).join(" • "),
    () => withCoordinator(() => ui.select("Select the base branch for this project:", labels)),
  );
  if (activeSlug) autoAgentNotify.notifyAutoAgentUnblocked(activeSlug);

  // User cancelled the dialog
  if (pickedLabel === undefined) {
    log.info("[workflow] User cancelled base branch selection");
    throw new UserCancelledError("Base branch selection cancelled");
  }

  const baseBranch = await resolveBranchName(gitExec, pickedLabel, detected, CUSTOM_BRANCH_OPTION);
  await persistBranchChoice(baseBranch);
  return baseBranch;
}

/** Resolve the actual branch name from user selection (picked or custom-typed). */
async function resolveBranchName(
  gitExec: ReturnType<typeof createGitExec>,
  pickedLabel: string,
  detected: string | undefined,
  customOption: string,
): Promise<string> {
  if (pickedLabel !== customOption) {
    return pickedLabel.replace(/ \(detected\)$/, "");
  }

  // Free-text input for custom branch name
  const guard = globalThis.__piCtx;
  const ui = guard?.ui;
  if (!ui?.input) {
    log.warn("[workflow] No UI available for custom branch input");
    throw new UserCancelledError("Custom branch input requires interactive mode");
  }
  const customBranch = await withAttention(
    "workflow",
    ["custom branch", getLastMessage()].filter(Boolean).join(" • "),
    () => withCoordinator(() => ui.input("Enter base branch name:", detected ?? "main")),
  );
  if (!customBranch?.trim()) {
    log.info("[workflow] User cancelled custom branch input");
    throw new UserCancelledError("Custom branch input cancelled");
  }

  const branch = customBranch.trim();
  // Validate branch name — interpolated into shell commands via gitExec
  if (!/^[a-zA-Z0-9._@/-]+$/.test(branch)) {
    throw new ValidationError("Invalid branch name: contains shell-unsafe characters");
  }
  await verifyBranchExists(gitExec, branch);
  return branch;
}

/** Verify a branch exists locally or remotely (warns but continues if not found). */
async function verifyBranchExists(gitExec: ReturnType<typeof createGitExec>, branch: string): Promise<void> {
  try {
    const verifyResult = await gitExec(`git rev-parse --verify refs/heads/${branch}`);
    if (verifyResult.exitCode !== 0) {
      log.warn(`[workflow] Branch '${branch}' does not exist locally, trying remote`);
      const remoteVerify = await gitExec(`git rev-parse --verify refs/remotes/origin/${branch}`);
      if (remoteVerify.exitCode !== 0) {
        log.warn(`[workflow] Branch '${branch}' not found locally or remotely, using anyway`);
      }
    }
  } catch {
    // Verification failed — use the name anyway
  }
}

/** Ask user where to save the branch choice and persist it. */
async function persistBranchChoice(baseBranch: string): Promise<void> {
  const guard = globalThis.__piCtx;
  const ui = guard?.ui;
  const saveChoice = ui
    ? await withAttention("workflow", ["save location", getLastMessage()].filter(Boolean).join(" • "), () =>
        withCoordinator(() =>
          ui.select("Save base branch setting where?", [
            "Project settings (persists for all sessions)",
            "This session only",
          ]),
        ),
      )
    : undefined;

  // User cancelled save location dialog
  if (saveChoice === undefined) {
    log.info("[workflow] User cancelled save location selection, using session-only");
    updateSetting("baseBranch", baseBranch, null);
    return;
  }

  if (saveChoice.startsWith("Project")) {
    updateSetting("baseBranch", baseBranch, { level: "project" });
    log.info(`[workflow] Base branch '${baseBranch}' saved to project settings`);
  } else {
    updateSetting("baseBranch", baseBranch, null);
    log.info(`[workflow] Base branch '${baseBranch}' set for this session only`);
  }
}

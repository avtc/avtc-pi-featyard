// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Worktree-related utility functions for workflow-monitor.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettings } from "../../settings/settings-ui.js";
import type { FeatureSession } from "../../state/feature-session.js";
import type { FeatureState } from "../../state/feature-state.js";
import { NO_STATUS } from "../../ui/feature-flow-widget.js";
import type { ExecFn } from "./worktree-lifecycle.js";
import { cleanupWorktreeOnFinish } from "./worktree-lifecycle.js";

const WORKTREE_ACTIVE_PHASES = new Set(["implement", "verify", "review"]);
const WORKTREE_STATUS_KEY = "worktree";

/** Folder icon shown before the worktree path in the footer status entry. */
const WORKTREE_ICON = "\u{1F4C2}";

/**
 * Sync the worktree footer indicator (📂 {path}) with the current feature state.
 *
 * Shown when the active feature has a recorded `git.worktreePath`, the
 * `branchPolicy` is `worktree`, and the feature is not yet completed. Cleared
 * otherwise. This is the single source of truth for the indicator's logic;
 * called both at creation time (immediate feedback) and on every UI restore
 * (reload/resume/fork/reset) so the indicator never disappears after a reload
 * and never lingers after completion/reset.
 *
 * Completion (not phase) is the off-signal: the worktree is removed in the
 * finish phase, and the done state retains `worktreePath` until displaced, so a
 * phase check would falsely re-show the indicator for a completed feature.
 */
export function syncWorktreeStatus(featureState: FeatureState | null): void {
  const guard = globalThis.__piCtx;
  if (!guard?.hasUI || !guard?.ui?.setStatus) return;
  const ui = guard.ui;
  const worktreePath = featureState?.git?.worktreePath ?? null;
  const isWorktreePolicy = getSettings().branchPolicy === "worktree";
  const isDone = featureState?.completedAt != null;
  if (worktreePath && isWorktreePolicy && !isDone) {
    const label = `${WORKTREE_ICON} ${worktreePath}`;
    ui.setStatus(WORKTREE_STATUS_KEY, ui.theme?.fg("accent", label) ?? label);
  } else {
    ui.setStatus(WORKTREE_STATUS_KEY, NO_STATUS);
  }
}

/** Escape a string for bash single-quote context: wraps in '...', replacing internal ' with '\'' */
export function bashSingleQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Shared guard for worktree-aware handlers.
 * Returns worktree context if interception should be active, null otherwise.
 * Checks: active slug → worktreePath → branchPolicy=worktree → phase in WORKTREE_ACTIVE_PHASES.
 */
export function getActiveWorktreeContext(handler: FeatureSession): { worktreePath: string } | null {
  const slug = handler.getActiveFeatureSlug();
  if (!slug) return null;
  const fsData = handler.getActiveFeatureState();
  const worktreePath = fsData?.git?.worktreePath;
  if (!worktreePath) return null;
  const settings = getSettings();
  if (settings.branchPolicy !== "worktree") return null;
  const ws = handler.getWorkflowState();
  const phase = ws?.currentPhase;
  if (!phase || !WORKTREE_ACTIVE_PHASES.has(phase)) return null;
  return { worktreePath };
}

/**
 * Result shape returned by any exec implementation we support.
 */
interface ExecResult {
  exitCode?: number;
  stdout?: string;
}

/**
 * Extension contexts delivered at runtime may carry an `actions` object with an
 * `exec` helper (e.g. command handlers and tool execute). The SDK types do not
 * declare this on the base `ExtensionContext`, so we model it as optional and
 * fall back to a direct child_process exec when it is absent.
 */
interface ExecCapableContext extends ExtensionContext {
  actions?: { exec?: (command: string, options?: { cwd?: string | null }) => Promise<ExecResult> };
}

/**
 * Create a git exec function from an extension context.
 */
export function createGitExec(ctx: ExtensionContext): ExecFn {
  const execCtx = ctx as ExecCapableContext;
  return async (command: string, options?: { cwd?: string }) => {
    // Prefer ctx.actions.exec (available in command handlers and tool execute)
    if (execCtx?.actions?.exec) {
      try {
        const result = (await execCtx.actions.exec(command, options)) as ExecResult | undefined;
        // Some exec implementations return undefined for unmocked commands; treat that as a
        // non-zero exit (empty stdout) rather than crashing on property access.
        if (!result) {
          return { exitCode: 1, stdout: "" };
        }
        return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "" };
      } catch (err: unknown) {
        if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
          throw err;
        }
        return { exitCode: 1, stdout: err instanceof Error ? err.message : String(err) };
      }
    }
    // Fallback: direct exec (for contexts without actions.exec)
    // Use exec (shell) instead of execFile to handle quoted arguments correctly.
    // execFile with command.split(" ") breaks on arguments containing spaces.
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const { stdout } = await execAsync(command, {
        cwd: options?.cwd ?? undefined,
        encoding: "utf-8",
      });
      return { exitCode: 0, stdout };
    } catch (err: unknown) {
      return { exitCode: 1, stdout: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** Remove worktree when feature is done */
export async function cleanupWorktreeOnFinishWrapper(
  featureState: Parameters<typeof cleanupWorktreeOnFinish>[0],
  ctx: ExtensionContext,
): Promise<void> {
  return cleanupWorktreeOnFinish(featureState, createGitExec(ctx), getSettings(), WORKTREE_STATUS_KEY);
}

export { WORKTREE_STATUS_KEY };

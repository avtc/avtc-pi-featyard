// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Finish instruction variant builders.
 *
 * Generates branch-specific finish-phase instructions for the agent,
 * covering worktree and current-branch policies in both auto-agent
 * and interactive modes.
 */

export interface FinishContext {
  baseBranch: string | null;
  currentBranch: string | null;
  worktreePath: string | null;
  mainRepoPath: string | null;
  slug: string | undefined;
  /** Non-null when branchPolicy=worktree but no worktreePath exists (creation failed) */
  worktreeFallbackWarning: string | null;
}

export function buildWorktreeAutoAgentSection(ctx: FinishContext): string {
  if (!ctx.baseBranch) {
    return "### Error\n\nbaseBranch not configured. Set baseBranch in settings before using auto-agent with worktree policy.";
  }
  return [
    "### Auto-Agent Mode",
    "",
    "branchPolicy: worktree",
    `baseBranch: ${ctx.baseBranch}`,
    `currentBranch: ${ctx.currentBranch ?? "(unknown)"}`,
    `worktreePath: ${ctx.worktreePath}`,
    `mainRepoPath: ${ctx.mainRepoPath ?? "(unknown)"}`,
    "",
    "1. Verify tests in worktree — if fail, report error and stop",
    "2. Sync from baseBranch (in worktree — guardrail-relaxed):",
    `   a. If remote exists: \`git fetch origin\` then \`git merge origin/${ctx.baseBranch}\``,
    `   b. If no remote: \`git merge ${ctx.baseBranch}\` (local branch)`,
    "   c. If conflicts → resolve intelligently (see Conflict Resolution section), NOT --theirs",
    "   d. Re-run tests — the sync merge can break things. If tests fail, investigate whether the merge caused it, fix the merge-induced breakage, and re-run before continuing. If you cannot fix it, report and stop.",
    "3. Check for uncommitted changes. If present: `git add -A && git commit -m 'feat: <descriptive summary>'`",
    "4. Merge into baseBranch (guardrail whitelisted during finish phase — see DD-9):",
    "   a. cd to main repo directory using injected mainRepoPath above",
    `   b. git checkout ${ctx.baseBranch}`,
    `   c. git merge feature/${ctx.slug}`,
    "   d. If conflicts → resolve intelligently (see Conflict Resolution section)",
    "5. Post-merge verification (see Post-Merge Verification section)",
    "6. Call phase_ready — extension handles branch deletion and worktree removal",
    "",
    "Note: For all uatModes, the agent performs the full merge + verification before calling phase_ready.",
  ].join("\n");
}

export function buildWorktreeInteractiveSection(ctx: FinishContext): string {
  const bb = ctx.baseBranch;
  return [
    "### Interactive Mode",
    "",
    "branchPolicy: worktree",
    `baseBranch: ${bb ?? "(not set — will auto-detect)"}`,
    `currentBranch: ${ctx.currentBranch ?? "(unknown)"}`,
    `worktreePath: ${ctx.worktreePath}`,
    `mainRepoPath: ${ctx.mainRepoPath ?? "(unknown)"}`,
    "",
    "If baseBranch was auto-detect (not set in settings): run `git branch --show-current` and ask user to confirm the base branch.",
    "",
    "Select an option:",
    `  1. Merge into ${bb ?? "<baseBranch>"} and clean up ← recommended`,
    "     Note: for `after-finish` UAT mode, the worktree persists between merge and UAT acceptance.",
    "  2. Push and create a Pull Request (keep worktree)",
    "  3. Keep as-is (worktree preserved)",
    '     After selecting: report "Worktree preserved at <path>. Feature remains active." Do NOT call phase_ready.',
    '  4. Discard (requires typed "discard" confirmation — shows branch, commits, worktree path)',
    "",
    "For Option 1 (Merge into baseBranch):",
    "  a. Sync from baseBranch (in worktree):",
    `     - If remote exists: \`git fetch origin\` then \`git merge origin/${bb ?? "<baseBranch>"}\``,
    `     - If no remote: \`git merge ${bb ?? "<baseBranch>"}\` (local branch)`,
    "     - If conflicts → present to user for resolution",
    "     - Re-run tests after merge. If tests fail → report, ask whether to proceed",
    "  b. Merge into baseBranch (from main repo directory, NOT worktree) — guardrail whitelisted during finish phase",
    "  c. Post-merge verification (see Post-Merge Verification section)",
    "For Options 2, 3, 4: follow instructions for selected option.",
  ].join("\n");
}

export function buildCurrentBranchAutoAgentSection(ctx: FinishContext): string {
  const onBaseBranch = ctx.currentBranch && ctx.baseBranch && ctx.currentBranch === ctx.baseBranch;
  const branchNote = onBaseBranch
    ? '   - Note: "Changes are already on the base branch."'
    : ctx.baseBranch
      ? `   - Note: "Work is committed on ${ctx.currentBranch} but NOT merged to ${ctx.baseBranch}. Merge manually when ready."`
      : '   - Note: "Work is committed on the current branch. Set baseBranch in settings and merge manually."';

  return [
    ...(ctx.worktreeFallbackWarning ? [ctx.worktreeFallbackWarning, ""] : []),
    "### Auto-Agent Mode",
    "",
    "branchPolicy: current-branch",
    `baseBranch: ${ctx.baseBranch ?? "(not set)"}`,
    `currentBranch: ${ctx.currentBranch ?? "(unknown)"}`,
    "",
    "1. Verify tests — if fail, report error and stop",
    "2. Check for uncommitted changes (`git status`). If present: `git add -A && git commit -m 'feat: <descriptive summary>'`",
    "3. Report done with summary:",
    `   - Current branch: ${ctx.currentBranch ?? "(unknown)"}`,
    `   - Base branch: ${ctx.baseBranch ?? "(not set)"}`,
    "   - Commits on this branch: <count>",
    "   - Files changed: <list>",
    branchNote,
    "4. Call phase_ready",
    "5. NO merge. NO branch deletion. NO worktree cleanup.",
  ].join("\n");
}

export function buildCurrentBranchInteractiveSection(ctx: FinishContext): string {
  const bb = ctx.baseBranch;
  return [
    "### Interactive Mode",
    "",
    "branchPolicy: current-branch",
    `baseBranch: ${bb ?? "(not set — will auto-detect)"}`,
    "",
    "1. Run `git branch --show-current` to detect current branch",
    "2. If baseBranch was auto-detected (not set in settings), confirm with user before proceeding",
    "3. Present options based on current branch:",
    "",
    "  If on baseBranch:",
    "    1. Done — work is already on baseBranch",
    '       After selecting: report "Work complete on <branch>." and call phase_ready.',
    "",
    "  If on feature branch:",
    "    1. Keep as-is (I'll handle merging) ← recommended",
    '       After selecting: report "Work preserved on <branch>." Do NOT call phase_ready.',
    `    2. Merge into ${bb ?? "<baseBranch>"} locally`,
    "       If merge is blocked by guardrail, report to user and suggest changing guardrail to 'ask' or 'off', or running the merge manually.",
    "       After selecting: merge, verify, then call phase_ready.",
    "    3. Push and create a Pull Request",
    "       After selecting: push, then call phase_ready.",
    "    4. Discard this work",
    "       After selecting: confirm, discard, then call phase_ready.",
  ].join("\n");
}

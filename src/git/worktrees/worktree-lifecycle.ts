// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execSync as _realExecSync } from "node:child_process";
import { rmSync as _realRmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { log } from "../../log.js";
import type { FeatureState } from "../../state/feature-state.js";
import { NO_STATUS } from "../../ui/feature-flow-widget.js";

/** Injectable execSync — tests can override via _setExecSync */
let _execSync: typeof _realExecSync = _realExecSync;

/** @internal Test hook to override execSync */
export function _setExecSync(fn: typeof _realExecSync): void {
  _execSync = fn;
  _cachedMainRepoPath = undefined;
}

/** Injectable recursive directory delete — used as a long-path fallback when
 *  `git worktree remove` fails on Windows (node_modules paths > MAX_PATH).
 *  Tests can override via _setRmSync; pass null to restore the default. */
let _rmSync: typeof _realRmSync = _realRmSync;

/** @internal Test hook to override the recursive-delete fallback (null restores default). */
export function _setRmSync(fn: typeof _realRmSync | null): void {
  _rmSync = fn ?? _realRmSync;
}

/** Normalize Windows backslashes to forward slashes for consistent git path handling. */
function normalizeGitPath(p: string): string {
  return p.replace(/\\/g, "/");
}

// --- Finish phase guardrail whitelist helpers ---
// Shared between workflow-monitor.ts and guardrail integration layer
// Writes to the __piWorkflowMonitor bridge object (bridge migration)

export function setFinishPhaseWhitelisted(value: boolean): void {
  if (globalThis.__piWorkflowMonitor) {
    globalThis.__piWorkflowMonitor.finishPhaseWhitelisted = value;
  }
}

export function isFinishPhaseWhitelisted(): boolean {
  return globalThis.__piWorkflowMonitor?.finishPhaseWhitelisted === true;
}

export type ExecFn = (command: string, options?: { cwd?: string }) => Promise<{ exitCode: number; stdout: string }>;

/** Characters that are safe for shell interpolation — alphanumeric, dash, underscore, dot, forward slash, at */
const SAFE_SHELL_RE = /^[a-zA-Z0-9._@/-]+$/;

function validateShellArg(value: string, name: string): void {
  if (!SAFE_SHELL_RE.test(value)) {
    throw new Error(`Invalid ${name}: contains shell-unsafe characters`);
  }
}

export interface CreateWorktreeOptions {
  slug: string;
  baseBranch: string;
  worktreeDir?: string;
  exec: ExecFn;
}

export interface RemoveWorktreeOptions {
  worktreePath: string;
  mainRepoPath: string;
  branchName?: string;
  baseBranch?: string; // Optional: for merge-status check before branch deletion
  exec: ExecFn;
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<{ path: string; branch: string }> {
  validateShellArg(opts.slug, "slug");
  validateShellArg(opts.baseBranch, "baseBranch");
  if (opts.worktreeDir) {
    validateShellArg(opts.worktreeDir, "worktreeDir");
  }

  const branch = `feature/${opts.slug}`;
  const worktreeDir = opts.worktreeDir ?? `.worktrees/${opts.slug}`;

  log.info(`[worktree] Creating worktree: ${worktreeDir} on branch ${branch} from ${opts.baseBranch}`);

  const result = await opts.exec(`git worktree add ${worktreeDir} -b ${branch} ${opts.baseBranch}`);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${result.stdout}`);
  }

  return { path: worktreeDir, branch };
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  validateShellArg(opts.worktreePath, "worktreePath");
  // NOTE: mainRepoPath is intentionally NOT validated — it is passed only as an exec
  // {cwd} option (never interpolated into the shell string), so a drive-letter colon
  // (e.g. "E:/repo" on Windows) must not be rejected. Validating it broke all worktree
  // + branch cleanup on Windows. The interpolated args below remain validated.
  if (opts.branchName) {
    validateShellArg(opts.branchName, "branchName");
  }

  log.info(`[worktree] Removing worktree: ${opts.worktreePath}`);

  // Execute from main repo (not worktree). --force discards untracked/modified files
  // (build artifacts like node_modules / pnpm files common in a completed feature's
  // worktree) so a done+merged feature cleans up even when the agent left artifacts.
  const result = await opts.exec(`git worktree remove --force ${opts.worktreePath}`, { cwd: opts.mainRepoPath });

  if (result.exitCode !== 0) {
    // git worktree remove can exit non-zero on Windows when nested paths exceed
    // MAX_PATH (e.g. node_modules/.pnpm/<deep>). git may have de-registered the
    // worktree but failed to delete the directory, OR refused entirely. Fall back to
    // a long-path-capable recursive delete of the absolute path, then prune any stale
    // worktree administrative files. Best-effort — finish continues regardless.
    log.warn(`[worktree] git worktree remove failed, falling back to direct delete: ${result.stdout}`);
    const absPath = resolvePath(opts.mainRepoPath, opts.worktreePath);
    try {
      _rmSync(absPath, { recursive: true, force: true });
    } catch (err: unknown) {
      log.warn(`[worktree] direct delete failed for ${absPath}: ${err}`);
    }
    try {
      await opts.exec("git worktree prune", { cwd: opts.mainRepoPath });
    } catch (err: unknown) {
      log.warn(`[worktree] git worktree prune failed: ${err}`);
    }
  }

  // Optionally delete the branch too
  if (opts.branchName) {
    if (opts.baseBranch) {
      validateShellArg(opts.baseBranch, "baseBranch");
      // Check if branch is fully merged into baseBranch before deleting
      try {
        const mergedResult = await opts.exec(`git branch --merged ${opts.baseBranch}`, { cwd: opts.mainRepoPath });
        const mergedBranches = mergedResult.stdout
          .split("\n")
          .map((b) => b.trim().replace(/^[*+]\s*/, "")) // strip *, + prefixes from git branch output
          .filter(Boolean);
        if (!mergedBranches.includes(opts.branchName)) {
          log.warn(
            `[worktree] Branch ${opts.branchName} not fully merged into ${opts.baseBranch} — skipping deletion.`,
          );
          return;
        }
      } catch (e) {
        log.warn(`[worktree] git branch --merged failed (${e}) — skipping branch deletion for safety.`);
        return;
      }
    }
    await opts.exec(`git branch -d ${opts.branchName}`, { cwd: opts.mainRepoPath });
  }
}

/**
 * Resolve main repo path from a worktree context.
 *
 * For worktrees: uses `--git-common-dir` which always points to the shared
 * .git directory (e.g. /path/to/main-repo/.git), then strips the.git suffix.
 *
 * For non-worktree repos: falls back to `--show-toplevel` which returns the
 * repo root directly.
 */
export async function resolveMainRepoPath(exec: ExecFn): Promise<string> {
  // First, try --git-common-dir to detect worktrees
  const gitDir = await exec("git rev-parse --git-common-dir");
  const normalized = normalizeGitPath(gitDir.stdout.trim());

  // If the path is absolute (starts with / or a drive letter like C), it's
  // either a worktree or an absolute common-dir path. Strip /.git to get the repo root.
  if (/^\//.test(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return normalized.replace(/\/\.git(?:\/worktrees\/[^/]+)?$/, "");
  }

  // For relative paths (e.g. ".git" in non-worktree repos), fall back to
  // --show-toplevel which always returns an absolute path.
  const topLevel = await exec("git rev-parse --show-toplevel");
  return normalizeGitPath(topLevel.stdout.trim());
}

/**
 * Synchronous version of resolveMainRepoPath for use in sync contexts (e.g. substituteTemplates).
 * Uses the same strategy as the async version: --git-common-dir first, --show-toplevel fallback.
 */
let _cachedMainRepoPath: string | null | undefined;

export function resolveMainRepoPathSync(): string | null {
  if (_cachedMainRepoPath !== undefined) return _cachedMainRepoPath;
  try {
    const gitDir = normalizeGitPath(
      _execSync("git rev-parse --git-common-dir", { encoding: "utf-8", stdio: ["pipe"] }).trim(),
    );
    // If the path is absolute, strip /.git (and optional /worktrees/<id>) to get the repo root
    if (/^\//.test(gitDir) || /^[a-zA-Z]:/.test(gitDir)) {
      _cachedMainRepoPath = gitDir.replace(/\/\.git(?:\/worktrees\/[^/]+)?$/, "");
      return _cachedMainRepoPath;
    }
    // For relative paths, fall back to --show-toplevel
    _cachedMainRepoPath = normalizeGitPath(
      _execSync("git rev-parse --show-toplevel", { encoding: "utf-8", stdio: ["pipe"] }).trim(),
    );
    return _cachedMainRepoPath;
  } catch {
    _cachedMainRepoPath = null;
    return _cachedMainRepoPath;
  }
}

/**
 * Detect the base (default) branch for the repository.
 *
 * Strategy:
 * 1. Try `git symbolic-ref refs/remotes/origin/HEAD` (requires remote)
 * 2. If only one remote branch exists, use it
 * 3. Check for common branch names locally (main, master, develop)
 * 4. Return null if ambiguous (multiple candidates) — caller should prompt
 */
export async function detectBaseBranch(exec: ExecFn): Promise<string | null> {
  // Strategy 1: remote HEAD
  try {
    const result = await exec("git symbolic-ref refs/remotes/origin/HEAD");
    if (result.exitCode === 0) {
      const ref = result.stdout.trim();
      const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
      if (match) return match[1];
    }
  } catch {
    // No remote or no HEAD
  }

  // Strategy 2: check remote branches
  try {
    const result = await exec("git branch -r");
    if (result.exitCode === 0) {
      const branches = result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.includes("->")) // skip HEAD symlinks
        .map((l) => l.replace(/^origin\//, ""));
      if (branches.length === 1) {
        return branches[0] ?? null;
      }
      if (branches.length > 1) {
        // Multiple remote branches — ambiguous
        return null;
      }
    }
  } catch {
    // No remote
  }

  // Strategy 3: check common branch names locally
  const candidates = ["main", "master", "develop"];
  const found: string[] = [];
  for (const name of candidates) {
    try {
      const result = await exec(`git branch --list ${name}`);
      if (result.exitCode === 0 && result.stdout.trim()) {
        found.push(name);
      }
    } catch {
      // ignore
    }
  }

  if (found.length === 1) return found[0] ?? null;
  if (found.length > 1) return null; // ambiguous

  return null;
}

/**
 * Get all candidate base branches for the repository.
 * Returns an array of branch names that could be the base branch.
 * Used when detectBaseBranch returns null to prompt user selection.
 */
export async function getBaseBranchCandidates(exec: ExecFn): Promise<string[]> {
  const candidates = new Set<string>();

  // Add current branch (user is likely on a feature branch forked from base)
  try {
    const result = await exec("git rev-parse --abbrev-ref HEAD");
    if (result.exitCode === 0) {
      const branch = result.stdout.trim();
      if (branch && branch !== "HEAD") {
        candidates.add(branch);
      }
    }
  } catch {
    // ignore
  }

  // Check common branch names — local and remote
  // We only check known base branch names, not all remote branches,
  // to avoid flooding the selection list with feature branches.
  const common = ["main", "master", "develop"];
  for (const name of common) {
    try {
      // Check local first
      const local = await exec(`git branch --list ${name}`);
      if (local.exitCode === 0 && local.stdout.trim()) {
        candidates.add(name);
        continue;
      }
      // Fall back to remote
      const remote = await exec(`git branch -r --list origin/${name}`);
      if (remote.exitCode === 0 && remote.stdout.trim()) {
        candidates.add(name);
      }
    } catch {
      // ignore
    }
  }

  // If no candidates found, try to verify common defaults exist
  if (candidates.size === 0) {
    const verified: string[] = [];
    for (const name of ["main", "master"]) {
      try {
        const result = await exec(`git rev-parse --verify refs/heads/${name}`);
        if (result.exitCode === 0) {
          verified.push(name);
        }
      } catch {
        // ignore
      }
    }
    if (verified.length > 0) {
      return verified;
    }
    // Absolute last resort — no branches could be detected at all
    log.warn("[worktree] No base branch candidates found; returning ['main'] as fallback");
    return ["main"];
  }

  return Array.from(candidates).sort();
}

/** Clean up worktree on feature finish. Best-effort — does not block on failure. */
export async function cleanupWorktreeOnFinish(
  featureState: Pick<FeatureState, "git" | "featureSlug">,
  gitExec: ExecFn,
  settings: { baseBranch?: string | null },
  worktreeStatusKey: string,
): Promise<void> {
  if (!featureState.git.worktreePath) return;

  const baseBranch = featureState.git.baseBranch ?? settings.baseBranch ?? undefined;

  try {
    const mainRepoPath = await resolveMainRepoPath(gitExec);
    await removeWorktree({
      worktreePath: featureState.git.worktreePath,
      mainRepoPath,
      branchName: `feature/${featureState.featureSlug}`,
      baseBranch,
      exec: gitExec,
    });
    log.info(`[workflow] Cleaned up worktree for ${featureState.featureSlug}`);
  } catch (err: unknown) {
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
      throw err;
    }
    log.warn(`[workflow] Failed to clean up worktree for ${featureState.featureSlug}: ${err}`);
  }

  // Always clear the worktree status icon once finish-cleanup has been attempted.
  // Completion is the off-signal: a failed removal (caught above) must not leave the
  // indicator stuck. (Programmer errors re-throw above, so this only runs on success
  // or a swallowed non-fatal removal error.)
  const guard = globalThis.__piCtx;
  if (guard?.hasUI && guard?.ui?.setStatus) {
    guard.ui.setStatus(worktreeStatusKey, NO_STATUS);
  }
}

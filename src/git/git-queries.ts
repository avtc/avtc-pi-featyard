// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Read-only git introspection for a coding-agent workflow: where is HEAD, is
 * anything uncommitted, and what's staged. Every query degrades to a safe value
 * (null / false / []) on failure and never throws — callers pay no try/catch;
 * each failure surfaces as exactly one diagnostic warn in the log.
 */
import { execFileSync } from "node:child_process";
import { log } from "../log.js";

/** Synchronous git invocation contract: returns captured stdout (caller trims); throws on non-zero exit, missing git binary, or any spawn error. */
export type GitRunner = (args: string[], cwd: string) => string;

/** Default runner: invokes the real `git` binary synchronously via child_process (no shell; args passed directly to avoid injection/quoting). */
export const defaultGitRunner: GitRunner = (args, cwd) => {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    // stdin ignored so git can't block waiting for input; stdout/stderr piped (captured, not leaked to console).
    stdio: ["ignore", "pipe", "pipe"],
  });
};

// --- testability seam -------------------------------------------------------
// All four queries below route through this module-level slot. A test swaps it once
// with setGitRunner(stub) to stub ALL git invocation without touching the filesystem.
let gitRunner: GitRunner = defaultGitRunner;

/** Test seam — replace how this module shells out to git. Every query routes through the slot, so one call stubs them all. Restore the real runner with `setGitRunner(defaultGitRunner)`. */
export function setGitRunner(runner: GitRunner): void {
  gitRunner = runner;
}

/** Convenience pass-through for `process.cwd()` so one-off callers don't have to supply a directory. */
export const PROCESS_CWD: string = process.cwd();

/** Sentinel fallbacks for queries that can't determine a value (avoids bare literals at call sites). */
const NO_REF: string | null = null;
const NO_SHA: string | null = null;
const CLEAN_TREE = false;

// --- internal failure path --------------------------------------------------
// One centralized failure path: run `compute` against the current runner; if it throws
// for ANY reason (not a repo, git missing, non-zero exit), emit exactly ONE warn
// (its text always contains "git") and return the query's safe fallback.
function query<T>(label: string, cwd: string, compute: (run: GitRunner) => T, fallback: T): T {
  const run = gitRunner;
  try {
    return compute(run);
  } catch (err) {
    log.warn(`git ${label} failed in ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

// --- queries ----------------------------------------------------------------

/** Symbolic identity at HEAD: the branch name when on a branch, else the short commit SHA. Null when it cannot be determined (not a repo, git unavailable). */
export function getBranchOrShortSha(cwd: string): string | null {
  return query(
    "identity",
    cwd,
    (run) => {
      // `symbolic-ref --short HEAD` prints the branch name even on an unborn branch (no
      // commits yet); it errors only when HEAD is detached, so treat that as "no branch".
      try {
        const branch = run(["symbolic-ref", "--short", "HEAD"], cwd).trim();
        if (branch !== "") return branch;
      } catch {
        // detached HEAD (or symbolic-ref unavailable) — fall through to the short SHA.
      }
      const short = run(["rev-parse", "--short", "HEAD"], cwd).trim();
      return short !== "" ? short : NO_REF;
    },
    NO_REF,
  );
}

/** Full 40-character commit SHA of HEAD. Null when git is unavailable or returns anything that isn't exactly 40 lowercase hex chars. */
export function getHeadSha(cwd: string): string | null {
  return query(
    "head-sha",
    cwd,
    (run) => {
      const sha = run(["rev-parse", "HEAD"], cwd).trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : NO_SHA;
    },
    NO_SHA,
  );
}

/** True if the working tree has ANY uncommitted change — staged, unstaged, or untracked. False when clean or on failure. */
export function isDirty(cwd: string): boolean {
  return query(
    "dirty",
    cwd,
    (run) => {
      // `status --porcelain` is empty iff clean; it lists staged, unstaged, AND untracked ("??") files.
      return run(["status", "--porcelain"], cwd).trim() !== "";
    },
    CLEAN_TREE,
  );
}

/** File paths currently staged for commit (one per line from `git diff --cached --name-only`). Empty array when none or on failure. */
export function getStagedFiles(cwd: string): string[] {
  return query(
    "staged-files",
    cwd,
    (run) => {
      const out = run(["diff", "--cached", "--name-only"], cwd).trim();
      if (out === "") return [];
      return out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },
    [],
  );
}

/**
 * Repo-relative paths of every working-tree change vs HEAD: staged, unstaged,
 * AND untracked. This is the union `git status` reports — the full "current
 * change set" — and is used to answer "did a test get written/modified in this
 * change set?" without caring HOW a file was written (write/edit tool, heredoc,
 * cp, sed, …). Returns an empty array when the tree is clean or on failure
 * (not a repo, git unavailable).
 *
 * Uses `-z` for null-separated, never-quoted paths: avoids whitespace/special-
 * char splitting and the `PATH -> NEWPATH` rename-arrow ambiguity of the
 * default format. Each entry carries a 2-char `XY` status prefix followed by a
 * space; the prefix is stripped before returning the bare path.
 */
export function getWorkingTreeFiles(cwd: string): string[] {
  return query(
    "working-tree-files",
    cwd,
    (run) => {
      // `-uall` lists individual files inside untracked directories (default
      // `-unormal` collapses a wholly-untracked dir to a single `dir/` entry,
      // hiding the test file inside). `-z` for null-separated, never-quoted paths.
      const out = run(["status", "--porcelain", "-z", "--untracked-files=all"], cwd);
      if (out === "") return [];
      return out
        .split("\0")
        .map((entry) => entry.replace(/^.{3}/, "")) // strip the "XY " status prefix
        .filter((p) => p !== "");
    },
    [],
  );
}

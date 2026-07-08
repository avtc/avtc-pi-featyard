// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * TDD write-order enforcement for a coding agent.
 *
 * A single, stateless rule: editing a source file requires a corresponding test
 * change to already be in the working-tree change set. "Corresponding" is by
 * stem (layout-independent), and the change set is read from git — so the check
 * sees a test write regardless of HOW it was made (write/edit tool, heredoc,
 * cp, sed, …) and never counts a stale, unmodified test file.
 *
 * git is the source of truth for "what changed," so this engine holds NO
 * session state: no red/green phase machine, no tracked test/source sets, no
 * snapshot. The pre-commit "did tests pass?" gate (`verified`) is a separate
 * concern that lives with the guardrails/handler verification state.
 */

import fs from "node:fs";
import path from "node:path";
import { changeSetCoversSource, isSourceFile } from "./file-classifier.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A TDD write-order violation, surfaced as an actionable warning. */
export interface TddViolation {
  type: "source-before-test";
  file: string;
}

/** Git operations the checker needs, injected for testability. */
export interface TddGitDeps {
  /**
   * Repo-relative paths in the working-tree change set (staged + unstaged +
   * untracked). Returns an empty array when the tree is clean or on failure.
   */
  workingTreeFiles: (cwd: string) => string[];
  /**
   * True when `cwd` is inside a git working tree. When false the check
   * silently no-ops (TDD discipline requires git to detect test/source
   * changes).
   */
  isGitRepo: (cwd: string) => boolean;
}

// ---------------------------------------------------------------------------
// Violation message
// ---------------------------------------------------------------------------

/**
 * Concise, actionable warning text for a TDD write-order violation. Names the
 * offending file and states the remedy. Under the change-set model a pre-existing
 * test file does NOT satisfy the rule — the change must include a test change —
 * so the message does not offer "confirm existing tests" as an escape.
 */
export function describeTddViolation(violation: TddViolation): string {
  return (
    `⚠️ TDD: editing source "${violation.file}" with no corresponding test change. ` +
    "Write or update a test for this file first."
  );
}

// ---------------------------------------------------------------------------
// Enforcement engine
// ---------------------------------------------------------------------------

/**
 * Nearest existing ancestor directory of `dir`: walk up until a segment exists
 * on disk, so git can resolve the repo even when `dir` itself doesn't exist yet
 * (e.g. writing the first file into a brand-new directory). Falls back to the
 * process cwd if no ancestor exists.
 */
function existingAncestor(dir: string): string {
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    try {
      if (cur && fs.existsSync(cur) && fs.statSync(cur).isDirectory()) return cur;
    } catch {
      // ignore stat errors, keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached filesystem root
    cur = parent;
  }
  return process.cwd();
}

/**
 * Stateless TDD write-order checker.
 *
 * Constructed once with injected git deps; {@link checkSourceWrite} is a pure
 * query that does not mutate anything. The repo for a given source is resolved
 * from the source's directory so the check works across multi-repo working
 * trees (the source's own repo is where its corresponding test lives).
 */
export class TddEnforcement {
  constructor(private readonly git: TddGitDeps) {}

  /**
   * Would writing/editing `sourcePath` violate TDD write-order? Returns a
   * violation when `sourcePath` is a real source file inside a git repo and no
   * corresponding test file is present in the current working-tree change set.
   * Returns null otherwise — including non-source files, test files, and
   * non-git trees (silent no-op).
   *
   * Does not mutate.
   */
  checkSourceWrite(sourcePath: string): TddViolation | null {
    if (!isSourceFile(sourcePath)) return null;
    // The source's own directory may not exist yet (writing a NEW file into a NEW
    // dir). git resolves the enclosing repo from any existing ancestor, so walk
    // up to the nearest directory that exists — falling back to the cwd — before
    // asking git about it.
    const repoCwd = existingAncestor(path.dirname(sourcePath));
    if (!this.git.isGitRepo(repoCwd)) return null;
    const changeSet = this.git.workingTreeFiles(repoCwd);
    if (changeSetCoversSource(sourcePath, changeSet)) return null;
    return { type: "source-before-test", file: sourcePath };
  }
}

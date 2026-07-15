// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * `.featyard/` force-add guardrail.
 *
 * The `.featyard/` directory is a junction to featyard's external artifact storage
 * (~/.pi/featyard/artifacts/<key>/). It is auto-created on extension load and
 * auto-added to `.gitignore`. Its contents (task-plans, research, reviews,
 * known-issues) must NEVER enter the repo history.
 *
 * Agents following review/commit skill prompts sometimes `git add -f` a `.featyard/` file
 * to bypass the ignore. This guardrail hard-blocks any `git add` that uses
 * `-f`/`--force` and would pull in `.featyard/` paths — explicitly (a path resolving
 * under `.featyard/`) or via a force-sweep (`-fA`, `-f --all`, `-f .` when `.featyard/` is
 * under cwd). `.featyard/` always exists when featyard is active, so a force-sweep
 * unconditionally includes it.
 *
 * Pure (parser) + fs-injected (sweep cwd checks) so the parser is unit-testable
 * without a filesystem; the checker accepts a `fs` seam for fake-fs tests.
 */
import * as fsType from "node:fs";
import * as path from "node:path";

import { decomposeWithCwd } from "./shell-decompose.js";

/** Default filesystem reference for sweep cwd checks. */
export const DEFAULT_FS: typeof fsType = fsType;

export interface BlockResult {
  block: true;
  reason: string;
}

export interface GitAddParse {
  /** Always true when returned (parser returns null for non-git-add commands). */
  isGitAdd: boolean;
  /** `-f` / `--force` (or a combined short cluster containing `f`). */
  force: boolean;
  /** `-A` / `--all` / `--no-ignore-removal` (or a cluster containing `A`). */
  sweepAll: boolean;
  /** Positional pathspec tokens (excluding flags), before `--` resolution. */
  pathspecs: string[];
  /** `git -C <dir>` global option before `add`, if present (cwd override). null otherwise. */
  gitCDir: string | null;
}

/** Normalize backslashes to forward slashes for cross-platform path comparison. */
function toFwd(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True if a resolved absolute path has `.featyard` as a path segment (targets the junction). */
function targetsFeatyardSegment(absPath: string): boolean {
  const segs = toFwd(absPath).split("/");
  return segs.includes(".featyard");
}

/**
 * Tokenize a shell argument string into argv tokens, respecting single and
 * double quotes. Backslashes are treated as literal path separators (NOT shell
 * escapes) so Windows backslash paths survive intact for `.featyard/` detection — git
 * pathspecs canonically use forward slashes, but agents on Windows may write
 * backslash paths. For embedded spaces, agents use quotes (handled).
 */
function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let hasBuf = false;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "'") {
      hasBuf = true;
      i++;
      while (i < input.length && input[i] !== "'") {
        buf += input[i];
        i++;
      }
      i++; // skip closing quote
      continue;
    }
    if (ch === '"') {
      hasBuf = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          buf += input[i + 1];
          i += 2;
          continue;
        }
        buf += input[i];
        i++;
      }
      i++; // skip closing quote
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      // Literal backslash (path separator on Windows) — NOT a shell escape.
      buf += input[i];
      hasBuf = true;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasBuf) {
        out.push(buf);
        buf = "";
        hasBuf = false;
      }
      i++;
      continue;
    }
    buf += ch;
    hasBuf = true;
    i++;
  }
  if (hasBuf) out.push(buf);
  return out;
}

/** Short git-add flags that imply force / sweep-all (case-sensitive uppercase A). */
const FORCE_SHORT = "f";
const SWEEP_SHORT = "A";

/**
 * Parse a single (already-split) shell subcommand into a git-add descriptor.
 * Returns null if the subcommand is not a `git ... add` invocation.
 *
 * Recognizes:
 * - `git add`, `git -C <dir> add` (cwd override captured as gitCDir)
 * - `-f` / `--force` (and combined short clusters containing `f`)
 * - `-A` / `--all` / `--no-ignore-removal` (and clusters containing `A`)
 * - positional pathspecs; `--` terminates option parsing
 */
export function parseGitAddCommand(subcommand: string): GitAddParse | null {
  const tokens = tokenizeArgs(subcommand);
  if (tokens.length === 0 || tokens[0] !== "git") return null;

  let force = false;
  let sweepAll = false;
  let gitCDir: string | null = null;
  let addFound = false;
  const pathspecs: string[] = [];
  let i = 1;
  let optionsEnded = false;

  // Scan up to and including the `add` subcommand, collecting global git options
  // (only `-C <dir>` matters here). Everything after `add` is add-specific.
  while (i < tokens.length) {
    const tok = tokens[i];

    // Pre-add: locate the `add` subcommand, capturing `git -C <dir>`.
    if (!addFound) {
      if (tok === "add") {
        addFound = true;
        i++;
        continue;
      }
      if (tok === "-C" || tok === "--git-dir" || tok === "--work-tree") {
        // takes a value — but only -C is meaningful as a cwd override
        if (tok === "-C" && i + 1 < tokens.length) gitCDir = tokens[i + 1];
        i += 2;
        continue;
      }
      // Unknown global git option before `add` — skip it (and an attached =value).
      i++;
      continue;
    }

    // Post-add argument parsing.
    if (optionsEnded) {
      pathspecs.push(tok);
      i++;
      continue;
    }
    if (tok === "--") {
      optionsEnded = true;
      i++;
      continue;
    }
    if (tok === "--force") {
      force = true;
      i++;
      continue;
    }
    if (tok === "--all" || tok === "--no-ignore-removal") {
      sweepAll = true;
      i++;
      continue;
    }
    if (tok.startsWith("--")) {
      // Long option we don't track (e.g. --chmod=+x). Skip; `=value` is inline.
      i++;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // Short flag cluster, e.g. -fA, -Af, -fan, -fn.
      for (const c of tok.slice(1)) {
        if (c === FORCE_SHORT) force = true;
        else if (c === SWEEP_SHORT) sweepAll = true;
        // other short flags (n, p, v, ...) ignored
      }
      i++;
      continue;
    }
    // Bare "-" or positional → pathspec.
    pathspecs.push(tok);
    i++;
  }

  if (!addFound) return null;
  return { isGitAdd: true, force, sweepAll, pathspecs, gitCDir };
}

/** Resolve a pathspec against effective cwd and check whether it lands under `.featyard/`. */
function pathspecTargetsFeatyard(pathspec: string, effectiveCwd: string): boolean {
  // Normalize separators so Windows backslash pathspecs resolve consistently,
  // then resolve `..`/`.` lexically against effective cwd.
  const resolved = path.resolve(effectiveCwd, toFwd(pathspec));
  return targetsFeatyardSegment(resolved);
}

/** Resolve the effective cwd for a parsed command: `git -C <dir>` overrides the tracked cwd. */
function resolveEffectiveCwd(trackedCwd: string | null, baseCwd: string, parse: GitAddParse): string {
  if (parse.gitCDir !== null) return path.resolve(trackedCwd ?? baseCwd, parse.gitCDir);
  return trackedCwd ?? baseCwd;
}

/** True if a `.featyard` directory exists directly under `dir` (cwd-sweep would include it). */
function featyardUnderDir(dir: string, fs: typeof fsType): boolean {
  return fs.existsSync(path.join(dir, ".featyard"));
}
/**
 * Check a full (possibly compound) bash command for a `.featyard/` force-add.
 *
 * Decomposes compound commands (`cd sub && git add ...`) tracking effective cwd,
 * parses each `git add`, and returns a hard block if any subcommand force-adds a
 * `.featyard/` path or force-sweeps while `.featyard/` would be included.
 *
 * @param command raw bash command string
 * @param baseCwd the process cwd (base for `cd` resolution)
 * @param fs filesystem seam (defaults to the real fs)
 */
export function checkFeatyardForceAdd(command: string, baseCwd: string, fs: typeof fsType): BlockResult | null {
  const subcommands = decomposeWithCwd(command, baseCwd);

  for (const { command: sub, effectiveCwd: trackedCwd } of subcommands) {
    const parse = parseGitAddCommand(sub);
    if (!parse?.force) continue;

    const effectiveCwd = resolveEffectiveCwd(trackedCwd, baseCwd, parse);

    // 1. Explicit pathspec targeting .featyard/ → block.
    for (const spec of parse.pathspecs) {
      if (spec === ".") {
        // cwd sweep: block only if .featyard is directly under effective cwd
        if (featyardUnderDir(effectiveCwd, fs)) {
          return blockResult(spec, effectiveCwd);
        }
        continue;
      }
      if (pathspecTargetsFeatyard(spec, effectiveCwd)) {
        return blockResult(spec, effectiveCwd);
      }
    }

    // 2. Force-sweep (-A/--all) → .featyard always exists when featyard is active,
    //    so a repo-wide force-add unconditionally pulls it in. Guard defensively:
    //    only block if a .featyard exists anywhere up the tree from effective cwd.
    if (parse.sweepAll && parse.pathspecs.length === 0) {
      if (featyardExistsUpTree(effectiveCwd, fs)) {
        return blockResultSweep();
      }
    }
  }

  return null;
}

/** Walk up from `dir` looking for a `.featyard` directory (the junction is at the repo/session root). */
function featyardExistsUpTree(startDir: string, fs: typeof fsType): boolean {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, ".featyard"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function blockResult(pathspec: string, effectiveCwd: string): BlockResult {
  return {
    block: true,
    reason:
      "Refused: `git add -f` targets the `.featyard/` junction (external artifact storage). " +
      "`.featyard/` is gitignored and must never be committed. " +
      `Resolved \`${pathspec}\` under ${effectiveCwd} lands in \`.featyard/\`. ` +
      "Stage only your source changes (e.g. `git add <path>` without `-f`).",
  };
}

function blockResultSweep(): BlockResult {
  return {
    block: true,
    reason:
      "Refused: `git add -f -A` (force-sweep) would pull in the gitignored `.featyard/` junction. " +
      "`.featyard/` is external artifact storage and must never be committed. " +
      "Stage only your source changes (e.g. `git add -A` without `-f`).",
  };
}

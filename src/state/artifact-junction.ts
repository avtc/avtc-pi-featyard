// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * .featyard junction — external artifact storage for featyard.
 *
 * featyard writes process artifacts (task-plans, research, reviews) OUT of the git
 * repo into ~/.pi/featyard/artifacts/<key>/ via a repo-side junction (featyard). This keeps the
 * repo clean + survives git-worktree removal (all worktrees of a project aggregate to
 * ONE external key derived from the MAIN repo root).
 *
 * Design (pi-bck/DESIGN-FF-JUNCTION.md):
 * - Cross-platform: `fs.symlinkSync` with type 'junction' on Windows (no admin), 'dir' elsewhere.
 * - Git-FREE project identity: walks up from cwd for `.git` (parses linked-worktree.git files)
 *  with node:fs only — identity resolution never shells out to git. Falls back to cwd when
 *  worktrees are disabled + no.git. (The separate ignore step may shell out to
 *  `git rev-parse --git-common-dir` to locate the common dir, but falls back to fs when the git
 *  binary is absent — so featyard keeps working without git installed either way.)
 * - Throws on real failure (visible + debuggable). Idempotent on re-run.
 */
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

import { log } from "../log.js";

/** Normalize backslashes to forward slashes for cross-platform path comparison. */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Munge an absolute path into featyard's session-style key.
 * Replaces each `:`, `\`, `/` with `-` and wraps with `--...--`.
 *  E:\sync\...\avtc-pi-featyard → --E--sync-...-avtc-pi-featyard--
 * (Matches pi's session-folder munging scheme)
 */
export function mungeSessionKey(absPath: string): string {
  return `--${absPath.replace(/[\\/:]/g, "-")}--`;
}

/**
 * Resolve the MAIN repo root from a working directory WITHOUT using the git binary.
 *
 * - `.git` is a DIRECTORY → cwd is the main worktree; return it.
 * - `.git` is a FILE (linked worktree) → parse `gitdir: <abs>/main/.git/worktrees/<name>`,
 *  strip `/worktrees/<name>` + `/.git` to recover the main repo root.
 * - No `.git` walking up to the fs root → return null (not a git repo).
 *
 * This mirrors `resolveMainRepoPath` in worktree.ts but uses only node:fs (no git subprocess),
 * so it works wherever featyard runs, independent of git availability.
 *
 * @internal exported for testing
 */
export function resolveProjectRootFs(startCwd: string): string | null {
  let dir = path.resolve(startCwd);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const gitPath = path.join(dir, ".git");
    if (existsSync(gitPath)) {
      let isDir = false;
      try {
        isDir = statSync(gitPath).isDirectory();
      } catch {
        // stat failed — treat as not a usable.git, keep walking
      }
      if (isDir) {
        // Main worktree: this directory IS the repo root.
        return dir;
      }
      // Linked worktree:.git is a file pointing at <main>/.git/worktrees/<name>.
      try {
        const content = readFileSync(gitPath, "utf-8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match?.[1]) {
          const gitdir = toForwardSlashes(match[1].trim());
          // Strip optional /worktrees/<name>, then /.git, to reach the main root.
          const mainGitDir = gitdir.replace(/\/worktrees\/[^/]+$/, "");
          const mainRoot = mainGitDir.replace(/\/\.git$/, "");
          if (mainRoot && mainRoot !== mainGitDir) {
            return mainRoot;
          }
        }
      } catch {
        // unreadable.git file — fall through to using this dir
      }
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root, no.git found
    dir = parent;
  }
}

export interface EnsureFeatyardJunctionResult {
  /** External storage dir the.featyard junction points at. */
  externalDir: string;
  /** Session-style key derived from the project root. */
  key: string;
  /** True if the junction was created this call; false if it already existed (idempotent). */
  created: boolean;
  /** How the project root was resolved: "git" (walked to.git) or "cwd" (fallback, no.git). */
  rootSource: "git" | "cwd";
}

/** Resolve the sibling archive base for a junction result: `<externalDir-sibling>/artifacts-archive/<key>`.
 *  Single source of truth for the archiveBase derivation — shared by the background sweep
 *  (workflow-monitor.ts) and the /fy:archive-artifacts manual command (workflow-commands.ts). */
export function resolveArchiveBase(jr: EnsureFeatyardJunctionResult): string {
  return path.join(path.dirname(jr.externalDir), "artifacts-archive", jr.key);
}

/**
 * Resolve the two design-doc roots swept by the design-doc archive: the out-of-repo `.featyard/designs`
 * (local mode, via the junction → `externalDir/designs`) and the in-repo `docs/featyard/designs`
 * (committed mode). Shared by the manual `/fy:archive-designs` command and the background sweep so
 * both always sweep the same pair.
 */
export function resolveDesignsDirs(externalDir: string, cwd: string): string[] {
  return [path.join(externalDir, "designs"), path.join(cwd, "docs", "featyard", "designs")];
}

/**
 * One-time migration of the external storage base from the feature-flow era:
 * `~/.pi/feature-flow` → `~/.pi/featyard`. Idempotent (no-op once `~/.pi/featyard` exists).
 * Best-effort: if another process still holds the old base open (e.g. a running old build), the
 * rename is logged + skipped and retried on the next load — it never propagates.
 */
function migrateLegacyBase(homeDir: string): void {
  const oldBase = path.join(homeDir, ".pi", "feature-flow");
  const newBase = path.join(homeDir, ".pi", "featyard");
  if (!existsSync(oldBase) || existsSync(newBase)) return;
  try {
    renameSync(oldBase, newBase);
    log.info(`[featyard] migrated external storage base ${oldBase} → ${newBase}`);
  } catch (err) {
    log.warn(
      `[featyard] could not migrate base ${oldBase} → ${newBase} (skipping): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * One-time per-repo migration from the feature-flow era: a repo-local `.ff` entry (junction or
 * real dir) is superseded by `.featyard`. Called after the external dir exists and before the
 * `.featyard` link is (re)created.
 *  - `.ff` link (junction/symlink): stale (points at the old `~/.pi/feature-flow` base) → remove
 *    the LINK only (never its target).
 *  - `.ff` real dir: rare (artifacts written in-repo when junction setup had been bypassed) →
 *    merge its contents into the external storage dir, then remove it so the `.featyard` junction
 *    supersedes it without data loss.
 * Best-effort: any failure is logged + swallowed (never blocks junction setup).
 */
function migrateLegacyFeatyardLink(cwd: string, externalDir: string): void {
  const ff = path.join(cwd, ".ff");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(ff); // lstat: does not follow a junction/symlink
  } catch {
    return; // no .ff — nothing to migrate
  }
  try {
    if (stat.isSymbolicLink()) {
      rmSync(ff, { force: true }); // remove the link only, never its target
      log.info("[featyard] removed legacy .ff junction (superseded by .featyard)");
    } else if (stat.isDirectory()) {
      cpSync(ff, externalDir, { recursive: true, force: true }); // merge contents into external store
      rmSync(ff, { recursive: true, force: true });
      log.info("[featyard] merged legacy real .ff directory into external storage and removed it");
    }
  } catch (err) {
    log.warn(
      `[featyard] could not migrate legacy .ff at ${ff} (skipping): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** How to heal a plain real-directory `.featyard` (not a link) encountered during setup. */
export type FeatyardRealDirMode = "rename" | "delete";

/**
 * Idempotently ensure the repo-side `.featyard` junction exists and points at the project's
 * external artifact storage under `~/.pi/featyard/artifacts/<key>/`.
 *
 * Throws if:
 * - branchPolicy is "worktree" but no `.git` is found walking up from cwd (worktrees need git).
 * - an existing `.featyard` entry cannot be removed for re-pointing (visible + debuggable).
 * - the underlying `fs.symlinkSync` fails (permissions, invalid path, unsupported FS).
 *
 * `onRealDir` controls healing of a plain real-directory `.featyard` (not a link):
 *  - "rename": move it aside to `.featyard.pre-junction-<ts>` so its contents survive (safe default
 *  for the main-repo/init path — never loses data).
 *  - "delete": remove it + replace with the junction (worktree checkout — content is also in
 *  git + the external store, so deletion is safe and avoids stale backup dirs in worktrees).
 * Link entries (wrong/stale target) are ALWAYS re-pointed by removing the link only (never the
 * target), regardless of `onRealDir`.
 *
 * All params are required by design (no silent defaults) — callers pass explicit values,
 * including `process.platform` for link-type selection. Never shells out to git; never falls
 * back silently on link failure.
 */
export function ensureFeatyardJunction(
  cwd: string,
  branchPolicy: string,
  homeDir: string,
  onRealDir: FeatyardRealDirMode,
): EnsureFeatyardJunctionResult {
  const resolvedCwd = path.resolve(cwd);

  // 0. One-time base migration from the feature-flow era: ~/.pi/feature-flow -> ~/.pi/featyard.
  //    Best-effort + idempotent: a no-op once ~/.pi/featyard exists, and if another process still
  //    holds the old base open the rename is skipped and retried on the next load. Runs before
  //    externalDir is used so the migrated tree is in place.
  migrateLegacyBase(homeDir);

  // 1. Resolve project root (git-free).
  let projectRoot = resolveProjectRootFs(resolvedCwd);
  let rootSource: "git" | "cwd" = "git";
  if (projectRoot === null) {
    if (branchPolicy === "worktree") {
      throw new Error(
        `[featyard] branchPolicy "worktree" requires a git repository, ` +
          `but no .git was found walking up from ${resolvedCwd}. ` +
          `Run featyard inside a git repo, or switch branchPolicy to "current-branch".`,
      );
    }
    // worktrees off + not a git repo → use cwd as the project identity (no git needed).
    projectRoot = resolvedCwd;
    rootSource = "cwd";
  }

  // 2. Munge to session-style key + locate external storage.
  const key = mungeSessionKey(projectRoot);
  const externalDir = path.join(homeDir, ".pi", "featyard", "artifacts", key);

  // 3. Create the external storage dir (idempotent mkdir). Standard subdirs
  //    (task-plans/research/reviews/feature-state) are NOT pre-created: every writer
  //    either mkdir's its own parent (feature-state save, dated-review path) or goes through
  //    the write/edit tools (which auto-create parents), and every reader guards a missing
  //    dir. Pre-creating them only littered fresh/test projects with empty folders.
  mkdirSync(externalDir, { recursive: true });

  // 3b. One-time migration from the feature-flow era: a repo-local `.ff` entry (junction or
  //     real dir) is superseded by `.featyard`. Best-effort; never blocks junction setup.
  migrateLegacyFeatyardLink(resolvedCwd, externalDir);

  // 4. Ensure the.featyard entry points at THIS project's external dir (idempotent + self-healing).
  //    Windows: junction (no admin); else: directory symlink.
  //    Re-point anything that isn't the correct junction:
  //      - nothing exists → create
  //      - a link to a wrong/stale place → remove the LINK (non-recursive, never touches its
  //        target) + re-create (a foreign dir is never clobbered)
  //      - a plain real directory → controlled by `onRealDir`:
  //          "rename" (default): move it aside to.featyard.pre-junction-<ts> (preserve contents)
  //          "delete": remove + create (worktree checkout; content also in git + external store)
  //    Throws only if an existing entry cannot be moved/removed (visible + debuggable).
  const featyardLink = path.join(resolvedCwd, ".featyard");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  let created = false;
  const currentTarget = readLinkTarget(featyardLink); // link target, or null if not a link / absent

  if (currentTarget !== null && samePath(currentTarget, externalDir)) {
    // Already correctly linked — idempotent no-op.
  } else {
    // currentTarget !== null means a link entry exists (even a stale one whose target is gone,
    // since existsSync follows links and reads false then). Check it first so we short-circuit
    // the extra existsSync syscall in the common link case.
    const isLink = currentTarget !== null;
    const isRealDir = !isLink && existsSync(featyardLink);
    const hadExisting = isLink || isRealDir;
    let renamedTo: string | null = null;
    if (hadExisting) {
      try {
        if (isLink) {
          // Remove a LINK non-recursively — never touches its target (guaranteed across Node
          // versions / platforms). A foreign dir is never clobbered.
          rmSync(featyardLink, { force: true });
        } else if (onRealDir === "rename") {
          // A stray real-dir.featyard (not from a worktree checkout). Preserve it — move it aside so
          // its contents survive on disk for manual recovery. Find a non-clashing backup name.
          renamedTo = uniqueBackupPath(featyardLink);
          renameSync(featyardLink, renamedTo);
        } else {
          // Worktree checkout: the real-dir.featyard's content is also in git + the external store,
          // so deleting it is safe (approved). Remove recursively.
          rmSync(featyardLink, { recursive: true, force: true });
        }
      } catch {
        throw new Error(
          `[featyard] .featyard at ${featyardLink} could not be removed for re-pointing to ${externalDir}. Remove it manually and re-run.`,
        );
      }
    }
    symlinkSync(externalDir, featyardLink, linkType); // throws on failure (visible + debuggable)
    created = true;
    if (renamedTo) {
      log.info(
        `[featyard] backed up existing .featyard directory → ${renamedTo} before creating junction → ${externalDir}`,
      );
    } else if (hadExisting) {
      log.info(
        `[featyard] re-pointed .featyard junction → ${externalDir} (was ${currentTarget ?? "a plain directory"})`,
      );
    } else {
      log.info(`[featyard] created .featyard junction → ${externalDir}`);
    }
  }

  // 5. Ensure the.featyard junction is locally ignored via the repo's `.git/info/exclude` (the
  //    clone-local ignore file), never the shared `.gitignore`, so contributing to other authors'
  //    repos leaves their tracked files pristine. Idempotent + fail-safe (any failure is logged
  //    and skipped — never breaks junction setup). Only inside a git repo.
  if (rootSource === "git") {
    ensureFeatyardLocallyIgnored(resolvedCwd, projectRoot);
  }

  return { externalDir, key, created, rootSource };
}

/**
 * Ensure the `.featyard` junction is locally ignored via the repo's `.git/info/exclude` (the
 * clone-local ignore file under the git common dir), NOT the shared `.gitignore`. featyard's
 * `.featyard/` is per-clone external storage, so its ignore rule belongs in the per-clone ignore file —
 * this keeps a `.gitignore` edit out of other authors' repos (no PR pollution, no maintainer
 * friction). A single entry in the common dir covers ALL linked worktrees.
 *
 * Idempotent: appends a labeled block if `.featyard` is missing, and strips any legacy
 * feature-flow `.ff` line + its comment (the junction was renamed to `.featyard`); a no-op write
 * once clean (an existing `.featyard` or legacy `.featyard/` line counts as already ignored). Fail-safe:
 * any failure (git binary absent, unreadable exclude, read-only FS) is logged and skipped — it never
 * propagates out of `ensureFeatyardJunction`, which has already succeeded.
 *
 * Uses `.featyard` (no trailing slash): the junction is a symlink/junction, not a plain directory, and
 * the trailing-slash form (`.featyard/`) only matches directories — so it fails to ignore the junction
 * path itself.
 */
function ensureFeatyardLocallyIgnored(cwd: string, projectRoot: string): void {
  const gitDir = resolveCommonGitDir(cwd, projectRoot);
  if (!gitDir) return; // no usable git dir — skip silently (best-effort)

  const excludePath = path.join(gitDir, "info", "exclude");
  try {
    const ENTRY = ".featyard";
    const FY_COMMENT = "# featyard artifact junction (external storage)";
    /** True if a line already ignores the junction (`.featyard` or legacy `.featyard/`). */
    const isFeatyardEntry = (line: string): boolean => {
      const t = line.trim();
      return t === ".featyard" || t === ".featyard/";
    };
    /** True for a legacy feature-flow `.ff` line or its comment (superseded by `.featyard`). */
    const isLegacyFfLine = (line: string): boolean => {
      const t = line.trim();
      return t === ".ff" || t === ".ff/" || t === "# feature-flow artifact junction (external storage)";
    };

    let existing = "";
    let hadFile = false;
    if (existsSync(excludePath)) {
      hadFile = true;
      existing = readFileSync(excludePath, "utf-8");
    } else {
      // info/ always exists in a real repo; create it (idempotently) for the unusual case it doesn't.
      mkdirSync(path.join(gitDir, "info"), { recursive: true });
    }

    // Drop legacy feature-flow `.ff` lines + comment (the junction was renamed to `.featyard`),
    // preserving every other line/order. Then ensure `.featyard` is present.
    const allLines = existing.split(/\r?\n/);
    const kept = allLines.filter((ln) => !isLegacyFfLine(ln));
    const hasFeatyard = kept.some(isFeatyardEntry);
    // Already clean + ignored, and nothing legacy to strip → nothing to write (idempotent).
    if (hadFile && hasFeatyard && kept.length === allLines.length) return;
    let body = kept.join("\n");
    if (body && !body.endsWith("\n")) body += "\n";
    if (!hasFeatyard) body += `\n${FY_COMMENT}\n${ENTRY}\n`;

    writeFileSync(excludePath, body, "utf-8");
  } catch (err) {
    log.warn(`[featyard] could not update ${excludePath} (skipping): ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Resolve the git common dir that holds the shared `info/exclude`.
 *
 * 1. Authoritative: `git rev-parse --git-common-dir` — correct across submodules, GIT_DIR, and
 *    linked worktrees. Wrapped so a missing/unusable git binary never breaks setup.
 * 2. fs-only fallback: `<projectRoot>/.git` — the main/common dir for standard main-repo and
 *    linked-worktree layouts. Used when the git binary is absent (the same path that keeps `.featyard`
 *    ignored without git installed).
 *
 * Returns null when neither resolves a usable directory.
 */
function resolveCommonGitDir(cwd: string, projectRoot: string): string | null {
  try {
    // git's stderr is silenced (ignore) so a failed/unusable repo — e.g. an empty `.git`
    // dir used by tests, or a non-git directory — doesn't leak `fatal: not a git repository`
    // into the caller's output. Detection failure is handled by the catch + fs fallback below.
    const out = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      cwd,
    }).trim();
    // rev-parse returns a path relative to cwd (e.g. ".git", "../../.git") — resolve it.
    if (out) {
      const resolved = path.resolve(cwd, out);
      if (existsSync(resolved)) return resolved;
    }
  } catch {
    // git binary absent / not a usable repo → fall through to the fs fallback.
  }
  try {
    const fsGitDir = path.join(projectRoot, ".git");
    if (existsSync(fsGitDir) && statSync(fsGitDir).isDirectory()) return fsGitDir;
  } catch {
    // ignore
  }
  return null;
}

/** Read a junction/symlink target, returning null if unreadable or not a link. */
function readLinkTarget(linkPath: string): string | null {
  try {
    return readlinkSync(linkPath);
  } catch {
    return null;
  }
}

/** Compare two paths for equality after normalization (forward slashes; case-insensitive on Windows). */
function samePath(a: string | null, b: string): boolean {
  if (!a) return false;
  const na = toForwardSlashes(path.resolve(a));
  const nb = toForwardSlashes(path.resolve(b));
  if (process.platform === "win32") {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/**
 * Build a non-clashing backup path for an existing `.featyard` real directory: `.featyard.pre-junction-<ts>`,
 * appending `-<n>` until a free name is found (so repeated heals never clobber earlier backups).
 */
function uniqueBackupPath(featyardLink: string): string {
  const base = `${featyardLink}.pre-junction-${Date.now()}`;
  let candidate = base;
  let n = 1;
  while (existsSync(candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

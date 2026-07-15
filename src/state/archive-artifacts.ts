// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Archive engine for stale feature artifacts + state.
 *
 * Design (docs/featyard/designs/2026-06-29-done-feature-artifact-lifecycle-design.md):
 * featyard writes process artifacts (task-plans, research, reviews, feature-state) OUT of the
 * git repo under a `.featyard` junction → `~/.pi/featyard/artifacts/<key>/`. Over time, completed and
 * abandoned features leave stale artifact dirs behind. This module relocates them to a sibling
 * `artifacts-archive/<key>/` tree, preserving them (move-not-delete) so the operation is reversible.
 *
 * Two drivers share this engine:
 *  - `archiveStaleArtifacts` — the background sweep (runs once on activation then every 24h,
 *  subagent-skipped, defers to the next microtask). Threshold comes from the caller (the activation/timer read
 *  the setting) — this module does NOT import the settings layer (dependency inversion), keeping
 *  it a pure, unit-testable leaf.
 *  - `archiveArtifactsOlderThan` — the manual `/fy:archive-artifacts <days>` command (on demand,
 *  not subagent-skipped, supports `excludeSlug` to protect the active in-session feature).
 *
 * Routing (where a candidate lands in the archive — MIRRORS the live tree so the archive is a
 * tree-copy of `.featyard/`):
 *  - a feature's artifacts archive as ONE logical unit (all-or-nothing, by the newest mtime across
 *  the whole group — so a slug's old reviews/ and fresh research/ never split across `.featyard/` and
 *  the archive), but each member lands at its tree-mirror path: `archiveBase/<area>/<slug>/` (dirs)
 *  or `archiveBase/<area>/<file>` (flat files). So `reviews/<slug>/` → `archiveBase/reviews/<slug>/`,
 *  `task-plans/<slug>-task-plan.md` → `archiveBase/task-plans/<slug>-task-plan.md`, etc.
 *  - bare `<YYYY-MM-DD>` date-fallback dir → `archiveBase/<area>/<date>/` (slug-less; each area is an
 *  INDEPENDENT group, since fallbacks have no slug to bind them).
 *  - bare files under an area (orphan research outputs) → `archiveBase/<area>/<file>`, keeping their
 *  name+extension (the slug key drives only the all-or-nothing decision, not the destination).
 *
 * mtime (not the folder-name date) is the age signal — immune to the wrong-year-in-name typos local
 * models sometimes write. The folder name only decides date-fallback-vs-slug routing.
 *
 * Failure mode: best-effort log+continue — per-item errors are collected in `errors[]`; a failure
 * never aborts the remaining items and never touches the `.featyard` junction (all paths are absolute and
 * derived from `externalDir`/`archiveBase`, which are siblings under the external store, not the
 * junction itself). Move primitive is idempotent + atomic (renameSync) with a copy+remove fallback
 * for cross-volume (EXDEV) and dest-already-exists (merge) cases.
 */
import { cpSync, type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import * as path from "node:path";

import { isSubagentSession } from "./state-persistence.js";

export const MS_PER_DAY = 86_400_000;

/**
 * True iff `target` resolves to `base` itself or strictly inside it.
 *
 * Path-safety containment guard: used to reject archive destinations built from readdirSync
 * basenames that could escape `archiveBase` via traversal (`..`, absolute segments, or OS-specific
 * separators in a filename). Uses `path.resolve` so `..` components are normalized away before the
 * prefix check. Single-user/local trust model makes this defense-in-depth, but a planted or
 * cross-OS-authored filename must never yield a write outside the archive tree.
 */
export function isPathInside(base: string, target: string): boolean {
  const rb = path.resolve(base);
  const rt = path.resolve(target);
  return rt === rb || rt.startsWith(rb.endsWith(path.sep) ? rb : rb + path.sep);
}

/** A single source → destination move within an archive group. */
export interface ArchiveMember {
  /** Absolute source path (a directory or a file). */
  src: string;
  /** Absolute destination path (the source is moved here). */
  dest: string;
}

/** A logical unit of archiving: one slug (all areas + state) or one date-fallback dir. */
export interface ArchiveGroup {
  /** Slug name, or `_date-fallback/<date>/<area>` for date-fallback groups. */
  key: string;
  /** True for bare-`<date>` date-fallback dirs; false for slug groups. */
  isDateFallback: boolean;
  /** The src→dest moves that make up this group. */
  members: ArchiveMember[];
}

export interface EnumerateArchiveSetOptions {
  /** Live artifacts root (holds task-plans/, research/, reviews/, feature-state). */
  externalDir: string;
  /** Archive root (siblings: live `<key>/` + archive `artifacts-archive/<key>/`). */
  archiveBase: string;
  /** Archive candidates whose newest mtime is older than this many days. */
  maxAgeDays: number;
  /** When set (non-null), the whole slug group matching this slug is excluded (active-feature protection). */
  excludeSlug?: string | null;
  /** Injection point for the current time (ms since epoch); defaults to Date.now. */
  now?: number;
}

export interface EnumerateArchiveSetResult {
  /** Groups old enough to archive (and not excluded). */
  stale: ArchiveGroup[];
  /** Absolute source paths that were excluded via `excludeSlug`. */
  skipped: string[];
}

export type MoveResult = { ok: true } | { ok: false; error: string };

/**
 * The fs primitives moveArtifact depends on. Injected (required, not optional) so tests can
 * substitute fakes — vitest cannot intercept `node:fs` builtin named imports under jiti, so the
 * EXDEV cross-volume + cp/rm-failure branches could not be exercised any other way. Production
 * callers pass {@link REAL_FS_MOVE_OPS} (the real `node:fs` bindings).
 */
export interface FsMoveOps {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
  renameSync: (src: string, dest: string) => void;
  cpSync: (src: string, dest: string, opts: { recursive: boolean; force: boolean }) => void;
  rmSync: (path: string, opts: { recursive: boolean; force: boolean }) => void;
}

/** The real `node:fs` bindings for {@link FsMoveOps} — passed by production callers of moveArtifact. */
export const REAL_FS_MOVE_OPS: FsMoveOps = {
  existsSync,
  mkdirSync,
  renameSync,
  cpSync,
  rmSync,
};

/** A bare ISO date (`YYYY-MM-DD`) — identifies date-fallback dirs (no slug). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Move a file or directory from `src` to `dest`, never throwing.
 *
 * Ensures the destination parent exists first (`mkdirSync({recursive:true})`) — without it the
 * first archive's `renameSync` throws `ENOENT` (the destination tree does not pre-exist), which the
 * EXDEV-only fallback would not catch. Then attempts an atomic same-volume `renameSync`; on ANY
 * failure falls back to a recursive `cpSync({force})` + `rmSync` (handles cross-volume `EXDEV` and
 * dest-already-exists merge). Returns `{ok:false, error}` for a missing source or an unrecoverable
 * failure (collected by callers, never thrown).
 */
export function moveArtifact(src: string, dest: string, fs: FsMoveOps): MoveResult {
  if (!fs.existsSync(src)) {
    return { ok: false, error: `archive move: source missing: ${src}` };
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (e) {
    return { ok: false, error: `archive move: dest parent mkdir failed for ${dest}: ${(e as Error).message}` };
  }
  try {
    fs.renameSync(src, dest);
    return { ok: true };
  } catch (renameErr) {
    // Cross-volume (EXDEV) or dest-already-exists — fall back to copy (merge) + remove.
    // The two steps are separated so a failure names the actual failing step (a copy success +
    // remove failure leaves the source for the next sweep to re-merge, idempotently).
    try {
      fs.cpSync(src, dest, { recursive: true, force: true });
    } catch (cpErr) {
      return {
        ok: false,
        error: `archive move: ${src} → ${dest} failed (rename: ${(renameErr as Error).message}; copy: ${(cpErr as Error).message})`,
      };
    }
    try {
      fs.rmSync(src, { recursive: true, force: true });
    } catch (rmErr) {
      return {
        ok: false,
        error: `archive move: ${src} → ${dest} copied but source cleanup failed (rename: ${(renameErr as Error).message}; remove: ${(rmErr as Error).message})`,
      };
    }
    return { ok: true };
  }
}

/**
 * Newest mtime (ms since epoch) anywhere in the tree rooted at `absPath`.
 *
 * A file → its own mtime. A non-empty directory → the recursive max of its contents' mtimes
 * (the directory's own mtime is NOT used — content is the age signal). An empty or unreadable
 * directory, or a nonexistent path → 0 (treated as ancient → stale, since empty dirs are cruft).
 */
export function newestMtimeInTree(absPath: string): number {
  let stats: ReturnType<typeof lstatSync>;
  try {
    // lstatSync (not statSync) so symlinks are treated as LEAVES — never dereferenced. A symlink
    // loop in the tree would otherwise cause unbounded recursion (defense-in-depth).
    stats = lstatSync(absPath);
  } catch {
    return 0;
  }
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }
  const entries = tryReadDir(absPath);
  if (entries === null || entries.length === 0) {
    return 0;
  }
  let max = 0;
  for (const entry of entries) {
    max = Math.max(max, newestMtimeInTree(path.join(absPath, entry.name)));
  }
  return max;
}

/**
 * Derive the slug key for a task-plan file name. The convention is `<slug>-task-plan.md`; a file
 * that does not match falls back to its basename without the `.md` extension (so old-shape flat
 * fallback files still route by a slug-like key and archive as a lone group).
 */
function taskPlanSlug(name: string): string {
  if (/-task-plan\.md$/i.test(name)) {
    return name.replace(/-task-plan\.md$/i, "");
  }
  return name.replace(/\.md$/i, "");
}

/** Read a directory's entries (with types), returning null if it is absent or unreadable. */
function tryReadDir(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** The areas (subdirs of `externalDir`) that hold per-slug artifact dirs. */
const DIR_AREAS = ["reviews", "research"] as const;
/** The flat-file area: task-plans holds a mix of `<slug>-*.md` files and bare-`<date>/` dirs. */
const TASK_PLANS = "task-plans";
/** The state area: `feature-state/` holds one `<slug>.json` file per feature. */
const FEATURE_STATE = "feature-state";

interface Candidate {
  key: string;
  isDateFallback: boolean;
  member: ArchiveMember;
}

/**
 * Scan `externalDir`'s artifact areas and group candidates by their archive key.
 *
 * - `reviews/` + `research/` hold per-slug DIRECTORIES, bare-`<date>/` date-fallback dirs, and
 *  occasional bare files (orphan research outputs not tied to a feature).
 * - `task-plans/` holds a MIX: flat `<slug>-task-plan.md` files (slug-routed) and bare-`<date>/`
 *  directories (date-fallback, the post-normalization shape); also legacy `<slug>/` or
 *  `<date>-<topic>/` directories (slug-routed).
 * - `feature-state/` holds one `<slug>.json` file per feature (slug-routed).
 *
 * Slug groups merge a slug's members across ALL areas (all-or-nothing — a feature archives as one
 * unit, gated on the newest mtime across all its files). Date-fallback dirs are slug-less → each
 * `<area>/<date>` dir is its own independent group keyed `_date-fallback/<date>/<area>`.
 *
 * The archive MIRRORS the live tree: every member routes to `archiveBase/<area>/<name>` (dirs) or
 * `archiveBase/<area>/<file>` (flat files), so the archive is a tree-copy of the live layout and a
 * bare file keeps its name+extension. The slug key drives only the all-or-nothing DECISION, not the
 * physical destination (a feature's files land across the area folders, as in the live store).
 */
function collectCandidates(externalDir: string, archiveBase: string): Candidate[] {
  const candidates: Candidate[] = [];

  // 1. reviews/ + research/ — per-slug dirs + bare-<date> date-fallback dirs (+ occasional bare
  // files). The archive MIRRORS the live tree ({area}/{name}) so restoring is a tree copy and
  // bare files keep their name+extension (an earlier {name}/{area} inversion turned a bare file
  // like `foo.md` into a `foo.md/research` folder, losing the name). The slug key still groups a
  // feature's areas for all-or-nothing archival; only the destination layout mirrors the live tree.
  for (const area of DIR_AREAS) {
    const areaDir = path.join(externalDir, area);
    const entries = tryReadDir(areaDir);
    if (entries === null) continue; // area absent — no candidates here
    for (const entry of entries) {
      const name = entry.name;
      if (DATE_RE.test(name)) {
        candidates.push({
          key: `_date-fallback/${name}/${area}`,
          isDateFallback: true,
          member: { src: path.join(areaDir, name), dest: path.join(archiveBase, area, name) },
        });
      } else {
        candidates.push({
          key: name,
          isDateFallback: false,
          member: { src: path.join(areaDir, name), dest: path.join(archiveBase, area, name) },
        });
      }
    }
  }

  // 2. task-plans/ — mixed flat files + bare-<date> dirs (+ slug/topic dirs). Archive mirrors the
  // live tree: dirs → task-plans/{name}, flat files → task-plans/{name}. The slug key still groups
  // a feature's areas for all-or-nothing archival.
  const tpDir = path.join(externalDir, TASK_PLANS);
  const tpEntries = tryReadDir(tpDir);
  if (tpEntries) {
    for (const entry of tpEntries) {
      const name = entry.name;
      const src = path.join(tpDir, name);
      if (entry.isDirectory() && DATE_RE.test(name)) {
        // Bare-<date> dir (post-normalization shape) → date-fallback.
        candidates.push({
          key: `_date-fallback/${name}/${TASK_PLANS}`,
          isDateFallback: true,
          member: { src, dest: path.join(archiveBase, TASK_PLANS, name) },
        });
      } else if (entry.isDirectory()) {
        // A slug/topic dir → slug-routed (whole dir moves to task-plans/{name}).
        candidates.push({
          key: name,
          isDateFallback: false,
          member: { src, dest: path.join(archiveBase, TASK_PLANS, name) },
        });
      } else {
        // A flat `<slug>-*.md` file → slug-routed (keyed by the derived slug), archived flat at
        // task-plans/{name} (mirrors the live flat layout).
        const slug = taskPlanSlug(name);
        candidates.push({
          key: slug,
          isDateFallback: false,
          member: { src, dest: path.join(archiveBase, TASK_PLANS, name) },
        });
      }
    }
  }

  // 3. feature-state/ — one <slug>.json file per feature (slug-routed). Archive mirrors the live
  // flat layout: feature-state/{name}.
  const fsDir = path.join(externalDir, FEATURE_STATE);
  const fsEntries = tryReadDir(fsDir);
  if (fsEntries) {
    for (const entry of fsEntries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const slug = name.replace(/\.json$/i, "");
      candidates.push({
        key: slug,
        isDateFallback: false,
        member: {
          src: path.join(fsDir, name),
          dest: path.join(archiveBase, FEATURE_STATE, name),
        },
      });
    }
  }

  // Path-safety containment: drop any candidate whose resolved dest escapes `archiveBase`
  // (a planted or cross-OS-authored filename must never yield a write outside the archive tree).
  // Defense-in-depth under the single-user trust model; silently skipped (best-effort).
  return candidates.filter((c) => isPathInside(archiveBase, c.member.dest));
}

/**
 * Enumerate the archive set: group candidates by key, drop excluded slugs, and keep only groups
 * whose newest mtime across ALL members is older than `maxAgeDays` from `now`.
 */
export function enumerateArchiveSet(opts: EnumerateArchiveSetOptions): EnumerateArchiveSetResult {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.maxAgeDays * MS_PER_DAY;

  const candidates = collectCandidates(opts.externalDir, opts.archiveBase);

  // Group members by key (merges a slug's areas + state; date-fallback keys are already unique).
  const byKey = new Map<string, { isDateFallback: boolean; members: ArchiveMember[] }>();
  for (const c of candidates) {
    let group = byKey.get(c.key);
    if (!group) {
      group = { isDateFallback: c.isDateFallback, members: [] };
      byKey.set(c.key, group);
    }
    group.members.push(c.member);
  }

  const stale: ArchiveGroup[] = [];
  const skipped: string[] = [];

  for (const [key, group] of byKey) {
    // Exclude the active feature's whole slug group (date-fallback groups never match a slug).
    if (!group.isDateFallback && opts.excludeSlug != null && key === opts.excludeSlug) {
      for (const m of group.members) skipped.push(m.src);
      continue;
    }
    // Age = newest mtime across the whole group (one-unit invariant).
    let newest = 0;
    for (const m of group.members) {
      newest = Math.max(newest, newestMtimeInTree(m.src));
    }
    if (newest < cutoff) {
      stale.push({ key, isDateFallback: group.isDateFallback, members: group.members });
    }
  }

  return { stale, skipped };
}

/**
 * Move every member of every stale group via the shared move primitive. Collects per-item errors
 * (best-effort) rather than aborting — shared by the background sweep and the manual command so
 * behavior is identical (single shared helper, no logic fork).
 */
function moveStaleMembers(stale: ArchiveGroup[]): {
  archived: string[];
  errors: string[];
  archivedSlugGroups: number;
  archivedDateFallbackGroups: number;
} {
  const archived: string[] = [];
  const errors: string[] = [];
  let archivedSlugGroups = 0;
  let archivedDateFallbackGroups = 0;
  for (const group of stale) {
    let allMembersMoved = true;
    for (const member of group.members) {
      const result = moveArtifact(member.src, member.dest, REAL_FS_MOVE_OPS);
      if (result.ok) {
        archived.push(member.dest);
      } else {
        errors.push(result.error);
        allMembersMoved = false;
      }
    }
    // A group counts as archived only when every member moved (the all-or-nothing unit).
    if (allMembersMoved) {
      if (group.isDateFallback) archivedDateFallbackGroups++;
      else archivedSlugGroups++;
    }
  }
  return { archived, errors, archivedSlugGroups, archivedDateFallbackGroups };
}

/**
 * Background sweep entry point — archives every stale group older than `maxAgeDays`.
 *
 * Skips ALL work in subagent sessions (`isSubagentSession`) and yields once before doing any fs
 * work so the caller (activation) proceeds synchronously — the sweep runs in the microtask queue,
 * not blocking pi start. The caller passes the threshold (derived from the setting) — this module
 * does NOT import the settings layer (dependency inversion). Failures are best-effort: per-item
 * errors land in `errors[]`, the promise never rejects.
 */
export async function archiveStaleArtifacts(opts: {
  externalDir: string;
  archiveBase: string;
  maxAgeDays: number;
  now?: number;
}): Promise<{ archived: string[]; errors: string[]; archivedSlugGroups: number; archivedDateFallbackGroups: number }> {
  if (isSubagentSession()) {
    return { archived: [], errors: [], archivedSlugGroups: 0, archivedDateFallbackGroups: 0 };
  }
  // Yield so the activation caller (`archiveStaleArtifacts` awaited inside an async sweep
  // callback) returns before the fs sweep begins. NOTE: this defers only to the next microtask — the synchronous fs body (the
  // recursive newestMtimeInTree walk + moves) still runs on the event loop. Acceptable at current
  // scale (sub-100ms at <500 files); for future scale, chunk the walk/moves across setImmediate ticks.
  await Promise.resolve();

  const { stale } = enumerateArchiveSet({
    externalDir: opts.externalDir,
    archiveBase: opts.archiveBase,
    maxAgeDays: opts.maxAgeDays,
    now: opts.now,
  });
  return moveStaleMembers(stale);
}

/**
 * Manual-command entry point — archives every group older than `days`, with an `excludeSlug` to
 * protect the active in-session feature. Does NOT skip subagent sessions (the command runs on
 * demand, regardless of session type). Shares `enumerateArchiveSet` + `moveArtifact` with the
 * background sweep so behavior is identical (single shared helper, no logic fork).
 */
export async function archiveArtifactsOlderThan(opts: {
  externalDir: string;
  archiveBase: string;
  days: number;
  excludeSlug?: string | null;
  now?: number;
}): Promise<{
  archived: string[];
  skipped: string[];
  errors: string[];
  archivedSlugGroups: number;
  archivedDateFallbackGroups: number;
}> {
  const { stale, skipped } = enumerateArchiveSet({
    externalDir: opts.externalDir,
    archiveBase: opts.archiveBase,
    maxAgeDays: opts.days,
    excludeSlug: opts.excludeSlug,
    now: opts.now,
  });
  return { ...moveStaleMembers(stale), skipped };
}

// ── Design docs (two-source sweep) ───────────────────────────────────────
// Design docs are flat `*-design.md` files that may live in EITHER recognized dir — the
// in-repo `docs/featyard/designs/` (committed) or the out-of-repo `.featyard/designs/` (local, via the
// junction). Unlike the slug-grouped artifact set above, each design doc archives independently
// (no cross-area grouping). Reuses `moveArtifact` so the move is the same atomic/EXDEV-safe
// primitive as the rest of the engine.

/** A design doc pending archive: its source + its archive destination. */
export interface DesignArchiveMember {
  src: string;
  dest: string;
  /** The feature slug derived from the filename (`<slug>-design.md`). */
  slug: string;
}

/**
 * Derive a feature slug from a design-doc filename (`<slug>-design.md`). Returns the basename
 * without the `-design.md` suffix; a name that does not match falls back to the basename minus the
 * `.md` extension (so an oddly-named file still routes under a slug-like key).
 */
function designDocSlug(name: string): string {
  if (/-design\.md$/i.test(name)) {
    return name.replace(/-design\.md$/i, "");
  }
  return name.replace(/\.md$/i, "");
}

/**
 * Enumerate design docs older than `maxAgeDays` across one or more roots (typically BOTH
 * `.featyard/designs` and `docs/featyard/designs`). Each `*-design.md` file is its own archive unit, keyed by
 * the slug derived from its name, and routes to `archiveBase/designs/<file>` — mirroring the live
 * `designs/` layout so all archived designs stay browsable together. The active feature's doc
 * (`<excludeSlug>-design.md`) is skipped, not archived. A missing/unreadable dir is a no-op
 * (best-effort). Age is the file's own mtime (a design doc is a leaf, not a tree).
 */
export function enumerateDesigns(opts: {
  designsDirs: readonly string[];
  archiveBase: string;
  maxAgeDays: number;
  excludeSlug?: string | null;
  now?: number;
}): { stale: DesignArchiveMember[]; skipped: string[] } {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.maxAgeDays * MS_PER_DAY;

  const stale: DesignArchiveMember[] = [];
  const skipped: string[] = [];

  for (const dir of opts.designsDirs) {
    let entries: Dirent[] | null;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // dir absent/unreadable — no candidates here
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/-design\.md$/i.test(entry.name)) continue;
      const slug = designDocSlug(entry.name);
      const src = path.join(dir, entry.name);
      // Exclude the active feature's design doc (resume would be artifact-degraded without it).
      if (opts.excludeSlug != null && slug === opts.excludeSlug) {
        skipped.push(src);
        continue;
      }
      const dest = path.join(opts.archiveBase, "designs", entry.name);
      // Path-safety containment: drop a candidate whose dest escapes archiveBase.
      if (!isPathInside(opts.archiveBase, dest)) continue;
      // Age = the file's own mtime (leaf, not a tree).
      if (newestMtimeInTree(src) < cutoff) {
        stale.push({ src, dest, slug });
      }
    }
  }

  return { stale, skipped };
}

/**
 * Manual-command / sweep entry point for design docs — archives every design doc older than
 * `days` across the given roots, with an `excludeSlug` to protect the active in-session feature.
 * Does NOT skip subagent sessions (mirrors `archiveArtifactsOlderThan` — the manual command runs on
 * demand; the background sweep caller decides subagent-skipping). Shares `moveArtifact` with the
 * rest of the engine so the move is identical. Failures are best-effort: per-item errors land in
 * `errors[]`, the promise never rejects. A group (here, a single file) counts as archived only
 * when its move succeeded.
 */
export async function archiveDesignsOlderThan(opts: {
  designsDirs: readonly string[];
  archiveBase: string;
  days: number;
  excludeSlug?: string | null;
  now?: number;
}): Promise<{ archived: string[]; skipped: string[]; errors: string[]; archivedCount: number }> {
  const { stale, skipped } = enumerateDesigns({
    designsDirs: opts.designsDirs,
    archiveBase: opts.archiveBase,
    maxAgeDays: opts.days,
    excludeSlug: opts.excludeSlug,
    now: opts.now,
  });
  const archived: string[] = [];
  const errors: string[] = [];
  for (const member of stale) {
    const result = moveArtifact(member.src, member.dest, REAL_FS_MOVE_OPS);
    if (result.ok) {
      archived.push(member.dest);
    } else {
      errors.push(result.error);
    }
  }
  return { archived, skipped, errors, archivedCount: archived.length };
}

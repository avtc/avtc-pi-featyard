// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  archiveArtifactsOlderThan,
  archiveStaleArtifacts,
  enumerateArchiveSet,
  type FsMoveOps,
  isPathInside,
  MS_PER_DAY,
  moveArtifact,
  newestMtimeInTree,
  REAL_FS_MOVE_OPS,
} from "../../src/state/archive-artifacts.js";
import { disableSubagentMode, enableSubagentMode } from "../helpers/workflow-monitor-test-helpers.js";

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `af-${prefix}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

/** Build an { externalDir, archiveBase } fixture pair under one temp root. */
function makeFixture(prefix: string): { root: string; externalDir: string; archiveBase: string } {
  const root = makeTempDir(prefix);
  const externalDir = path.join(root, "external");
  const archiveBase = path.join(root, "archive");
  for (const sub of ["reviews", "research", "task-plans", "feature-state"]) {
    mkdirSync(path.join(externalDir, sub), { recursive: true });
  }
  mkdirSync(archiveBase, { recursive: true });
  return { root, externalDir, archiveBase };
}

/** Set a path's mtime (and atime) to a fixed point in time (seconds). */
function setMtime(p: string, mtimeSeconds: number): void {
  utimesSync(p, mtimeSeconds, mtimeSeconds);
}

/** Write a file (creating parent dirs); stamps its mtime when `mtimeSeconds` is non-null. */
function writeFile(p: string, content: string, mtimeSeconds: number | null): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mtimeSeconds !== null) setMtime(p, mtimeSeconds);
}

// A fixed "now" for deterministic age math. 2026-06-30T00:00:00Z.
const NOW = Date.parse("2026-06-30T00:00:00Z");
const NOW_SEC = NOW / 1000;
const DAY = 86_400; // seconds

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  disableSubagentMode();
});

// ============================================================
// isPathInside + MS_PER_DAY (path-safety containment + day-constant)
// ============================================================
describe("isPathInside (path-safety containment guard,)", () => {
  test("accepts a target strictly inside base", () => {
    const base = path.join(os.tmpdir(), "archive-base");
    expect(isPathInside(base, path.join(base, "slug", "reviews", "rev.md"))).toBe(true);
    expect(isPathInside(base, path.join(base, "_date-fallback", "2026-01-01"))).toBe(true);
  });

  test("rejects a target that escapes base via.. traversal", () => {
    const base = path.join(os.tmpdir(), "archive-base");
    // path.join collapses this to <tmp>/archive-base/../evil = <tmp>/evil — OUTSIDE base.
    const escaped = path.join(base, "..", "evil", "reviews");
    expect(isPathInside(base, escaped)).toBe(false);
  });

  test("rejects a sibling that merely shares a prefix (slug-named base)", () => {
    // archive-base must not be confused with archive-base-other (prefix-but-not-dir match).
    const base = path.join(os.tmpdir(), "archive-base");
    const sibling = path.join(os.tmpdir(), "archive-base-other", "reviews");
    expect(isPathInside(base, sibling)).toBe(false);
  });

  test("rejects an absolute path unrelated to base", () => {
    const base = path.join(os.tmpdir(), "archive-base");
    expect(isPathInside(base, path.join(os.homedir(), "secret", "evil.md"))).toBe(false);
  });

  test("base itself is considered inside (boundary)", () => {
    const base = path.join(os.tmpdir(), "archive-base");
    expect(isPathInside(base, base)).toBe(true);
  });
});

describe("MS_PER_DAY constant", () => {
  test("equals 24 hours in milliseconds", () => {
    expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});

// ============================================================
// moveArtifact
// ============================================================
describe("moveArtifact", () => {
  test("renames a file same-volume (src gone, dest present)", () => {
    const root = makeTempDir("mv-file");
    const src = path.join(root, "a.txt");
    const dest = path.join(root, "out", "b.txt");
    writeFile(src, "hello", null);

    const r = moveArtifact(src, dest, REAL_FS_MOVE_OPS);

    expect(r).toEqual({ ok: true });
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe("hello");
  });

  test("creates the dest parent directory when missing (mkdirSync before rename)", () => {
    const root = makeTempDir("mv-mkdir");
    const src = path.join(root, "src.txt");
    const dest = path.join(root, "deeply", "nested", "missing", "dest.txt");
    writeFile(src, "x", null);

    const r = moveArtifact(src, dest, REAL_FS_MOVE_OPS);

    expect(r).toEqual({ ok: true });
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(src)).toBe(false);
  });

  test("renames a directory recursively (contents preserved)", () => {
    const root = makeTempDir("mv-dir");
    const src = path.join(root, "rev");
    const dest = path.join(root, "archive", "rev");
    writeFile(path.join(src, "inner.md"), "inner", null);
    mkdirSync(path.join(src, "sub"), { recursive: true });
    writeFile(path.join(src, "sub", "deep.md"), "deep", null);

    const r = moveArtifact(src, dest, REAL_FS_MOVE_OPS);

    expect(r).toEqual({ ok: true });
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(path.join(dest, "inner.md"), "utf-8")).toBe("inner");
    expect(readFileSync(path.join(dest, "sub", "deep.md"), "utf-8")).toBe("deep");
  });

  test("returns {ok:false} (no throw) when the source is missing", () => {
    const root = makeTempDir("mv-missing");
    const dest = path.join(root, "out.txt");

    const r = moveArtifact(path.join(root, "nope.txt"), dest, REAL_FS_MOVE_OPS);

    expect(r.ok).toBe(false);
    expect(typeof (r as { error: string }).error).toBe("string");
  });

  test("merges when the dest dir already exists (idempotent partial re-run)", () => {
    const root = makeTempDir("mv-merge");
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    // dest pre-exists with one file; src has two (one overlapping, one new).
    writeFile(path.join(dest, "keep.md"), "dest-old", null);
    writeFile(path.join(src, "keep.md"), "src-new", null);
    writeFile(path.join(src, "extra.md"), "extra", null);

    const r = moveArtifact(src, dest, REAL_FS_MOVE_OPS);

    expect(r).toEqual({ ok: true });
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(path.join(dest, "keep.md"), "utf-8")).toBe("src-new"); // force-overwrite
    expect(readFileSync(path.join(dest, "extra.md"), "utf-8")).toBe("extra"); // merged in
  });

  /**
   * Build a FsMoveOps where `overrides` replace specific real ops (the rest delegate to the real
   * node:fs). moveArtifact takes fs as a required param precisely so these branches are testable
   * vitest cannot intercept node:fs builtin named imports under jiti, so the EXDEV/cp/rm-failure
   * paths can only be exercised via injection.
   */
  function fakeFs(overrides: Partial<FsMoveOps>): FsMoveOps {
    return { ...REAL_FS_MOVE_OPS, ...overrides };
  }

  function exdev(): never {
    const e = new Error("cross-device link not permitted");
    (e as NodeJS.ErrnoException).code = "EXDEV";
    throw e;
  }

  test("falls back to copy+remove when renameSync throws EXDEV (cross-volume)", () => {
    const root = makeTempDir("mv-exdev");
    const src = path.join(root, "src.txt");
    const dest = path.join(root, "out", "dest.txt");
    writeFile(src, "payload", null);
    // Simulate a cross-volume rename failure: rename throws EXDEV, cp+rm (real) recover.
    const fs = fakeFs({ renameSync: () => exdev() });

    const r = moveArtifact(src, dest, fs);

    expect(r).toEqual({ ok: true });
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe("payload");
  });

  test("falls back to copy+remove for a DIRECTORY on EXDEV (recursive merge)", () => {
    const root = makeTempDir("mv-exdev-dir");
    const src = path.join(root, "reviews-slug"); // a dir, like reviews/<slug>/
    const dest = path.join(root, "archive", "slug", "reviews");
    writeFile(path.join(src, "rev.md"), "r1", null);
    mkdirSync(path.join(src, "sub"), { recursive: true });
    writeFile(path.join(src, "sub", "deep.md"), "r2", null);
    const fs = fakeFs({ renameSync: () => exdev() });

    const r = moveArtifact(src, dest, fs);

    expect(r).toEqual({ ok: true });
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(path.join(dest, "rev.md"), "utf-8")).toBe("r1");
    expect(readFileSync(path.join(dest, "sub", "deep.md"), "utf-8")).toBe("r2");
  });

  test("returns ok:false naming the copy step when rename fails AND cpSync fails (EXDEV fallback)", () => {
    const root = makeTempDir("mv-copyfail");
    const src = path.join(root, "src.txt");
    const dest = path.join(root, "out", "dest.txt");
    writeFile(src, "payload", null);
    // rename throws EXDEV, then cpSync ALSO fails (e.g. dest volume unwritable) → abort + name step.
    const fs = fakeFs({
      renameSync: () => exdev(),
      cpSync: () => {
        throw new Error("disk full");
      },
    });

    const r = moveArtifact(src, dest, fs);

    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/copy: disk full/);
    expect(existsSync(src)).toBe(true); // source untouched (copy failed, nothing removed)
  });

  test("returns ok:false naming the remove step when cpSync succeeds but rmSync fails", () => {
    const root = makeTempDir("mv-rmfail");
    const src = path.join(root, "src.txt");
    const dest = path.join(root, "out", "dest.txt");
    writeFile(src, "payload", null);
    // rename throws EXDEV, cpSync succeeds (dest written), rmSync fails → source left for next sweep.
    const fs = fakeFs({
      renameSync: () => exdev(),
      rmSync: () => {
        throw new Error("permission denied");
      },
    });

    const r = moveArtifact(src, dest, fs);

    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/copied but source cleanup failed/);
    // Both source and dest exist (copy won; remove failed) — idempotent next sweep.
    expect(existsSync(src)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("payload");
  });

  test("returns ok:false naming the mkdir step when dest parent cannot be created", () => {
    const root = makeTempDir("mv-mkdirfail");
    const src = path.join(root, "src.txt");
    const dest = path.join(root, "out", "dest.txt");
    writeFile(src, "payload", null);
    // mkdirSync for the dest parent throws (e.g. parent path unwritable / ENOSPC) → abort + name step.
    const fs = fakeFs({
      mkdirSync: () => {
        throw new Error("read-only file system");
      },
    });

    const r = moveArtifact(src, dest, fs);

    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/dest parent mkdir failed/);
    expect((r as { error: string }).error).toMatch(/read-only file system/);
    expect(existsSync(src)).toBe(true); // source untouched (mkdir failed before any rename)
    expect(existsSync(dest)).toBe(false); // dest never created
  });
});

// ============================================================
// newestMtimeInTree
// ============================================================
describe("newestMtimeInTree", () => {
  test("returns the file's own mtime for a single file", () => {
    const root = makeTempDir("mt-file");
    const f = path.join(root, "a.txt");
    writeFile(f, "x", NOW_SEC - 5 * DAY);
    expect(newestMtimeInTree(f)).toBeCloseTo((NOW_SEC - 5 * DAY) * 1000, -2);
  });

  test("returns the newest mtime among nested files (recursive max)", () => {
    const root = makeTempDir("mt-nested");
    writeFile(path.join(root, "old.md"), "o", NOW_SEC - 40 * DAY);
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFile(path.join(root, "sub", "fresh.md"), "f", NOW_SEC - 1 * DAY);
    writeFile(path.join(root, "mid.md"), "m", NOW_SEC - 10 * DAY);

    const newest = newestMtimeInTree(root);
    // newest is the fresh file at NOW - 1 day.
    expect(newest).toBeCloseTo((NOW_SEC - 1 * DAY) * 1000, -2);
  });

  test("returns 0 for an empty directory", () => {
    const root = makeTempDir("mt-empty");
    const empty = path.join(root, "empty");
    mkdirSync(empty, { recursive: true });
    expect(newestMtimeInTree(empty)).toBe(0);
  });

  test("returns 0 for a nonexistent path", () => {
    const root = makeTempDir("mt-none");
    expect(newestMtimeInTree(path.join(root, "nope"))).toBe(0);
  });

  test("treats a symlink as a leaf (no dereference, no recursion into loops)", () => {
    // Defense-in-depth: a symlinked entry must NOT be dereferenced (statSync would follow it), or a
    // symlink loop would cause unbounded recursion. lstatSync returns the link's own mtime and the
    // walk does not descend into it.
    const root = makeTempDir("mt-symlink");
    const real = path.join(root, "real");
    writeFile(path.join(real, "deep.md"), "x", NOW_SEC - 1 * DAY); // fresh target
    // A directory containing a symlink that points BACK at an ancestor (a loop). With statSync
    // this recurses forever; with lstatSync the loop link is a leaf.
    const loop = path.join(real, "loop");
    symlinkSync(root, loop); // loop -> root ->... -> loop (cycle)

    // Must terminate and return the symlink's own mtime (a leaf), not dereference into the loop.
    const mtime = newestMtimeInTree(real);
    expect(Number.isFinite(mtime)).toBe(true);
    // The symlink itself was a leaf (lstat), so its own stats were used — confirm it was NOT
    // dereferenced by checking the walk stayed bounded (no throw / no hang = pass above).
    expect(lstatSync(loop).isSymbolicLink()).toBe(true);
  });
});

// ============================================================
// enumerateArchiveSet
// ============================================================
describe("enumerateArchiveSet", () => {
  test("a slug with old reviews + fresh research is NOT stale (one-unit invariant)", () => {
    const { externalDir, archiveBase } = makeFixture("one-unit");
    const slug = "2026-01-01-alpha";
    // reviews/<slug>/ old (40 days)
    writeFile(path.join(externalDir, "reviews", slug, "rev.md"), "r", NOW_SEC - 40 * DAY);
    // research/<slug>/ fresh (1 day) -> newest mtime in the group is fresh
    writeFile(path.join(externalDir, "research", slug, "note.md"), "n", NOW_SEC - 1 * DAY);

    const { stale, skipped } = enumerateArchiveSet({
      externalDir,
      archiveBase,
      maxAgeDays: 30,
      now: NOW,
    });

    expect(stale).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  test("a fully-stale slug yields ONE group spanning all areas + state file", () => {
    const { externalDir, archiveBase } = makeFixture("stale-slug");
    const slug = "2026-01-01-beta";
    writeFile(path.join(externalDir, "reviews", slug, "rev.md"), "r", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "research", slug, "note.md"), "n", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "task-plans", `${slug}-task-plan.md`), "p", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "feature-state", `${slug}.json`), "{}", NOW_SEC - 40 * DAY);

    const { stale } = enumerateArchiveSet({
      externalDir,
      archiveBase,
      maxAgeDays: 30,
      now: NOW,
    });

    expect(stale).toHaveLength(1);
    const group = stale[0];
    expect(group.key).toBe(slug);
    expect(group.isDateFallback).toBe(false);
    // 4 members: reviews dir, research dir, task-plan file, state file.
    expect(group.members).toHaveLength(4);
    // Destinations MIRROR the live tree: <archiveBase>/<area>/<slug-or-file>.
    const dests = group.members.map((m) => m.dest).sort();
    expect(dests).toContain(path.join(archiveBase, "reviews", slug));
    expect(dests).toContain(path.join(archiveBase, "research", slug));
    expect(dests).toContain(path.join(archiveBase, "task-plans", `${slug}-task-plan.md`));
    expect(dests).toContain(path.join(archiveBase, "feature-state", `${slug}.json`));
  });

  test("a task-plans/<slug>/ DIRECTORY (not a flat file) is slug-routed to <slug>/task-plans", () => {
    const { externalDir, archiveBase } = makeFixture("tp-slug-dir");
    const slug = "2026-01-01-gamma";
    // A per-slug task-plans SUBDIRECTORY (whole dir moves to <slug>/task-plans), distinct from the
    // flat <slug>-task-plan.md file case. Covers the `else if (entry.isDirectory)` branch.
    writeFile(path.join(externalDir, "task-plans", slug, "plan-a.md"), "a", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "task-plans", slug, "sub", "plan-b.md"), "b", NOW_SEC - 40 * DAY);

    const { stale } = enumerateArchiveSet({
      externalDir,
      archiveBase,
      maxAgeDays: 30,
      now: NOW,
    });

    expect(stale).toHaveLength(1);
    const group = stale[0];
    expect(group.key).toBe(slug);
    expect(group.isDateFallback).toBe(false);
    // The whole dir is ONE member routed to <archiveBase>/task-plans/<slug> (mirrors live tree).
    expect(group.members).toHaveLength(1);
    expect(group.members[0].src).toBe(path.join(externalDir, "task-plans", slug));
    expect(group.members[0].dest).toBe(path.join(archiveBase, "task-plans", slug));
  });

  test("bare <date> dirs across multiple areas are independent date-fallback groups", () => {
    const { externalDir, archiveBase } = makeFixture("date-fallback");
    const date = "2026-01-15";
    writeFile(path.join(externalDir, "reviews", date, "r.md"), "r", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "research", date, "n.md"), "n", NOW_SEC - 40 * DAY);
    // task-plans/<date>/ dir (post-Task-4 normalized shape)
    writeFile(path.join(externalDir, "task-plans", date, `${date}-topic-task-plan.md`), "p", NOW_SEC - 40 * DAY);

    const { stale } = enumerateArchiveSet({
      externalDir,
      archiveBase,
      maxAgeDays: 30,
      now: NOW,
    });

    // Three independent groups (keys are internal _date-fallback markers; the dest mirrors the live tree).
    expect(stale).toHaveLength(3);
    const keys = stale.map((g) => g.key).sort();
    expect(keys).toEqual(
      [`_date-fallback/${date}/research`, `_date-fallback/${date}/reviews`, `_date-fallback/${date}/task-plans`].sort(),
    );
    for (const g of stale) expect(g.isDateFallback).toBe(true);
    // Each has exactly one member; the dest mirrors the live tree: <archiveBase>/<area>/<date>.
    const reviewsGroup = stale.find((g) => g.key === `_date-fallback/${date}/reviews`);
    expect(reviewsGroup).toBeDefined();
    expect(reviewsGroup?.members[0].dest).toBe(path.join(archiveBase, "reviews", date));
  });

  test("a non-standard task-plan filename (no -task-plan.md suffix) routes by its basename", () => {
    // Covers taskPlanSlug's legacy fallback (`else` branch): a file not matching the
    // `<slug>-task-plan.md` convention still routes by basename-minus-.md as a slug-like key.
    const { externalDir, archiveBase } = makeFixture("tp-legacy");
    const slug = "2026-01-01-delta";
    writeFile(path.join(externalDir, "task-plans", `${slug}-notes.md`), "n", NOW_SEC - 40 * DAY);

    const { stale } = enumerateArchiveSet({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });

    expect(stale).toHaveLength(1);
    const group = stale[0];
    // Keyed by the basename without extension (the fallback slug); archived flat at
    // task-plans/{name} (mirrors the live flat layout).
    expect(group.key).toBe(`${slug}-notes`);
    expect(group.isDateFallback).toBe(false);
    expect(group.members[0].dest).toBe(path.join(archiveBase, "task-plans", `${slug}-notes.md`));
  });

  test("a subdirectory inside feature-state/ is skipped (only files are features)", () => {
    // Covers collectCandidates' feature-state `if (!entry.isFile) continue;` guard.
    const { externalDir, archiveBase } = makeFixture("fs-subdir");
    const slug = "2026-01-01-epsilon";
    writeFile(path.join(externalDir, "reviews", slug, "rev.md"), "r", NOW_SEC - 40 * DAY);
    // A stray directory inside feature-state/ (not a feature-state JSON file).
    mkdirSync(path.join(externalDir, "feature-state", "strange-dir"), { recursive: true });
    writeFile(path.join(externalDir, "feature-state", "strange-dir", "ignored.json"), "{}", NOW_SEC - 40 * DAY);

    const { stale } = enumerateArchiveSet({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });

    // The slug group exists; the stray feature-state subdirectory was NOT collected (no member
    // routed under strange-dir).
    expect(stale.some((g) => g.key === slug)).toBe(true);
    expect(stale.some((g) => g.key === "strange-dir")).toBe(false);
  });

  test("excludeSlug omits that slug's whole group and records it in skipped", () => {
    const { externalDir, archiveBase } = makeFixture("exclude");
    const active = "2026-01-01-active";
    const idle = "2026-01-01-idle";
    writeFile(path.join(externalDir, "reviews", active, "r.md"), "r", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "reviews", idle, "r.md"), "r", NOW_SEC - 40 * DAY);

    const { stale, skipped } = enumerateArchiveSet({
      externalDir,
      archiveBase,
      maxAgeDays: 30,
      excludeSlug: active,
      now: NOW,
    });

    expect(stale.map((g) => g.key)).toEqual([idle]);
    // The excluded slug's sources appear in skipped.
    expect(skipped.some((p) => p.includes(path.join("reviews", active)))).toBe(true);
  });

  test("maxAgeDays boundary: exactly at cutoff is NOT stale; one second older IS stale", () => {
    const { externalDir, archiveBase } = makeFixture("boundary");
    const slug = "2026-01-01-gamma";
    // Exactly 30 days old (age === cutoff) -> not stale (strict <).
    writeFile(path.join(externalDir, "reviews", slug, "a.md"), "a", NOW_SEC - 30 * DAY);

    let { stale } = enumerateArchiveSet({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });
    expect(stale).toHaveLength(0);

    // One second older than 30 days -> stale.
    setMtime(path.join(externalDir, "reviews", slug, "a.md"), NOW_SEC - 30 * DAY - 1);
    ({ stale } = enumerateArchiveSet({ externalDir, archiveBase, maxAgeDays: 30, now: NOW }));
    expect(stale).toHaveLength(1);
    expect(stale[0].key).toBe(slug);
  });

  test("maxAgeDays=0 marks everything (past mtime) stale", () => {
    const { externalDir, archiveBase } = makeFixture("zero");
    const slug = "2026-01-01-delta";
    writeFile(path.join(externalDir, "reviews", slug, "a.md"), "a", NOW_SEC - 1); // 1s old

    const { stale } = enumerateArchiveSet({ externalDir, archiveBase, maxAgeDays: 0, now: NOW });
    expect(stale.map((g) => g.key)).toEqual([slug]);
  });
});

// ============================================================
// archiveStaleArtifacts (background sweep; subagent-skipped)
// ============================================================
describe("archiveStaleArtifacts", () => {
  test("moves a stale slug group to the archive; source gone", async () => {
    const { externalDir, archiveBase } = makeFixture("sweep");
    const slug = "2026-01-01-eps";
    writeFile(path.join(externalDir, "reviews", slug, "rev.md"), "r", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "feature-state", `${slug}.json`), "{}", NOW_SEC - 40 * DAY);

    const res = await archiveStaleArtifacts({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });

    expect(res.archived.length).toBeGreaterThanOrEqual(2);
    expect(res.errors).toEqual([]);
    // One slug group fully archived (reviews + state moved together); no date-fallbacks.
    expect(res.archivedSlugGroups).toBe(1);
    expect(res.archivedDateFallbackGroups).toBe(0);
    expect(existsSync(path.join(externalDir, "reviews", slug))).toBe(false);
    expect(existsSync(path.join(externalDir, "feature-state", `${slug}.json`))).toBe(false);
    expect(existsSync(path.join(archiveBase, "reviews", slug, "rev.md"))).toBe(true);
    expect(existsSync(path.join(archiveBase, "feature-state", `${slug}.json`))).toBe(true);
  });

  test("idempotent: a second run is a no-op (sources already gone)", async () => {
    const { externalDir, archiveBase } = makeFixture("idempotent");
    const slug = "2026-01-01-zeta";
    writeFile(path.join(externalDir, "reviews", slug, "rev.md"), "r", NOW_SEC - 40 * DAY);

    await archiveStaleArtifacts({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });
    const res2 = await archiveStaleArtifacts({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });

    expect(res2.archived).toEqual([]);
    expect(res2.errors).toEqual([]);
  });

  test("counts slug groups + date-fallback groups separately in the result", async () => {
    const { externalDir, archiveBase } = makeFixture("mixed-groups");
    const slug = "2026-01-01-mixed-slug";
    const date = "2026-01-15";
    // One slug group (reviews + state).
    writeFile(path.join(externalDir, "reviews", slug, "rev.md"), "r", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "feature-state", `${slug}.json`), "{}", NOW_SEC - 40 * DAY);
    // One date-fallback group (bare date dir under reviews).
    writeFile(path.join(externalDir, "reviews", date, "r.md"), "r", NOW_SEC - 40 * DAY);

    const res = await archiveStaleArtifacts({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });

    expect(res.errors).toEqual([]);
    // 1 slug group + 1 date-fallback group — the group-breakdown the result notify reports.
    expect(res.archivedSlugGroups).toBe(1);
    expect(res.archivedDateFallbackGroups).toBe(1);
  });

  test("a multi-member slug group is NOT counted when one member fails (all-or-nothing unit)", async () => {
    const { externalDir, archiveBase } = makeFixture("partial-group");
    const slug = "2026-01-01-partial";
    // A slug group with THREE members: reviews + research + feature-state (all stale).
    writeFile(path.join(externalDir, "reviews", slug, "rev.md"), "r", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "research", slug, "note.md"), "n", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "feature-state", `${slug}.json`), "{}", NOW_SEC - 40 * DAY);
    // Sabotage ONLY the feature-state member: under the tree-mirror archive, feature-state routes
    // to archiveBase/feature-state/<slug>.json, so its dest PARENT is archiveBase/feature-state.
    // Make that path a FILE so moveArtifact's mkdirSync(dest parent) throws (ENOTDIR). The reviews
    // + research members route to archiveBase/{reviews,research}/<slug> (DIFFERENT parents) and
    // still move — so TWO members succeed, ONE fails.
    writeFileSync(path.join(archiveBase, "feature-state"), "blocker");

    const res = await archiveStaleArtifacts({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });

    // The feature-state move failed (its dest parent is a file) → the group is all-or-nothing → NOT counted.
    expect(res.archivedSlugGroups).toBe(0);
    expect(res.archivedDateFallbackGroups).toBe(0);
    // But TWO members DID move (reviews + research) — distinguishing allMembersMoved from
    // anyMemberMoved. A regression counting the group on ANY success would fail this assertion.
    expect(res.archived.length).toBe(2);
    expect(res.errors.length).toBe(1);
    // The feature-state source remains (move failed); reviews + research sources are gone.
    expect(existsSync(path.join(externalDir, "feature-state", `${slug}.json`))).toBe(true);
    expect(existsSync(path.join(externalDir, "reviews", slug))).toBe(false);
    expect(existsSync(path.join(externalDir, "research", slug))).toBe(false);
  });

  test("skips all work in a subagent session (returns empty result)", async () => {
    const { externalDir, archiveBase } = makeFixture("subagent");
    const slug = "2026-01-01-eta";
    writeFile(path.join(externalDir, "reviews", slug, "rev.md"), "r", NOW_SEC - 40 * DAY);
    enableSubagentMode();

    const res = await archiveStaleArtifacts({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });

    expect(res).toEqual({ archived: [], errors: [], archivedSlugGroups: 0, archivedDateFallbackGroups: 0 });
    // Source untouched.
    expect(existsSync(path.join(externalDir, "reviews", slug, "rev.md"))).toBe(true);
  });

  test("best-effort: a failed member is recorded in errors[] without aborting the rest", async () => {
    const { externalDir, archiveBase } = makeFixture("errors");
    const blocked = "2026-01-01-blocked";
    const fine = "2026-01-01-fine";
    // Both slugs are stale. `fine` has a reviews dir; `blocked` has only a feature-state file.
    writeFile(path.join(externalDir, "reviews", fine, "rev.md"), "r", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "feature-state", `${blocked}.json`), "{}", NOW_SEC - 40 * DAY);
    // Sabotage the blocked slug's archive dest: under the tree-mirror archive, feature-state/<slug>.json
    // routes to archiveBase/feature-state/<slug>.json. Make archiveBase/feature-state a FILE so the
    // mkdirSync(dest parent) step fails (ENOTDIR) for the blocked member. `fine`'s reviews routes to
    // archiveBase/reviews/<fine>/ (a different parent) and still moves.
    writeFileSync(path.join(archiveBase, "feature-state"), "blocker");

    const res = await archiveStaleArtifacts({ externalDir, archiveBase, maxAgeDays: 30, now: NOW });

    // The fine slug still archived (best-effort continuation).
    expect(res.archived.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(archiveBase, "reviews", fine, "rev.md"))).toBe(true);
    expect(existsSync(path.join(externalDir, "reviews", fine))).toBe(false);
    // The blocked slug's failure was collected, not thrown; its source remains.
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(externalDir, "feature-state", `${blocked}.json`))).toBe(true);
  });
});

// ============================================================
// archiveArtifactsOlderThan (manual command; supports excludeSlug)
// ============================================================
describe("archiveArtifactsOlderThan", () => {
  test("archives stale slugs and excludes the active feature", async () => {
    const { externalDir, archiveBase } = makeFixture("manual");
    const active = "2026-01-01-theta";
    const idle = "2026-01-01-iota";
    writeFile(path.join(externalDir, "reviews", active, "r.md"), "r", NOW_SEC - 40 * DAY);
    writeFile(path.join(externalDir, "reviews", idle, "r.md"), "r", NOW_SEC - 40 * DAY);

    const res = await archiveArtifactsOlderThan({
      externalDir,
      archiveBase,
      days: 30,
      excludeSlug: active,
      now: NOW,
    });

    expect(res.archived.length).toBe(1); // idle group's reviews dir
    expect(existsSync(path.join(externalDir, "reviews", idle))).toBe(false);
    // Active feature untouched.
    expect(existsSync(path.join(externalDir, "reviews", active, "r.md"))).toBe(true);
    expect(res.skipped.some((p) => p.includes(path.join("reviews", active)))).toBe(true);
  });

  test("does NOT skip in subagent sessions (manual command runs on demand)", async () => {
    const { externalDir, archiveBase } = makeFixture("manual-sub");
    const slug = "2026-01-01-kappa";
    writeFile(path.join(externalDir, "reviews", slug, "r.md"), "r", NOW_SEC - 40 * DAY);
    enableSubagentMode();

    const res = await archiveArtifactsOlderThan({ externalDir, archiveBase, days: 30, now: NOW });

    expect(res.archived.length).toBe(1);
    expect(existsSync(path.join(externalDir, "reviews", slug))).toBe(false);
  });
});

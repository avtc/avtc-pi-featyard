// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Unit tests for the two-source design-doc archive sweep: `enumerateDesigns` +
 * `archiveDesignsOlderThan`. Design docs are flat `*-design.md` files that may live in EITHER
 * `.ff/designs` (local) or `docs/ff/designs` (committed); the sweep scans both roots, filters by
 * mtime, excludes the active feature's doc, and archives each independently.
 *
 * Uses the real filesystem under temp dirs (mirrors archive-feature.test.ts) — `archiveDesignsOlderThan`
 * uses REAL_FS_MOVE_OPS internally (the same atomic/EXDEV-safe primitive the rest of the engine uses).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { archiveDesignsOlderThan, enumerateDesigns, MS_PER_DAY } from "../../src/state/archive-artifacts.js";

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `designs-${prefix}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

/** Set a path's mtime (and atime) to a fixed point in time (seconds). */
function setMtime(p: string, mtimeSeconds: number): void {
  utimesSync(p, mtimeSeconds, mtimeSeconds);
}

/** Write a design doc; stamps its mtime when `mtimeSeconds` is non-null. */
function writeDesign(dir: string, slug: string, mtimeSeconds: number | null): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${slug}-design.md`);
  writeFileSync(p, `# ${slug}`);
  if (mtimeSeconds !== null) setMtime(p, mtimeSeconds);
  return p;
}

// A fixed "now" for deterministic age math. 2026-06-30T00:00:00Z.
const NOW = Date.parse("2026-06-30T00:00:00Z");
const NOW_SEC = NOW / 1000;
const DAY = 86_400; // seconds

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("enumerateDesigns", () => {
  test("finds stale docs across BOTH roots and routes each under archiveBase/designs/ (tree-mirror)", () => {
    const root = makeTempDir("enum");
    const localDir = path.join(root, "local", "designs");
    const committedDir = path.join(root, "committed", "docs", "ff", "designs");
    const archiveBase = path.join(root, "archive");

    // Old (>10d) in BOTH roots; fresh doc must be excluded.
    writeDesign(localDir, "2026-06-01-old-local", NOW_SEC - 20 * DAY);
    writeDesign(committedDir, "2026-06-01-old-committed", NOW_SEC - 20 * DAY);
    writeDesign(committedDir, "2026-06-29-fresh", NOW_SEC - 1 * DAY);

    const { stale } = enumerateDesigns({
      designsDirs: [localDir, committedDir],
      archiveBase,
      maxAgeDays: 10,
      now: NOW,
    });

    expect(stale.map((m) => m.slug).sort()).toEqual(["2026-06-01-old-committed", "2026-06-01-old-local"]);
    for (const m of stale) {
      expect(m.dest).toBe(path.join(archiveBase, "designs", `${m.slug}-design.md`));
    }
  });

  test("excludes the active feature's design doc (excludeSlug) into skipped[]", () => {
    const root = makeTempDir("exclude");
    const dir = path.join(root, "designs");
    const archiveBase = path.join(root, "archive");
    writeDesign(dir, "2026-06-01-active", NOW_SEC - 20 * DAY);
    writeDesign(dir, "2026-06-01-stale", NOW_SEC - 20 * DAY);

    const { stale, skipped } = enumerateDesigns({
      designsDirs: [dir],
      archiveBase,
      maxAgeDays: 10,
      excludeSlug: "2026-06-01-active",
      now: NOW,
    });

    expect(stale.map((m) => m.slug)).toEqual(["2026-06-01-stale"]);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain("2026-06-01-active-design.md");
  });

  test("a missing/unreadable dir is a no-op (best-effort)", () => {
    const root = makeTempDir("missing");
    const archiveBase = path.join(root, "archive");
    const { stale } = enumerateDesigns({
      designsDirs: [path.join(root, "does-not-exist")],
      archiveBase,
      maxAgeDays: 10,
      now: NOW,
    });
    expect(stale).toEqual([]);
  });

  test("ignores non-design files and non-files", () => {
    const root = makeTempDir("nonmd");
    const dir = path.join(root, "designs");
    const archiveBase = path.join(root, "archive");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "2026-06-01-old-plan.md"), "x"); // not -design.md
    setMtime(path.join(dir, "2026-06-01-old-plan.md"), NOW_SEC - 20 * DAY);
    mkdirSync(path.join(dir, "2026-06-01-old-design.md"), { recursive: true }); // a dir, not a file

    const { stale } = enumerateDesigns({
      designsDirs: [dir],
      archiveBase,
      maxAgeDays: 10,
      now: NOW,
    });
    expect(stale).toEqual([]);
  });
});

describe("archiveDesignsOlderThan", () => {
  test("moves stale docs from both roots into the archive and reports counts", async () => {
    const root = makeTempDir("archive");
    const localDir = path.join(root, "local", "designs");
    const committedDir = path.join(root, "committed", "docs", "ff", "designs");
    const archiveBase = path.join(root, "archive");
    const localSrc = writeDesign(localDir, "2026-06-01-a", NOW_SEC - 20 * DAY);
    const committedSrc = writeDesign(committedDir, "2026-06-01-b", NOW_SEC - 20 * DAY);
    // Fresh doc stays put.
    writeDesign(localDir, "2026-06-29-fresh", NOW_SEC - 1 * DAY);

    const result = await archiveDesignsOlderThan({
      designsDirs: [localDir, committedDir],
      archiveBase,
      days: 10,
      now: NOW,
    });

    expect(result.archivedCount).toBe(2);
    expect(result.errors).toEqual([]);
    expect(existsSync(localSrc)).toBe(false);
    expect(existsSync(committedSrc)).toBe(false);
    expect(existsSync(path.join(archiveBase, "designs", "2026-06-01-a-design.md"))).toBe(true);
    expect(existsSync(path.join(archiveBase, "designs", "2026-06-01-b-design.md"))).toBe(true);
    expect(existsSync(path.join(localDir, "2026-06-29-fresh-design.md"))).toBe(true);
  });

  test("excludeSlug protects the active doc (not moved, reported in skipped)", async () => {
    const root = makeTempDir("archive-exclude");
    const dir = path.join(root, "designs");
    const archiveBase = path.join(root, "archive");
    const activeSrc = writeDesign(dir, "2026-06-01-active", NOW_SEC - 20 * DAY);
    writeDesign(dir, "2026-06-01-stale", NOW_SEC - 20 * DAY);

    const result = await archiveDesignsOlderThan({
      designsDirs: [dir],
      archiveBase,
      days: 10,
      excludeSlug: "2026-06-01-active",
      now: NOW,
    });

    expect(result.archivedCount).toBe(1);
    expect(existsSync(activeSrc)).toBe(true); // protected
    expect(result.skipped.length).toBe(1);
  });

  test("days threshold uses MS_PER_DAY math (boundary: exactly at cutoff is NOT stale)", async () => {
    // Confirm the engine's day math: a doc at exactly maxAgeDays old (cutoff) is < cutoff? No —
    // newestMtime < cutoff is strict, and cutoff = now - days*MS_PER_DAY. A doc exactly `days` old
    // has mtime == cutoff, which is NOT < cutoff → kept.
    const root = makeTempDir("boundary");
    const dir = path.join(root, "designs");
    const archiveBase = path.join(root, "archive");
    writeDesign(dir, "2026-06-20-boundary", NOW / 1000 - 10 * (MS_PER_DAY / 1000));

    const result = await archiveDesignsOlderThan({
      designsDirs: [dir],
      archiveBase,
      days: 10,
      now: NOW,
    });
    expect(result.archivedCount).toBe(0);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { worthNotesPath, worthNotesPointer, worthNotesPointerFor } from "../../src/state/worth-notes.js";

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `worth-notes-${prefix}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("worthNotesPath", () => {
  test("slug-based path when slug provided", () => {
    expect(worthNotesPath("2026-06-29-x", "2026-06-29")).toBe(".ff/reviews/2026-06-29-x/2026-06-29-x-worth-notes.md");
  });

  test("date-fallback path when slug is null", () => {
    expect(worthNotesPath(null, "2026-06-29")).toBe(".ff/reviews/2026-06-29/2026-06-29-worth-notes.md");
  });
});

describe("worthNotesPointer", () => {
  test("returns '📝 worth-notes: <path>' when the file exists and is non-empty", () => {
    const dir = makeTempDir("present");
    const file = path.join(dir, "2026-06-29-x-worth-notes.md");
    writeFileSync(file, "## worth noting\n- something odd\n");

    expect(worthNotesPointer(file)).toBe(`📝 worth-notes: ${file}`);
  });

  test("returns null when the file is absent", () => {
    expect(worthNotesPointer(path.join(os.tmpdir(), "definitely-missing-worth-notes.md"))).toBeNull();
  });

  test("returns null when the file exists but is EMPTY (no content to surface)", () => {
    const dir = makeTempDir("empty");
    const file = path.join(dir, "empty-worth-notes.md");
    writeFileSync(file, "");

    expect(worthNotesPointer(file)).toBeNull();
  });

  test("returns null when the file is only whitespace (treated as empty)", () => {
    const dir = makeTempDir("ws");
    const file = path.join(dir, "ws-worth-notes.md");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "   \n  \t \n");

    expect(worthNotesPointer(file)).toBeNull();
  });

  test("is robust to a path inside a nested dir that doesn't exist yet (stat miss → null)", () => {
    const dir = makeTempDir("nested");
    // The dir exists but the file path under a non-existent subdir:
    expect(existsSync(path.join(dir, "nope", "x.md"))).toBe(false);
    expect(worthNotesPointer(path.join(dir, "nope", "x.md"))).toBeNull();
  });

  test("returns null when the path is a DIRECTORY (not a file)", () => {
    // Covers the `statSync(notesPath).isFile` false branch — a dir at the resolved path
    // (not a notes file) yields no pointer.
    const dir = makeTempDir("isdir");
    expect(worthNotesPointer(dir)).toBeNull();
  });
});

describe("worthNotesPointerFor", () => {
  test("returns the pointer when the slug's worth-notes file exists and is non-empty", () => {
    // worthNotesPointerFor builds `.ff/reviews/<slug>/<slug>-worth-notes.md` under cwd; run in a
    // temp cwd so the relative path resolves into the temp dir.
    const root = makeTempDir("for-present");
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      const slug = "2026-06-29-for";
      mkdirSync(path.join(".ff", "reviews", slug), { recursive: true });
      writeFileSync(path.join(".ff", "reviews", slug, `${slug}-worth-notes.md`), "## notes\n- x\n");

      expect(worthNotesPointerFor(slug)).toBe(`📝 worth-notes: .ff/reviews/${slug}/${slug}-worth-notes.md`);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("returns null when the slug has no worth-notes file", () => {
    const root = makeTempDir("for-absent");
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      expect(worthNotesPointerFor("2026-06-29-none")).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("null slug uses the date-fallback path and resolves when that file exists", () => {
    // A null slug (manual run without an active feature) falls back to.ff/reviews/<today>/.
    const root = makeTempDir("for-null-present");
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      const today = new Date().toISOString().slice(0, 10);
      mkdirSync(path.join(".ff", "reviews", today), { recursive: true });
      writeFileSync(path.join(".ff", "reviews", today, `${today}-worth-notes.md`), "## notes\n- x\n");

      expect(worthNotesPointerFor(null)).toBe(`📝 worth-notes: .ff/reviews/${today}/${today}-worth-notes.md`);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("null slug returns null when the date-fallback worth-notes file is absent", () => {
    const root = makeTempDir("for-null-absent");
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      expect(worthNotesPointerFor(null)).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { describeTddViolation, TddEnforcement, type TddGitDeps } from "../../src/guardrails/tdd-enforcement.js";

/** Build an enforcement instance with stubbed git deps. */
function makeEnforcement(opts: { files?: string[]; isRepo?: boolean }): TddEnforcement {
  const files = opts.files ?? [];
  const isRepo = opts.isRepo ?? true;
  const git: TddGitDeps = {
    workingTreeFiles: () => files,
    isGitRepo: () => isRepo,
  };
  return new TddEnforcement(git);
}

describe("TddEnforcement.checkSourceWrite", () => {
  test("returns a source-before-test violation when no test is in the change set", () => {
    const e = makeEnforcement({ files: ["src/ui/value-picker.ts"] });
    expect(e.checkSourceWrite("src/ui/value-picker.ts")).toEqual({
      type: "source-before-test",
      file: "src/ui/value-picker.ts",
    });
  });

  test("returns null when a corresponding test is in the change set (flat layout)", () => {
    // The reported bug: a flat tests/ file must cover a nested src/ file.
    const e = makeEnforcement({ files: ["src/ui/value-picker.ts", "tests/value-picker.test.ts"] });
    expect(e.checkSourceWrite("src/ui/value-picker.ts")).toBeNull();
  });

  test("returns null when a corresponding test is in the change set (mirrored layout)", () => {
    const e = makeEnforcement({ files: ["tests/lib/math/add.test.ts"] });
    expect(e.checkSourceWrite("src/lib/math/add.ts")).toBeNull();
  });

  test("returns a violation when the change set has only an UNRELATED test", () => {
    // P3 precision: a test for `a` must not cover an edit to `b`.
    const e = makeEnforcement({ files: ["tests/a.test.ts"] });
    expect(e.checkSourceWrite("src/b.ts")).toEqual({ type: "source-before-test", file: "src/b.ts" });
  });

  test("returns null for a non-source file (config / dotfile)", () => {
    const e = makeEnforcement({ files: [] });
    expect(e.checkSourceWrite("package.json")).toBeNull();
    expect(e.checkSourceWrite(".env")).toBeNull();
  });

  test("returns null for a test file itself (tests are never the subject)", () => {
    const e = makeEnforcement({ files: ["tests/value-picker.test.ts"] });
    expect(e.checkSourceWrite("tests/value-picker.test.ts")).toBeNull();
  });

  test("silently no-ops (returns null) when not in a git repo", () => {
    const e = makeEnforcement({ files: [], isRepo: false });
    expect(e.checkSourceWrite("src/ui/value-picker.ts")).toBeNull();
  });

  test("warns on a clean tree (empty change set) in a git repo", () => {
    // Clean tree == no test change == source-before-test.
    const e = makeEnforcement({ files: [], isRepo: true });
    expect(e.checkSourceWrite("src/ui/value-picker.ts")).toEqual({
      type: "source-before-test",
      file: "src/ui/value-picker.ts",
    });
  });

  test("is stateless: repeated checks are independent", () => {
    // No in-memory tracking — git is the source of truth.
    const e = makeEnforcement({ files: ["tests/value-picker.test.ts"] });
    expect(e.checkSourceWrite("src/ui/value-picker.ts")).toBeNull();
    expect(e.checkSourceWrite("src/ui/value-picker.ts")).toBeNull();
  });
});

describe("describeTddViolation", () => {
  test("names the file and urges writing a test first", () => {
    const msg = describeTddViolation({ type: "source-before-test", file: "src/ui/value-picker.ts" });
    expect(msg).toContain("src/ui/value-picker.ts");
    expect(msg).toContain("test");
  });

  test("does not mention the old on-disk 'existing tests' escape hatch", () => {
    const msg = describeTddViolation({ type: "source-before-test", file: "src/x.ts" });
    expect(msg.toLowerCase()).not.toContain("existing tests");
  });
});

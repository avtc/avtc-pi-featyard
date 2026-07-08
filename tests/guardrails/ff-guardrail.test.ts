// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkFfForceAdd, type GitAddParse, parseGitAddCommand } from "../../src/guardrails/force-add-guard.js";

/** Assert parseGitAddCommand returned a result (non-null) for parser tests. */
function parse(cmd: string): GitAddParse {
  const r = parseGitAddCommand(cmd);
  if (r === null) throw new Error(`expected parse to succeed for: ${cmd}`);
  return r;
}

/** Build a fake fs backed by a Set of "existing" absolute paths. cwd-relative .ff checks
 * resolve against the provided root. */
function fakeFs(root: string, ffExists: boolean, extra: Set<string>): typeof fs {
  const exists = (p: string) => {
    const norm = path.resolve(p);
    if (ffExists && norm === path.join(root, ".ff")) return true;
    return extra.has(norm);
  };
  return { existsSync: exists } as unknown as typeof fs;
}

describe("parseGitAddCommand", () => {
  test("returns null for non-git-add commands", () => {
    expect(parseGitAddCommand("git commit -m x")).toBeNull();
    expect(parseGitAddCommand("npm test")).toBeNull();
    expect(parseGitAddCommand("git status")).toBeNull();
  });

  test("detects --force long form", () => {
    const r = parse("git add --force .ff/reviews/x.md");
    expect(r.force).toBe(true);
    expect(r.sweepAll).toBe(false);
    expect(r.pathspecs).toEqual([".ff/reviews/x.md"]);
  });

  test("detects -f short form", () => {
    const r = parse("git add -f .ff/reviews/x.md");
    expect(r.force).toBe(true);
    expect(r.pathspecs).toEqual([".ff/reviews/x.md"]);
  });

  test("detects combined -fA cluster", () => {
    const r = parse("git add -fA");
    expect(r.force).toBe(true);
    expect(r.sweepAll).toBe(true);
    expect(r.pathspecs).toEqual([]);
  });

  test("detects combined -Af cluster (reverse order)", () => {
    const r = parse("git add -Af");
    expect(r.force).toBe(true);
    expect(r.sweepAll).toBe(true);
  });

  test("detects separate -f -A flags", () => {
    const r = parse("git add -f -A");
    expect(r.force).toBe(true);
    expect(r.sweepAll).toBe(true);
  });

  test("detects --force --all", () => {
    const r = parse("git add --force --all");
    expect(r.force).toBe(true);
    expect(r.sweepAll).toBe(true);
  });

  test("A without force is not a block candidate (no force flag)", () => {
    const r = parse("git add -A");
    expect(r.force).toBe(false);
    expect(r.sweepAll).toBe(true);
  });

  test("f with a normal source file is force but not.ff", () => {
    const r = parse("git add -f src/foo.ts");
    expect(r.force).toBe(true);
    expect(r.pathspecs).toEqual(["src/foo.ts"]);
  });

  test("does not treat -a (lowercase) as --all", () => {
    const r = parse("git add -fa");
    expect(r.force).toBe(true);
    expect(r.sweepAll).toBe(false);
  });

  test("does not treat src/.ff-helpers as an.ff path", () => {
    const r = parse("git add -f src/.ff-helpers.ts");
    expect(r.force).toBe(true);
    expect(r.pathspecs).toEqual(["src/.ff-helpers.ts"]);
  });

  test("treats. as a cwd-sweep pathspec", () => {
    const r = parse("git add -f .");
    expect(r.force).toBe(true);
    expect(r.pathspecs).toEqual(["."]);
  });

  test("handles git -C <dir> global option as cwd override", () => {
    const r = parse("git -C sub add -f .ff/x.md");
    expect(r.force).toBe(true);
    expect(r.gitCDir).toBe("sub");
    expect(r.pathspecs).toEqual([".ff/x.md"]);
  });

  test("collects multiple pathspecs", () => {
    const r = parse("git add -f a.ts .ff/b.md c.ts");
    expect(r.pathspecs).toEqual(["a.ts", ".ff/b.md", "c.ts"]);
  });

  test("respects quoted pathspecs", () => {
    const r = parse('git add -f ".ff/reviews/my file.md"');
    expect(r.pathspecs).toEqual([".ff/reviews/my file.md"]);
  });
});

describe("checkFfForceAdd", () => {
  const root = path.join(os.tmpdir(), "ff-guardrail-root");
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function ffPresent() {
    return fakeFs(root, true, new Set());
  }
  function ffAbsent() {
    return fakeFs(root, false, new Set());
  }

  test("blocks explicit.ff/ path with -f", () => {
    const r = checkFfForceAdd("git add -f .ff/reviews/x.md", root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks explicit.ff/ path with --force", () => {
    const r = checkFfForceAdd("git add --force .ff/reviews/x.md", root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks absolute path under.ff", () => {
    const r = checkFfForceAdd(`git add -f ${path.join(root, ".ff", "x.md")}`, root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks../.ff traversal path", () => {
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const r = checkFfForceAdd("git add -f ../.ff/x.md", sub, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks -fA unconditionally (.ff always exists)", () => {
    const r = checkFfForceAdd("git add -fA", root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks -Af combined", () => {
    const r = checkFfForceAdd("git add -Af", root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks --force --all", () => {
    const r = checkFfForceAdd("git add --force --all", root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks -f. when.ff is under cwd", () => {
    const r = checkFfForceAdd("git add -f .", root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("does NOT block -f. when.ff is not under cwd (subdir)", () => {
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub, { recursive: true });
    // fakeFs reports .ff only under root, not under sub
    const r = checkFfForceAdd("git add -f .", sub, ffPresent());
    expect(r).toBeNull();
  });

  test("does NOT block -A without force", () => {
    const r = checkFfForceAdd("git add -A", root, ffPresent());
    expect(r).toBeNull();
  });

  test("does NOT block -f on a normal source file", () => {
    const r = checkFfForceAdd("git add -f src/foo.ts", root, ffPresent());
    expect(r).toBeNull();
  });

  test("does NOT block when.ff absent and only -fA", () => {
    // .ff always exists when feature-flow is loaded, but guard defensively:
    // no .ff → force-all cannot pull in .ff → allow
    const r = checkFfForceAdd("git add -fA", root, ffAbsent());
    expect(r).toBeNull();
  });

  test("blocks cd-then-add compound command", () => {
    const r = checkFfForceAdd("cd sub && git add -f .ff/x.md", root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks git -C <dir> then add", () => {
    const r = checkFfForceAdd("git -C sub add -f .ff/x.md", root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks only the offending subcommand, returns first block", () => {
    const r = checkFfForceAdd("git add -f ok.ts && git add -fA", root, ffPresent());
    expect(r?.block).toBe(true);
  });

  test("returns null for commands without git add -f", () => {
    expect(checkFfForceAdd("npm test", root, ffPresent())).toBeNull();
    expect(checkFfForceAdd("git commit -m x", root, ffPresent())).toBeNull();
    expect(checkFfForceAdd("git add -A", root, ffPresent())).toBeNull();
  });
});

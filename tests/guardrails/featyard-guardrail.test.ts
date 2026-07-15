// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkFeatyardForceAdd, type GitAddParse, parseGitAddCommand } from "../../src/guardrails/force-add-guard.js";

/** Assert parseGitAddCommand returned a result (non-null) for parser tests. */
function parse(cmd: string): GitAddParse {
  const r = parseGitAddCommand(cmd);
  if (r === null) throw new Error(`expected parse to succeed for: ${cmd}`);
  return r;
}

/** Build a fake fs backed by a Set of "existing" absolute paths. cwd-relative .featyard checks
 * resolve against the provided root. */
function fakeFs(root: string, featyardExists: boolean, extra: Set<string>): typeof fs {
  const exists = (p: string) => {
    const norm = path.resolve(p);
    if (featyardExists && norm === path.join(root, ".featyard")) return true;
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
    const r = parse("git add --force .featyard/reviews/x.md");
    expect(r.force).toBe(true);
    expect(r.sweepAll).toBe(false);
    expect(r.pathspecs).toEqual([".featyard/reviews/x.md"]);
  });

  test("detects -f short form", () => {
    const r = parse("git add -f .featyard/reviews/x.md");
    expect(r.force).toBe(true);
    expect(r.pathspecs).toEqual([".featyard/reviews/x.md"]);
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

  test("f with a normal source file is force but not.featyard", () => {
    const r = parse("git add -f src/foo.ts");
    expect(r.force).toBe(true);
    expect(r.pathspecs).toEqual(["src/foo.ts"]);
  });

  test("does not treat -a (lowercase) as --all", () => {
    const r = parse("git add -fa");
    expect(r.force).toBe(true);
    expect(r.sweepAll).toBe(false);
  });

  test("does not treat src/.fy-helpers as an.featyard path", () => {
    const r = parse("git add -f src/.fy-helpers.ts");
    expect(r.force).toBe(true);
    expect(r.pathspecs).toEqual(["src/.fy-helpers.ts"]);
  });

  test("treats. as a cwd-sweep pathspec", () => {
    const r = parse("git add -f .");
    expect(r.force).toBe(true);
    expect(r.pathspecs).toEqual(["."]);
  });

  test("handles git -C <dir> global option as cwd override", () => {
    const r = parse("git -C sub add -f .featyard/x.md");
    expect(r.force).toBe(true);
    expect(r.gitCDir).toBe("sub");
    expect(r.pathspecs).toEqual([".featyard/x.md"]);
  });

  test("collects multiple pathspecs", () => {
    const r = parse("git add -f a.ts .featyard/b.md c.ts");
    expect(r.pathspecs).toEqual(["a.ts", ".featyard/b.md", "c.ts"]);
  });

  test("respects quoted pathspecs", () => {
    const r = parse('git add -f ".featyard/reviews/my file.md"');
    expect(r.pathspecs).toEqual([".featyard/reviews/my file.md"]);
  });
});

describe("checkFeatyardForceAdd", () => {
  const root = path.join(os.tmpdir(), "fy-guardrail-root");
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function featyardPresent() {
    return fakeFs(root, true, new Set());
  }
  function featyardAbsent() {
    return fakeFs(root, false, new Set());
  }

  test("blocks explicit.featyard/ path with -f", () => {
    const r = checkFeatyardForceAdd("git add -f .featyard/reviews/x.md", root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks explicit.featyard/ path with --force", () => {
    const r = checkFeatyardForceAdd("git add --force .featyard/reviews/x.md", root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks absolute path under.featyard", () => {
    const r = checkFeatyardForceAdd(`git add -f ${path.join(root, ".featyard", "x.md")}`, root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks../.featyard traversal path", () => {
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const r = checkFeatyardForceAdd("git add -f ../.featyard/x.md", sub, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks -fA unconditionally (.featyard always exists)", () => {
    const r = checkFeatyardForceAdd("git add -fA", root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks -Af combined", () => {
    const r = checkFeatyardForceAdd("git add -Af", root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks --force --all", () => {
    const r = checkFeatyardForceAdd("git add --force --all", root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks -f. when.featyard is under cwd", () => {
    const r = checkFeatyardForceAdd("git add -f .", root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("does NOT block -f. when.featyard is not under cwd (subdir)", () => {
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub, { recursive: true });
    // fakeFs reports .featyard only under root, not under sub
    const r = checkFeatyardForceAdd("git add -f .", sub, featyardPresent());
    expect(r).toBeNull();
  });

  test("does NOT block -A without force", () => {
    const r = checkFeatyardForceAdd("git add -A", root, featyardPresent());
    expect(r).toBeNull();
  });

  test("does NOT block -f on a normal source file", () => {
    const r = checkFeatyardForceAdd("git add -f src/foo.ts", root, featyardPresent());
    expect(r).toBeNull();
  });

  test("does NOT block when.featyard absent and only -fA", () => {
    // .featyard always exists when featyard is loaded, but guard defensively:
    // no .featyard → force-all cannot pull in .featyard → allow
    const r = checkFeatyardForceAdd("git add -fA", root, featyardAbsent());
    expect(r).toBeNull();
  });

  test("blocks cd-then-add compound command", () => {
    const r = checkFeatyardForceAdd("cd sub && git add -f .featyard/x.md", root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks git -C <dir> then add", () => {
    const r = checkFeatyardForceAdd("git -C sub add -f .featyard/x.md", root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("blocks only the offending subcommand, returns first block", () => {
    const r = checkFeatyardForceAdd("git add -f ok.ts && git add -fA", root, featyardPresent());
    expect(r?.block).toBe(true);
  });

  test("returns null for commands without git add -f", () => {
    expect(checkFeatyardForceAdd("npm test", root, featyardPresent())).toBeNull();
    expect(checkFeatyardForceAdd("git commit -m x", root, featyardPresent())).toBeNull();
    expect(checkFeatyardForceAdd("git add -A", root, featyardPresent())).toBeNull();
  });
});

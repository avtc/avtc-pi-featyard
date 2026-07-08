// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  defaultGitRunner,
  getBranchOrShortSha,
  getWorkingTreeFiles,
  PROCESS_CWD,
  setGitRunner,
} from "../../src/git/git-queries.js";

const runnerMock = vi.fn();

beforeEach(() => {
  setGitRunner(runnerMock);
  runnerMock.mockReset();
});

afterEach(() => {
  setGitRunner(defaultGitRunner);
});

describe("getBranchOrShortSha", () => {
  test("returns branch name when on a branch", () => {
    // `--abbrev-ref HEAD` prints the branch name when on a branch.
    runnerMock.mockReturnValueOnce("feature/xyz\n");

    expect(getBranchOrShortSha(PROCESS_CWD)).toBe("feature/xyz");
  });

  test("returns short SHA when detached HEAD (symbolic-ref unavailable)", () => {
    // detached HEAD: symbolic-ref errors → fall through to short SHA.
    runnerMock.mockImplementationOnce(() => {
      throw new Error("detached HEAD");
    });
    runnerMock.mockReturnValueOnce("abc123\n");

    expect(getBranchOrShortSha(PROCESS_CWD)).toBe("abc123");
  });

  test("returns null when not in a git repo (runner throws)", () => {
    runnerMock.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    expect(getBranchOrShortSha(PROCESS_CWD)).toBeNull();
  });
});

describe("getWorkingTreeFiles", () => {
  test("returns repo-relative paths for staged, unstaged, and untracked changes", () => {
    // `status --porcelain -z`: NUL-separated entries, each `XY <path>`, trailing NUL.
    runnerMock.mockReturnValueOnce(" M src/foo.ts\0A  tests/bar.test.ts\0?? tests/baz.test.ts\0");

    expect(getWorkingTreeFiles(PROCESS_CWD)).toEqual(["src/foo.ts", "tests/bar.test.ts", "tests/baz.test.ts"]);
  });

  test("strips the 2-char status prefix and the separating space", () => {
    runnerMock.mockReturnValueOnce("M  only-staged.ts\0");

    expect(getWorkingTreeFiles(PROCESS_CWD)).toEqual(["only-staged.ts"]);
  });

  test("preserves spaces inside paths (the -z format never quotes)", () => {
    runnerMock.mockReturnValueOnce("?? my file.test.ts\0");

    expect(getWorkingTreeFiles(PROCESS_CWD)).toEqual(["my file.test.ts"]);
  });

  test("returns an empty array when the working tree is clean", () => {
    runnerMock.mockReturnValueOnce("");

    expect(getWorkingTreeFiles(PROCESS_CWD)).toEqual([]);
  });

  test("returns an empty array when not in a git repo (runner throws)", () => {
    runnerMock.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    expect(getWorkingTreeFiles(PROCESS_CWD)).toEqual([]);
  });
});

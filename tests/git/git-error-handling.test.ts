// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  defaultGitRunner,
  getBranchOrShortSha,
  getHeadSha,
  PROCESS_CWD,
  setGitRunner,
} from "../../src/git/git-queries.js";
import * as logging from "../../src/log.js";

describe("git-queries error handling", () => {
  beforeEach(() => {
    vi.spyOn(logging.log, "info").mockImplementation(() => {});
    vi.spyOn(logging.log, "warn").mockImplementation(() => {});
    vi.spyOn(logging.log, "debug").mockImplementation(() => {});
    vi.spyOn(logging.log, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setGitRunner(defaultGitRunner);
    vi.restoreAllMocks();
  });

  test("logs warning and returns null when not in a git repo", () => {
    setGitRunner(() => {
      throw new Error("not a git repo");
    });
    const result = getBranchOrShortSha("/tmp");
    expect(result).toBeNull();
    expect(logging.log.warn).toHaveBeenCalledWith(expect.stringContaining("git"));
  });

  test("returns branch name without warning in a real repo", () => {
    const result = getBranchOrShortSha(process.cwd());
    expect(result).toBeTruthy();
    expect(logging.log.warn).not.toHaveBeenCalled();
  });
});

describe("getHeadSha", () => {
  beforeEach(() => {
    vi.spyOn(logging.log, "info").mockImplementation(() => {});
    vi.spyOn(logging.log, "warn").mockImplementation(() => {});
    vi.spyOn(logging.log, "debug").mockImplementation(() => {});
    vi.spyOn(logging.log, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setGitRunner(defaultGitRunner);
    vi.restoreAllMocks();
  });

  test("returns full SHA in a git repo", () => {
    const sha = getHeadSha(PROCESS_CWD);
    expect(sha).toBeTruthy();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns null when not in a git repo", () => {
    setGitRunner(() => {
      throw new Error("not a git repo");
    });
    const sha = getHeadSha("/tmp");
    expect(sha).toBeNull();
  });

  test("returns null (no warning) when git output is not a valid SHA", () => {
    // malformed SHA is detected by shape, not by a runner failure, so it degrades
    // silently to null rather than emitting a failure warning.
    setGitRunner(() => "not-a-sha");
    const sha = getHeadSha(PROCESS_CWD);
    expect(sha).toBeNull();
    expect(logging.log.warn).not.toHaveBeenCalled();
  });
});

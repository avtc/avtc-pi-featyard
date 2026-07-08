// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, test } from "vitest";
import type { TddGitDeps } from "../../src/guardrails/tdd-enforcement.js";
import { detectTestOutcome, isTestRun } from "../../src/guardrails/test-output.js";
import { createFeatureSession, type FeatureSession } from "../../src/state/feature-session.js";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../helpers/workflow-monitor-test-helpers.js";

/** Git deps stub: a git repo whose working-tree change set is fixed per test. */
function fakeGit(files: string[]): TddGitDeps {
  return { workingTreeFiles: () => files, isGitRepo: () => true };
}
/** Git deps stub: NOT a git repo (the check must silently no-op). */
const nonGit: TddGitDeps = { workingTreeFiles: () => [], isGitRepo: () => false };

describe("FeatureSession — TDD write-order check (checkSourceWriteOrder)", () => {
  let handler: FeatureSession;

  test("detects write to a source file as a violation when no test is in the change set", () => {
    handler = createFeatureSession({ tddGitDeps: fakeGit([]) });
    const result = handler.checkSourceWriteOrder("src/utils.ts");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("source-before-test");
  });

  test("no violation when a corresponding test IS in the change set", () => {
    handler = createFeatureSession({ tddGitDeps: fakeGit(["src/utils.ts", "tests/utils.test.ts"]) });
    expect(handler.checkSourceWriteOrder("src/utils.ts")).toBeNull();
  });

  test("detects edit to a source file as a violation", () => {
    handler = createFeatureSession({ tddGitDeps: fakeGit([]) });
    const result = handler.checkSourceWriteOrder("src/utils.ts");
    expect(result).not.toBeNull();
  });

  test("no violation for a test file write (tests are never the subject)", () => {
    handler = createFeatureSession({ tddGitDeps: fakeGit([]) });
    expect(handler.checkSourceWriteOrder("src/utils.test.ts")).toBeNull();
  });

  test("silently no-ops (no violation) when not in a git repo", () => {
    handler = createFeatureSession({ tddGitDeps: nonGit });
    expect(handler.checkSourceWriteOrder("src/utils.ts")).toBeNull();
  });
});

describe("FeatureSession — verification gate (recordSourceWrite + recordTestOutcome)", () => {
  let handler: FeatureSession;

  beforeEach(() => {
    handler = createFeatureSession({ tddGitDeps: fakeGit([]) });
  });

  /** Simulate the caller's bash-result handling: classify + record the outcome. */
  function feedBashResult(command: string, output: string, exitCode: number): void {
    const isTestCommand = isTestRun(command);
    const passed = isTestCommand ? detectTestOutcome(output, exitCode) : null;
    if (passed !== null) handler.recordTestOutcome(passed);
  }

  test("returns 'not-run' initially", () => {
    expect(handler.getVerificationState()).toBe("not-run");
  });

  test("returns 'passed' after a passing test run", () => {
    feedBashResult("npx vitest run", "Tests  1 passed", EXIT_CODE_SUCCESS);
    expect(handler.getVerificationState()).toBe("passed");
  });

  test("returns 'not-run' after a failing test run", () => {
    feedBashResult("npx vitest run", "1 failing", EXIT_CODE_FAILURE);
    expect(handler.getVerificationState()).toBe("not-run");
  });

  test("source write resets a prior 'passed' back to 'not-run'", () => {
    feedBashResult("npx vitest run", "1 passed", EXIT_CODE_SUCCESS);
    expect(handler.getVerificationState()).toBe("passed");
    handler.recordSourceWrite();
    expect(handler.getVerificationState()).toBe("not-run");
  });

  test("a later failing run invalidates an earlier passing run", () => {
    feedBashResult("npx vitest run", "1 passed", EXIT_CODE_SUCCESS);
    expect(handler.getVerificationState()).toBe("passed");
    feedBashResult("npx vitest run", "1 failing", EXIT_CODE_FAILURE);
    expect(handler.getVerificationState()).toBe("not-run");
  });

  test("a non-test command does not touch the gate", () => {
    feedBashResult("git status", "nothing to commit", EXIT_CODE_SUCCESS);
    expect(handler.getVerificationState()).toBe("not-run");
  });
});

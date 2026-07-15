// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
/**
 * : the worktree-failure catch handler in _ensureWorktreeForExecution must also cover an
 * ensureFeatyardJunction throw (the.fy-failure entry), not just the git-worktree-add failure. The
 * existing worktree-integration failure test only triggers step-1 (git worktree add exitCode 1).
 *
 * This triggers a REAL ensureFeatyardJunction throw with no mocking: the mocked git exec returns a
 * worktree path that does NOT exist on disk, so ensureFeatyardJunction's symlinkSync(<worktree>/.featyard)
 * throws ENOENT (missing parent dir). That throw is caught → notify + worktreePath unset (no
 * throw out of the function). This is higher-fidelity than mocking fy-junction.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FeatureState } from "../../../src/state/feature-state.js";
import { initGitDir } from "../../helpers/git-template.js";
import { setSetting, setTestSettings } from "../../helpers/settings-test-helpers.js";
import { cleanupAfterTest, withTempCwd } from "../../helpers/workflow-monitor-test-helpers.js";

describe("_ensureWorktreeForExecution.fy-failure path", () => {
  beforeEach(() => {
    setTestSettings(null);
    // Run inside a temp dir that IS a git repo so the relative worktree path
    // (`.worktrees/...`) resolves under the temp (git root = temp), never the real repo.
    withTempCwd();
    initGitDir(process.cwd());
  });

  afterEach(() => {
    cleanupAfterTest();
  });

  test("an ensureFeatyardJunction throw (symlink ENOENT) is caught → notify + worktreePath unset (no throw)", async () => {
    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    const { _ensureWorktreeForExecution } = await import("../../../src/index.js");

    // createWorktree succeeds (exitCode 0) and returns a path, but the dir is NOT on disk →
    // ensureFeatyardJunction's symlinkSync(<worktree>/.featyard) throws ENOENT (missing parent).
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    const notify = vi.fn();
    const ctx = { hasUI: true, ui: { notify }, actions: { exec: mockExec } };

    const featureState = {
      featureSlug: "fy-fail-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    };

    // Must NOT throw out of the function — the catch converts it to a notify + halt.
    const result = await _ensureWorktreeForExecution(
      featureState as unknown as FeatureState,
      ctx as unknown as ExtensionContext,
    );

    expect(result.git.worktreePath).toBeFalsy();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
    const msg = notify.mock.calls[0][0] as string;
    // The surfaced error is the ensureFeatyardJunction symlink ENOENT; notify carries slug + remediation.
    expect(msg).toContain("ENOENT");
    expect(msg).toContain('"fy-fail-feature"');
    expect(msg).toContain('set branchPolicy="current-branch"');
  });
});

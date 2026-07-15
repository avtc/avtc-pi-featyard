// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, readlinkSync, rmSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FeatureState } from "../../../src/state/feature-state.js";
import { initGitDir } from "../../helpers/git-template.js";
import { setSetting, setTestSettings } from "../../helpers/settings-test-helpers.js";
import { cleanupAfterTest, setupPiCtx, TUI_MODE, withTempCwd } from "../../helpers/workflow-monitor-test-helpers.js";

describe("worktree integration", () => {
  beforeEach(() => {
    setTestSettings(null);
    // Run inside a temp dir that IS a git repo so the relative `.worktrees/<slug>` paths and
    // _ensureWorktreeForExecution's resolveProjectRootFs (git root) resolve under the temp,
    // never the real repo.
    withTempCwd();
    initGitDir(process.cwd());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up globalThis settings state to prevent cross-test pollution
    cleanupAfterTest();
  });

  test("ensureWorktreeForExecution creates worktree + wires.featyard junction when branchPolicy is worktree", async () => {
    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main"); // Set explicit base branch to skip detection

    const { _ensureWorktreeForExecution } = await import("../../../src/index.js");

    // createWorktree returns ".worktrees/<slug>"; create the real dir on disk so the REAL
    // ensureFeatyardJunction (writing under the test PI_FY_HOME sandbox) can set up the junction.
    const worktreeDir = path.resolve(".worktrees", "test-feature");
    mkdirSync(worktreeDir, { recursive: true });
    try {
      const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
      const ctx = { actions: { exec: mockExec } };

      const featureState = {
        featureSlug: "test-feature",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
      };

      const result = await _ensureWorktreeForExecution(
        featureState as unknown as FeatureState,
        ctx as unknown as ExtensionContext,
      );

      expect(mockExec).toHaveBeenCalled();
      expect(mockExec.mock.calls[0][0]).toContain("git worktree add");
      expect(result.git.worktreePath).toBeTruthy();
      // .featyard setup: untrack any git-checked-out.featyard from the worktree index, then heal into a junction.
      // --ignore-unmatch MUST be present so this is a no-op when.featyard is untracked (dropping it would
      // make git rm error out) — assert it explicitly to lock the contract.
      expect(
        mockExec.mock.calls.some(
          (c: unknown[]) =>
            String(c[0]).includes("git rm -r --cached") &&
            String(c[0]).includes(".featyard") &&
            String(c[0]).includes("--ignore-unmatch"),
        ),
      ).toBe(true);
      // The REAL ensureFeatyardJunction created a.featyard junction in the worktree pointing at the external store.
      expect(existsSync(path.join(worktreeDir, ".featyard"))).toBe(true);
      expect(path.resolve(readlinkSync(path.join(worktreeDir, ".featyard")))).toBeTruthy();
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  test("ensureWorktreeForExecution on worktree-creation failure: notifies + leaves worktreePath unset (no throw)", async () => {
    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    const { _ensureWorktreeForExecution } = await import("../../../src/index.js");

    const mockExec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "fatal: already exists" });
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      ui: { notify },
      actions: { exec: mockExec },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    } as unknown as FeatureState;

    // Must NOT throw (pi must not exit over a predictable setup error).
    const result = await _ensureWorktreeForExecution(
      featureState as unknown as FeatureState,
      ctx as unknown as ExtensionContext,
    );

    expect(result.git.worktreePath).toBeFalsy();
    // : the failure notify is the headline UX — verify it carries the slug, the surfaced
    // git error, the remediation hint, and the EXACT log file path (not a generic reference).
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
    const msg = notify.mock.calls[0][0] as string;
    expect(msg).toContain('"test-feature"'); // slug
    expect(msg).toContain("already exists"); // surfaced error
    expect(msg).toContain('set branchPolicy="current-branch"'); // remediation hint
    const { getLogFilePath } = await import("../../../src/log.js");
    expect(msg).toContain(getLogFilePath(new Date())); // exact log file path
  });

  // Note: an ensureFeatyardJunction throw (the other entry into the same catch) is now near-impossible
  // to trigger — ensureFeatyardJunction self-heals plain dirs / wrong-target links and only throws on
  // rmSync failure (covered indirectly). The catch→notify→halt path above exercises the same
  // handler, so the.fy-failure case is not duplicated here.

  test("ensureWorktreeForExecution skips when branchPolicy is current-branch", async () => {
    setSetting("branchPolicy", "current-branch");

    const { _ensureWorktreeForExecution } = await import("../../../src/index.js");

    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    const ctx = {
      actions: { exec: mockExec },
    } as unknown as ExtensionContext;

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    } as unknown as FeatureState;

    const result = await _ensureWorktreeForExecution(featureState, ctx);

    expect(mockExec).not.toHaveBeenCalled();
    expect(result.git.worktreePath).toBeFalsy();
  });

  test("ensureWorktreeForExecution skips when worktreePath already set", async () => {
    setSetting("branchPolicy", "worktree");

    const { _ensureWorktreeForExecution } = await import("../../../src/index.js");

    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    const ctx = {
      actions: { exec: mockExec },
    } as unknown as ExtensionContext;

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: "/existing/worktree", baseBranch: null },
    } as unknown as FeatureState;

    const result = await _ensureWorktreeForExecution(featureState, ctx);

    expect(mockExec).not.toHaveBeenCalled();
    expect(result.git.worktreePath).toBe("/existing/worktree");
  });

  test("cleanupWorktreeOnFinish removes worktree when worktreePath is set", async () => {
    setSetting("branchPolicy", "worktree");

    const { _cleanupWorktreeOnFinish } = await import("../../../src/index.js");

    const mockExec = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("git rev-parse")) {
        return Promise.resolve({ exitCode: 0, stdout: "/home/user/project/.git\n" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "" });
    });
    const ctx = {
      actions: { exec: mockExec },
    } as unknown as ExtensionContext;

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: "/tmp/worktree-test", baseBranch: null },
    };

    await _cleanupWorktreeOnFinish(featureState, ctx);

    // Should call git rev-parse to find main repo, then git worktree remove
    const calls = (mockExec.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(calls.some((c: string) => c.includes("git worktree remove"))).toBe(true);
  });

  test("cleanupWorktreeOnFinish skips when worktreePath is null", async () => {
    const { _cleanupWorktreeOnFinish } = await import("../../../src/index.js");

    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    const ctx = {
      actions: { exec: mockExec },
    } as unknown as ExtensionContext;

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    } as unknown as FeatureState;

    await _cleanupWorktreeOnFinish(featureState, ctx);

    expect(mockExec).not.toHaveBeenCalled();
  });

  test("cleanupWorktreeOnFinish clears worktree status icon even when removal throws", async () => {
    const { _cleanupWorktreeOnFinish } = await import("../../../src/index.js");

    // resolveMainRepoPath succeeds, but removeWorktree throws (here: an unsafe worktreePath
    // trips validateShellArg — a regular Error caught by cleanup). The status icon must
    // still clear: completion is the off-signal, and a failed removal must not leave
    // the icon stuck (regression: the catch used to return without clearing it).
    const mockExec = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("git rev-parse")) {
        return Promise.resolve({ exitCode: 0, stdout: "/home/user/project/.git\n" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "" });
    });
    const setStatus = vi.fn();
    const ctx = {
      hasUI: true,
      ui: { setStatus },
      actions: { exec: mockExec },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: "$(rm -rf /)", baseBranch: null },
    };

    await _cleanupWorktreeOnFinish(featureState, ctx);

    // Icon cleared despite removeWorktree throwing a caught error
    expect(setStatus).toHaveBeenCalledWith("worktree", undefined);
  });

  test("cleanupWorktreeOnFinish clears worktree status icon on success too", async () => {
    setSetting("branchPolicy", "worktree");
    const { _cleanupWorktreeOnFinish } = await import("../../../src/index.js");

    const mockExec = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("git rev-parse")) {
        return Promise.resolve({ exitCode: 0, stdout: "/home/user/project/.git\n" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "" });
    });
    const setStatus = vi.fn();
    const ctx = {
      hasUI: true,
      ui: { setStatus },
      actions: { exec: mockExec },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: "/tmp/worktree-test", baseBranch: null },
    };

    await _cleanupWorktreeOnFinish(featureState, ctx);

    expect(setStatus).toHaveBeenCalledWith("worktree", undefined);
  });

  test("ensureWorktreeForExecution propagates TypeError from worktree creation", async () => {
    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    const { _ensureWorktreeForExecution } = await import("../../../src/index.js");

    // Mock exec to throw TypeError (simulating programming error in worktree.ts)
    const mockExec = vi.fn().mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    const ctx = {
      actions: { exec: mockExec },
    } as unknown as ExtensionContext;

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    } as unknown as FeatureState;

    await expect(_ensureWorktreeForExecution(featureState, ctx)).rejects.toThrow(TypeError);
  });

  test("cleanupWorktreeOnFinish propagates TypeError from worktree removal", async () => {
    const { _cleanupWorktreeOnFinish } = await import("../../../src/index.js");

    const mockExec = vi.fn().mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    const ctx = {
      actions: { exec: mockExec },
    } as unknown as ExtensionContext;

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: "/tmp/worktree-test", baseBranch: null },
    };

    await expect(_cleanupWorktreeOnFinish(featureState, ctx)).rejects.toThrow(TypeError);
  });
});

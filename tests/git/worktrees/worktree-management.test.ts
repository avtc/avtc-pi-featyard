// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _setRmSync,
  createWorktree,
  detectBaseBranch,
  getBaseBranchCandidates,
  removeWorktree,
  resolveMainRepoPath,
  resolveMainRepoPathSync,
} from "../../../src/git/worktrees/worktree-lifecycle.js";
import { mockExecSync, restoreExecSync } from "../../helpers/mock-exec-sync.js";

let execSyncMock = vi.fn();

describe("worktree management", () => {
  test("createWorktree runs git worktree add", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    const result = await createWorktree({
      slug: "test-feature",
      baseBranch: "main",
      exec: mockExec,
    });
    expect(result.branch).toBe("feature/test-feature");
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git worktree add"));
  });

  test("createWorktree uses custom worktreeDir when provided", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    const result = await createWorktree({
      slug: "my-feature",
      baseBranch: "develop",
      worktreeDir: "/custom/dir/my-feature",
      exec: mockExec,
    });
    expect(result.path).toBe("/custom/dir/my-feature");
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("/custom/dir/my-feature"));
  });

  test("createWorktree throws on non-zero exit code", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "fatal: already exists" });
    await expect(createWorktree({ slug: "dup-feature", baseBranch: "main", exec: mockExec })).rejects.toThrow(
      "Failed to create worktree",
    );
  });

  test("createWorktree rejects shell-unsafe slug", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    await expect(createWorktree({ slug: "evil; rm -rf /", baseBranch: "main", exec: mockExec })).rejects.toThrow(
      "Invalid slug",
    );
  });

  test("createWorktree rejects shell-unsafe baseBranch", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    await expect(createWorktree({ slug: "ok", baseBranch: "main; echo pwned", exec: mockExec })).rejects.toThrow(
      "Invalid baseBranch",
    );
  });

  test("removeWorktree runs git worktree remove --force from main repo cwd", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    await removeWorktree({ worktreePath: ".worktrees/test", mainRepoPath: "/repo", exec: mockExec });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("git worktree remove --force"),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  test("removeWorktree deletes branch when branchName provided", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    await removeWorktree({
      worktreePath: ".worktrees/test",
      mainRepoPath: "/repo",
      branchName: "feature/test",
      exec: mockExec,
    });
    // Without baseBranch, merge status check is skipped — goes straight to git branch -d
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining("git branch --merged"), expect.anything());
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("git branch -d"),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  test("removeWorktree does not delete branch when branchName omitted", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    await removeWorktree({ worktreePath: ".worktrees/test", mainRepoPath: "/repo", exec: mockExec });
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining("git branch -d"), expect.anything());
  });

  test("removeWorktree does not throw on failure (logs warning)", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "fatal: not a valid worktree" });
    await expect(
      removeWorktree({ worktreePath: ".worktrees/test", mainRepoPath: "/repo", exec: mockExec }),
    ).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("git worktree remove"),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  test("removeWorktree falls back to direct delete + prune when git worktree remove fails (Windows long paths)", async () => {
    // Regression: on Windows, `git worktree remove --force` can exit non-zero with
    // "Filename too long" when node_modules paths exceed MAX_PATH, leaving the
    // directory on disk. removeWorktree must then delete it directly (long-path-
    // capable fs.rm) and prune stale worktree metadata.
    const rmSyncMock = vi.fn();
    _setRmSync(rmSyncMock);
    try {
      const mockExec = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("git worktree remove")) {
          return Promise.resolve({ exitCode: 128, stdout: "error: failed to delete '...': Filename too long" });
        }
        if (cmd.includes("git worktree prune")) {
          return Promise.resolve({ exitCode: 0, stdout: "" });
        }
        return Promise.resolve({ exitCode: 0, stdout: "" });
      });

      await removeWorktree({
        worktreePath: ".worktrees/long-feature",
        mainRepoPath: "E:/repo",
        exec: mockExec,
      });

      // Direct recursive delete ran against the absolute path resolved from mainRepoPath
      expect(rmSyncMock).toHaveBeenCalledWith(
        expect.stringContaining(".worktrees"),
        expect.objectContaining({ recursive: true, force: true }),
      );
      // The path was resolved against mainRepoPath (absolute), not left relative
      const deletedPath = rmSyncMock.mock.calls[0]?.[0] as string;
      expect(deletedPath).toMatch(/long-feature$/);
      expect(deletedPath).not.toBe(".worktrees/long-feature"); // resolved, not bare relative
      // prune was called to clean stale metadata
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining("git worktree prune"),
        expect.objectContaining({ cwd: "E:/repo" }),
      );
    } finally {
      _setRmSync(null); // restore default fs.rmSync
    }
  });

  test("removeWorktree rejects shell-unsafe worktreePath", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    await expect(removeWorktree({ worktreePath: "; rm -rf /", mainRepoPath: "/repo", exec: mockExec })).rejects.toThrow(
      "Invalid worktreePath",
    );
  });

  test("removeWorktree accepts Windows-style absolute mainRepoPath (drive-letter colon)", async () => {
    // mainRepoPath is used only as an exec {cwd} option (never interpolated into the
    // shell string), so it must NOT be rejected for containing a drive-letter colon.
    // Regression: previously validateShellArg threw "Invalid mainRepoPath" on Windows,
    // silently skipping worktree + branch cleanup.
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    await expect(
      removeWorktree({
        worktreePath: ".worktrees/test",
        mainRepoPath: "E:/sync/unique/work/git/pi/avtc-pi-subagent",
        exec: mockExec,
      }),
    ).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("git worktree remove"),
      expect.objectContaining({ cwd: "E:/sync/unique/work/git/pi/avtc-pi-subagent" }),
    );
  });

  test("removeWorktree skips branch deletion when branch not merged", async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.includes("git branch --merged")) {
        return { exitCode: 0, stdout: "  main\n  other" }; // Not in merged list
      }
      return { exitCode: 0, stdout: "" };
    };

    await removeWorktree({
      worktreePath: ".worktrees/test",
      mainRepoPath: "/repo",
      branchName: "feature/test",
      baseBranch: "main",
      exec,
    });

    // Should have checked merge status
    expect(execCalls.some((c) => c.includes("git branch --merged"))).toBe(true);
    // Should NOT have tried git branch -d
    expect(execCalls.some((c) => c.includes("git branch -d"))).toBe(false);
    // But worktree removal SHOULD still have been attempted
    expect(execCalls.some((c) => c.includes("git worktree remove"))).toBe(true);
  });

  test("removeWorktree deletes branch when branch IS merged", async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.includes("git branch --merged")) {
        return { exitCode: 0, stdout: "  main\n  feature/test" }; // Branch IS in merged list
      }
      return { exitCode: 0, stdout: "" };
    };

    await removeWorktree({
      worktreePath: ".worktrees/test",
      mainRepoPath: "/repo",
      branchName: "feature/test",
      baseBranch: "main",
      exec,
    });

    // Should have tried git branch -d
    expect(execCalls.some((c) => c.includes("git branch -d feature/test"))).toBe(true);
  });

  test("removeWorktree skips branch deletion when git branch --merged fails (non-zero exit)", async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.includes("git branch --merged")) {
        // Simulate non-zero exit (e.g., baseBranch doesn't exist locally)
        return { exitCode: 128, stdout: "", stderr: "fatal: bad revision 'main'" };
      }
      return { exitCode: 0, stdout: "" };
    };

    await removeWorktree({
      worktreePath: ".worktrees/test",
      mainRepoPath: "/repo",
      branchName: "feature/test",
      baseBranch: "main",
      exec,
    });

    // Should have checked merge status
    expect(execCalls.some((c) => c.includes("git branch --merged"))).toBe(true);
    // Should NOT have tried git branch -d — command failed, can't determine merge status
    expect(execCalls.some((c) => c.includes("git branch -d"))).toBe(false);
    // But worktree removal SHOULD still have been attempted
    expect(execCalls.some((c) => c.includes("git worktree remove"))).toBe(true);
  });

  test("removeWorktree skips branch deletion when git branch --merged throws", async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.includes("git branch --merged")) {
        throw new Error("Command failed with exit code 128");
      }
      return { exitCode: 0, stdout: "" };
    };

    await removeWorktree({
      worktreePath: ".worktrees/test",
      mainRepoPath: "/repo",
      branchName: "feature/test",
      baseBranch: "main",
      exec,
    });

    // Should NOT have tried git branch -d — command threw
    expect(execCalls.some((c) => c.includes("git branch -d"))).toBe(false);
    // But worktree removal SHOULD still have been attempted
    expect(execCalls.some((c) => c.includes("git worktree remove"))).toBe(true);
  });

  test("removeWorktree rejects shell-unsafe branchName", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    await expect(
      removeWorktree({
        worktreePath: ".worktrees/test",
        mainRepoPath: "/repo",
        branchName: "feature/test; echo pwned",
        exec: mockExec,
      }),
    ).rejects.toThrow("Invalid branchName");
  });

  test("removeWorktree rejects shell-unsafe baseBranch", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" });
    await expect(
      removeWorktree({
        worktreePath: ".worktrees/test",
        mainRepoPath: "/repo",
        branchName: "feature/test",
        baseBranch: "main; echo pwned",
        exec: mockExec,
      }),
    ).rejects.toThrow("Invalid baseBranch");
  });

  test("resolveMainRepoPath strips.git from git-common-dir", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "/home/user/project/.git\n" });
    const result = await resolveMainRepoPath(mockExec);
    expect(result).toBe("/home/user/project");
  });

  test("resolveMainRepoPath handles Windows paths", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "C:/Users/test/project/.git\n" });
    const result = await resolveMainRepoPath(mockExec);
    expect(result).toBe("C:/Users/test/project");
  });

  test("resolveMainRepoPath handles worktree git-common-dir with worktrees suffix", async () => {
    const mockExec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "/home/user/project/.git/worktrees/feature-test\n",
    });
    const result = await resolveMainRepoPath(mockExec);
    expect(result).toBe("/home/user/project");
  });
});

describe("detectBaseBranch", () => {
  test("returns remote HEAD when available", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "refs/remotes/origin/main\n" });
    const result = await detectBaseBranch(mockExec);
    expect(result).toBe("main");
    expect(mockExec).toHaveBeenCalledWith("git symbolic-ref refs/remotes/origin/HEAD");
  });

  test("returns null when remote HEAD not set and no common branches", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // symbolic-ref fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // branch -r returns empty
    const result = await detectBaseBranch(mockExec);
    expect(result).toBeNull();
  });

  test("returns 'main' when main branch exists locally", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // symbolic-ref fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // branch -r empty
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n* feature/test\n" }); // branch --list main
    const result = await detectBaseBranch(mockExec);
    expect(result).toBe("main");
  });

  test("returns 'develop' when develop exists but main does not", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // symbolic-ref fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // branch -r empty
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list main (not found)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master (not found)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  develop\n" }); // branch --list develop
    const result = await detectBaseBranch(mockExec);
    expect(result).toBe("develop");
  });

  test("returns null when multiple candidates exist (ambiguous)", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // symbolic-ref fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  origin/main\n  origin/develop\n" }); // branch -r shows multiple
    const result = await detectBaseBranch(mockExec);
    expect(result).toBeNull(); // ambiguous — caller should prompt
  });

  test("returns remote branch when only one remote branch exists", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // symbolic-ref fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  origin/main\n" }); // branch -r shows one
    const result = await detectBaseBranch(mockExec);
    expect(result).toBe("main");
  });
});

describe("getBaseBranchCandidates", () => {
  // Flow: rev-parse HEAD → for each of [main, master, develop]:
  //   branch --list <name> → if found, continue; if not, branch -r --list origin/<name>

  test("returns current branch + common local branches", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n" }) // branch --list main (found → continue)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master (not found)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master (not found)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  develop\n" }); // branch --list develop (found)
    const result = await getBaseBranchCandidates(mockExec);
    expect(result).toEqual(["develop", "feature/test", "main"]);
  });

  test("includes current branch even when not a common name", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "trunk\n" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list main
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/main
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list develop
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }); // branch -r --list origin/develop
    const result = await getBaseBranchCandidates(mockExec);
    expect(result).toEqual(["trunk"]);
  });

  test("finds common branch via remote when not local", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list main (not local)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  origin/main\n" }) // branch -r --list origin/main (found remote)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }); // branch --list develop
    const result = await getBaseBranchCandidates(mockExec);
    expect(result).toContain("main");
    expect(result).toContain("feature/test");
  });

  test("returns verified fallback when no candidates found", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // rev-parse HEAD fails (detached)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list main
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/main
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list develop
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/develop
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n" }) // rev-parse --verify refs/heads/main
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }); // rev-parse --verify refs/heads/master
    const result = await getBaseBranchCandidates(mockExec);
    expect(result).toEqual(["main"]);
  });

  test("returns [main] as absolute last resort when nothing verified", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // rev-parse HEAD fails
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list main
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/main
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list develop
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/develop
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // rev-parse --verify refs/heads/main
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }); // rev-parse --verify refs/heads/master
    const result = await getBaseBranchCandidates(mockExec);
    expect(result).toEqual(["main"]);
  });

  test("deduplicates and sorts candidates", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "main\n" }) // rev-parse HEAD (current = main)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n" }) // branch --list main (duplicate → continue)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  develop\n" }); // branch --list develop (found)
    const result = await getBaseBranchCandidates(mockExec);
    expect(result).toEqual(["develop", "main"]);
  });
});

describe("resolveMainRepoPathSync", () => {
  beforeEach(() => {
    execSyncMock = vi.fn();
    mockExecSync(execSyncMock);
  });

  afterEach(() => {
    restoreExecSync();
  });

  test("strips.git from absolute git-common-dir path", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("--git-common-dir")) return "/home/user/project/.git\n";
      return "";
    });
    const result = resolveMainRepoPathSync();
    expect(result).toBe("/home/user/project");
  });

  test("strips.git/worktrees/<id> from worktree git-common-dir", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("--git-common-dir")) return "/home/user/project/.git/worktrees/feature-test\n";
      return "";
    });
    const result = resolveMainRepoPathSync();
    expect(result).toBe("/home/user/project");
  });

  test("handles Windows paths with backslashes", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("--git-common-dir")) return "C:\\Users\\test\\project\\.git\n";
      return "";
    });
    const result = resolveMainRepoPathSync();
    expect(result).toBe("C:/Users/test/project");
  });

  test("falls back to --show-toplevel for relative git-common-dir", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("--git-common-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/home/user/project\n";
      return "";
    });
    const result = resolveMainRepoPathSync();
    expect(result).toBe("/home/user/project");
  });

  test("returns null when git commands fail", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not a git repository");
    });
    const result = resolveMainRepoPathSync();
    expect(result).toBeNull();
  });

  describe("caching", () => {
    test("second call returns cached value without calling execSync again", () => {
      execSyncMock.mockImplementation((cmd: string) => {
        if (cmd.includes("--git-common-dir")) return "/home/user/project/.git\n";
        return "";
      });
      const first = resolveMainRepoPathSync();
      expect(first).toBe("/home/user/project");
      const callCountAfterFirst = execSyncMock.mock.calls.length;

      const second = resolveMainRepoPathSync();
      expect(second).toBe("/home/user/project");
      // No additional execSync calls — cache was used
      expect(execSyncMock.mock.calls.length).toBe(callCountAfterFirst);
    });

    test("cache survives across multiple calls", () => {
      execSyncMock.mockImplementation((cmd: string) => {
        if (cmd.includes("--git-common-dir")) return "/home/user/project/.git\n";
        return "";
      });
      for (let i = 0; i < 10; i++) {
        expect(resolveMainRepoPathSync()).toBe("/home/user/project");
      }
      // Only 1 execSync call for all 10 invocations
      expect(execSyncMock.mock.calls.length).toBe(1);
    });

    test("_setExecSync invalidates cache", () => {
      execSyncMock.mockImplementation((cmd: string) => {
        if (cmd.includes("--git-common-dir")) return "/home/user/project/.git\n";
        return "";
      });
      const first = resolveMainRepoPathSync();
      expect(first).toBe("/home/user/project");

      // Simulate cache invalidation via _setExecSync
      const newMock = vi.fn((cmd: string) => {
        if (cmd.includes("--git-common-dir")) return "/home/user/other-project/.git\n";
        return "";
      });
      mockExecSync(newMock);

      const second = resolveMainRepoPathSync();
      expect(second).toBe("/home/user/other-project");
      expect(newMock.mock.calls.length).toBe(1);

      // Restore original mock for afterEach cleanup
      mockExecSync(execSyncMock);
    });

    test("caches null result from failed git command", () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("not a git repository");
      });
      const first = resolveMainRepoPathSync();
      expect(first).toBeNull();
      const callCountAfterFirst = execSyncMock.mock.calls.length;

      const second = resolveMainRepoPathSync();
      expect(second).toBeNull();
      // No additional calls — null was cached
      expect(execSyncMock.mock.calls.length).toBe(callCountAfterFirst);
    });
  });
});

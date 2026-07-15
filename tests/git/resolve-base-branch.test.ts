// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveBaseBranch } from "../../src/git/resolve-base-branch.js";
import * as worktreeHelpers from "../../src/git/worktrees/worktree-helpers.js";
import * as worktree from "../../src/git/worktrees/worktree-lifecycle.js";
import * as autoAgentNotify from "../../src/kanban/auto-agent/auto-agent-notify.js";
import { getSettings } from "../../src/settings/settings-ui.js";
import { UserCancelledError, ValidationError } from "../../src/shared/errors.js";
import * as orchestratorRefs from "../../src/shared/workflow-refs.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import { cleanupAfterTest, setupPiCtx, TUI_MODE, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

/** No base branch override (reset to default) */
const NO_BASE_BRANCH: string | null = null;

/** No select function (headless mode) */
const _NO_SELECT_FN: ((...args: unknown[]) => Promise<unknown>) | null = null;

/** No input function (headless mode) */
const _NO_INPUT_FN: ((prompt: string) => string | undefined) | null = null;

function createMockCtx(
  selectFn: ((...args: unknown[]) => Promise<unknown>) | null,
  inputFn: ((...args: unknown[]) => Promise<unknown>) | null,
): ExtensionContext {
  const ctx = {
    ui: {
      select: selectFn ?? vi.fn(),
      input: inputFn ?? vi.fn(),
      notify: vi.fn(),
    },
    hasUI: true,
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
  setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);
  return ctx;
}

let spies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  // Run in a temp dir: createMockCtx uses cwd:process.cwd(), and the "saves to project settings"
  // path calls updateProjectSetting(process.cwd(), ...) which writes .pi/avtc-pi-featyard-settings.json.
  // Must land in the temp, never the real repo.
  withTempCwd();
  setTestSettings(null);
  setSetting("baseBranch", NO_BASE_BRANCH);
  vi.clearAllMocks();
  spies = [];
});

afterEach(() => {
  spies.forEach((s) => {
    s.mockRestore();
  });
  vi.restoreAllMocks();
  cleanupAfterTest();
});

function spy(obj: object, method: string): ReturnType<typeof vi.spyOn> {
  const s = vi.spyOn(obj, method as never);
  spies.push(s);
  return s;
}

describe("resolveBaseBranch", () => {
  test("returns saved setting immediately when baseBranch is set", async () => {
    setSetting("baseBranch", "develop");
    const ctx = createMockCtx(null, null);

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("develop");
  });

  test("auto-detects when no UI available and detection succeeds", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);
    const ctxNoUI = { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext;

    const result = await resolveBaseBranch(ctxNoUI);

    expect(result).toBe("main");
  });

  test("defaults to 'main' when detection fails and no UI", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue(undefined);
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue([]);
    const ctxNoUI = { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext;

    const result = await resolveBaseBranch(ctxNoUI);

    expect(result).toBe("main");
  });

  test("defaults to 'main' when git detection throws", async () => {
    spy(worktree, "detectBaseBranch").mockRejectedValue(new Error("git not found"));
    spy(worktree, "getBaseBranchCandidates").mockRejectedValue(new Error("git not found"));
    const ctx = createMockCtx(null, null);

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("main");
  });

  test("prompts user and saves selection to session when user picks candidate", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main", "develop"]);

    const mockSelect = vi
      .fn()
      .mockResolvedValueOnce("main (detected)") // branch selection
      .mockResolvedValueOnce("This session only"); // save location
    const ctx = createMockCtx(mockSelect, null);

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("main");
    expect(getSettings().baseBranch).toBe("main");
  });

  test("prompts user and saves to project settings", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi
      .fn()
      .mockResolvedValueOnce("main (detected)") // branch selection
      .mockResolvedValueOnce("Project settings (persists for all sessions)"); // save location
    const ctx = createMockCtx(mockSelect, null);

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("main");
    // Project settings path calls updateProjectSetting + loadSettingsIntoMemory
    // We can't verify getSettings() since project file may not exist in test env
  });

  test("user enters custom branch name", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi
      .fn()
      .mockResolvedValueOnce("Type your own...") // branch selection
      .mockResolvedValueOnce("This session only"); // save location
    const mockInput = vi.fn().mockResolvedValue("feature/custom");
    const ctx = createMockCtx(mockSelect, mockInput);

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("feature/custom");
    expect(mockInput).toHaveBeenCalledWith("Enter base branch name:", "main");
  });

  test("custom branch with empty input throws UserCancelledError", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi.fn().mockResolvedValueOnce("Type your own...");
    const mockInput = vi.fn().mockResolvedValue("");
    const ctx = createMockCtx(mockSelect, mockInput);

    await expect(resolveBaseBranch(ctx)).rejects.toThrow(UserCancelledError);
  });

  test("custom branch with shell-unsafe characters throws error", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi.fn().mockResolvedValueOnce("Type your own...");
    const mockInput = vi.fn().mockResolvedValue("foo; rm -rf /");
    const ctx = createMockCtx(mockSelect, mockInput);

    await expect(resolveBaseBranch(ctx)).rejects.toThrow(ValidationError);
  });

  test("custom branch with backticks throws error", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi.fn().mockResolvedValueOnce("Type your own...");
    const mockInput = vi.fn().mockResolvedValue("`whoami`");
    const ctx = createMockCtx(mockSelect, mockInput);

    await expect(resolveBaseBranch(ctx)).rejects.toThrow(ValidationError);
  });

  test("custom branch with dollar sign throws error", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi.fn().mockResolvedValueOnce("Type your own...");
    const mockInput = vi.fn().mockResolvedValue("$(cat /etc/passwd)");
    const ctx = createMockCtx(mockSelect, mockInput);

    await expect(resolveBaseBranch(ctx)).rejects.toThrow(ValidationError);
  });

  test("propagates UserCancelledError when user cancels branch selection", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi.fn().mockResolvedValueOnce(undefined); // user cancelled
    const ctx = createMockCtx(mockSelect, null);

    await expect(resolveBaseBranch(ctx)).rejects.toThrow(UserCancelledError);
  });

  test("notifies auto-agent blocked/unblocked when slug is active", async () => {
    const blockedSpy = spy(autoAgentNotify, "notifyAutoAgentBlocked");
    const unblockedSpy = spy(autoAgentNotify, "notifyAutoAgentUnblocked");
    spy(orchestratorRefs, "getActiveFeatureSlug").mockReturnValue("2026-06-01-test");
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi
      .fn()
      .mockResolvedValueOnce("main (detected)") // branch selection
      .mockResolvedValueOnce("This session only"); // save location
    const ctx = createMockCtx(mockSelect, null);

    await resolveBaseBranch(ctx);

    expect(blockedSpy).toHaveBeenCalledWith("2026-06-01-test");
    expect(unblockedSpy).toHaveBeenCalledWith("2026-06-01-test");
  });

  test("save location cancelled defaults to session-only", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi
      .fn()
      .mockResolvedValueOnce("main (detected)") // branch selection
      .mockResolvedValueOnce(undefined); // save location cancelled
    const ctx = createMockCtx(mockSelect, null);

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("main");
    expect(getSettings().baseBranch).toBe("main");
  });
});

describe("verifyBranchExists (via resolveBaseBranch custom branch path)", () => {
  /** Helper: set up mocks for custom branch input and return the gitExec mock fn */
  function setupCustomBranchWithGitMock(gitResponses: Array<{ exitCode: number; stdout: string }>, branchName: string) {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi
      .fn()
      .mockResolvedValueOnce("Type your own...") // branch selection
      .mockResolvedValueOnce("This session only"); // save location
    const mockInput = vi.fn().mockResolvedValue(branchName);
    const ctx = createMockCtx(mockSelect, mockInput);

    // Mock createGitExec to return our controlled git mock
    let callIdx = 0;
    const mockGitExec = vi.fn(async () => {
      const resp = gitResponses[callIdx] ?? { exitCode: 0, stdout: "abc123" };
      callIdx++;
      return resp;
    });
    spy(worktreeHelpers, "createGitExec").mockReturnValue(mockGitExec);

    return { ctx, mockGitExec };
  }

  test("branch exists locally — no warnings", async () => {
    const { ctx, mockGitExec } = setupCustomBranchWithGitMock(
      [{ exitCode: 0, stdout: "abc123" }], // git rev-parse --verify refs/heads/test-branch
      "test-branch",
    );

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("test-branch");
    expect(mockGitExec).toHaveBeenCalledTimes(1);
    expect(mockGitExec).toHaveBeenCalledWith("git rev-parse --verify refs/heads/test-branch");
  });

  test("branch not local but exists remote — warns and continues", async () => {
    const { ctx, mockGitExec } = setupCustomBranchWithGitMock(
      [
        { exitCode: 1, stdout: "" },
        { exitCode: 0, stdout: "abc123" },
      ], // not local, found remote
      "test-branch",
    );

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("test-branch");
    expect(mockGitExec).toHaveBeenCalledTimes(2);
    expect(mockGitExec).toHaveBeenNthCalledWith(2, "git rev-parse --verify refs/remotes/origin/test-branch");
  });

  test("branch not found locally or remotely — warns but uses name anyway", async () => {
    const { ctx, mockGitExec } = setupCustomBranchWithGitMock(
      [
        { exitCode: 1, stdout: "" },
        { exitCode: 1, stdout: "" },
      ], // not local, not remote
      "test-branch",
    );

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("test-branch");
    expect(mockGitExec).toHaveBeenCalledTimes(2);
  });

  test("git throws exception — continues with branch name", async () => {
    spy(worktree, "detectBaseBranch").mockResolvedValue("main");
    spy(worktree, "getBaseBranchCandidates").mockResolvedValue(["main"]);

    const mockSelect = vi.fn().mockResolvedValueOnce("Type your own...").mockResolvedValueOnce("This session only");
    const mockInput = vi.fn().mockResolvedValue("test-branch");
    const ctx = createMockCtx(mockSelect, mockInput);

    const mockGitExec = vi.fn().mockRejectedValue(new Error("git not installed"));
    spy(worktreeHelpers, "createGitExec").mockReturnValue(mockGitExec);

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("test-branch");
    // verifyBranchExists catches the error and continues
  });

  test("branch name with special characters is sanitized in git command", async () => {
    // The validation regex rejects most special chars, but hyphens, dots, slashes are allowed
    const { ctx, mockGitExec } = setupCustomBranchWithGitMock(
      [{ exitCode: 0, stdout: "abc123" }],
      "feature/my-branch.v2",
    );

    const result = await resolveBaseBranch(ctx);

    expect(result).toBe("feature/my-branch.v2");
    expect(mockGitExec).toHaveBeenCalledWith("git rev-parse --verify refs/heads/feature/my-branch.v2");
  });
});

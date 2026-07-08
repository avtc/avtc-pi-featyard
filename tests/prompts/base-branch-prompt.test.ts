// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { _ensureWorktreeForExecution, _resolveBaseBranch } from "../../src/index.js";
import { getSettings } from "../../src/settings/settings-ui.js";
import type { FeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import { createFakePi, setupPiCtx, TUI_MODE, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

// Mock sequence for getBaseBranchCandidates (after detectBaseBranch calls):
// 1. rev-parse HEAD
// 2. branch --list main → if found, continue (skip remote check)
// 3. branch --list master → if not found, branch -r --list origin/master
// 4. branch --list develop → if not found, branch -r --list origin/develop

describe("base branch selection prompt", () => {
  beforeEach(() => {
    setTestSettings(null);
    withTempCwd();
  });

  test("prompts for branch then save location; saves only baseBranch to project file", async () => {
    createFakePi();
    setTestSettings(null);
    setTestSettings(null);
    const selectMock = vi
      .fn()
      .mockResolvedValueOnce("main (detected)") // branch selection
      .mockResolvedValueOnce("Project settings (persists for all sessions)"); // save location

    const ensureWorktree = _ensureWorktreeForExecution;

    const mockExec = vi
      .fn()
      // detectBaseBranch: symbolic-ref succeeds
      .mockResolvedValueOnce({ exitCode: 0, stdout: "refs/remotes/origin/main\n" })
      // getBaseBranchCandidates: rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" })
      // branch --list main (found → continue)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n" })
      // branch --list master (not found)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      // branch -r --list origin/master (not found)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      // branch --list develop (not found)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      // branch -r --list origin/develop (not found)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      // createWorktree: success
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" });

    const ctx = {
      actions: { exec: mockExec },
      hasUI: true,
      ui: { select: selectMock },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", null);

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {},
      },
    } as unknown as FeatureState;

    await ensureWorktree(featureState, ctx);

    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(selectMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("base branch"),
      expect.arrayContaining(["main (detected)", "feature/test", "Type your own..."]),
    );
    expect(selectMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Save base branch"),
      expect.arrayContaining(["Project settings (persists for all sessions)", "This session only"]),
    );

    const projectSettingsPath = path.join(process.cwd(), ".pi", "avtc-pi-feature-flow-settings.json");
    expect(fs.existsSync(projectSettingsPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(projectSettingsPath, "utf-8"));
    expect(saved.baseBranch).toBe("main");
    expect(Object.keys(saved)).toEqual(["baseBranch"]);
  });

  test("saves baseBranch to session only when user chooses 'This session only'", async () => {
    createFakePi();
    setTestSettings(null);
    setTestSettings(null);
    const selectMock = vi
      .fn()
      .mockResolvedValueOnce("develop") // branch selection
      .mockResolvedValueOnce("This session only"); // save location

    const ensureWorktree = _ensureWorktreeForExecution;

    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // symbolic-ref fails (detectBaseBranch)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  origin/main\n  origin/develop\n" }) // branch -r (detectBaseBranch: ambiguous)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n" }) // branch --list main (found → continue)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  develop\n" }) // branch --list develop (found → continue)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // createWorktree

    const ctx = {
      actions: { exec: mockExec },
      hasUI: true,
      ui: { select: selectMock },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", null);

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {},
      },
    } as unknown as FeatureState;

    await ensureWorktree(featureState, ctx);

    expect(getSettings().baseBranch).toBe("develop");

    const projectSettingsPath = path.join(process.cwd(), ".pi", "avtc-pi-feature-flow-settings.json");
    expect(fs.existsSync(projectSettingsPath)).toBe(false);
  });

  test("defaults to main when no UI available and detection is ambiguous", async () => {
    createFakePi();
    setTestSettings(null);
    setTestSettings(null);

    const ensureWorktree = _ensureWorktreeForExecution;

    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // symbolic-ref fails (detectBaseBranch)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  origin/main\n  origin/develop\n" }) // branch -r (detectBaseBranch: ambiguous)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n" }) // branch --list main (found → continue)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  develop\n" }) // branch --list develop (found → continue)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // createWorktree

    const ctx = {
      actions: { exec: mockExec },
      hasUI: false,
      ui: {},
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", null);

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {},
      },
    } as unknown as FeatureState;

    const result = await ensureWorktree(featureState, ctx);
    expect(result.git.worktreePath).toBeDefined();
  });

  test("skips prompt when baseBranch is already set in settings", async () => {
    createFakePi();
    setTestSettings(null);
    setTestSettings(null);
    const selectMock = vi.fn();

    const ensureWorktree = _ensureWorktreeForExecution;

    const mockExec = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // createWorktree only

    const ctx = {
      actions: { exec: mockExec },
      hasUI: true,
      ui: { select: selectMock },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "develop");

    const featureState = {
      featureSlug: "test-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {},
      },
    } as unknown as FeatureState;

    const result = await ensureWorktree(featureState, ctx);
    expect(selectMock).not.toHaveBeenCalled();
    expect(result.git.worktreePath).toBeDefined();
  });

  test("_resolveBaseBranch prompts for current-branch policy too", async () => {
    createFakePi();
    setTestSettings(null);
    setTestSettings(null);
    const selectMock = vi.fn().mockResolvedValueOnce("main (detected)").mockResolvedValueOnce("This session only");

    const resolveBaseBranch = _resolveBaseBranch;

    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "refs/remotes/origin/main\n" }) // detectBaseBranch
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n" }) // branch --list main (found)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list develop
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }); // branch -r --list origin/develop

    const ctx = {
      actions: { exec: mockExec },
      hasUI: true,
      ui: { select: selectMock },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", null);

    const result = await resolveBaseBranch(ctx);
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(result).toBe("main");
  });

  test("_resolveBaseBranch throws UserCancelledError when user cancels branch selection", async () => {
    createFakePi();
    setTestSettings(null);
    setTestSettings(null);
    const selectMock = vi.fn().mockResolvedValueOnce(undefined);

    const resolveBaseBranch = _resolveBaseBranch;

    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "refs/remotes/origin/main\n" }) // detectBaseBranch
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n" }) // branch --list main
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list develop
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }); // branch -r --list origin/develop

    const ctx = {
      actions: { exec: mockExec },
      hasUI: true,
      ui: { select: selectMock },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", null);

    await expect(resolveBaseBranch(ctx)).rejects.toThrow("Base branch selection cancelled");
  });

  test("_resolveBaseBranch throws UserCancelledError when user cancels custom branch input", async () => {
    createFakePi();
    setTestSettings(null);
    setTestSettings(null);
    const selectMock = vi.fn().mockResolvedValueOnce("Type your own...");
    const inputMock = vi.fn().mockResolvedValueOnce("");

    const resolveBaseBranch = _resolveBaseBranch;

    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "refs/remotes/origin/main\n" }) // detectBaseBranch
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n" }) // branch --list main
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list develop
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }); // branch -r --list origin/develop

    const ctx = {
      actions: { exec: mockExec },
      hasUI: true,
      ui: { select: selectMock, input: inputMock },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", null);

    await expect(resolveBaseBranch(ctx)).rejects.toThrow("Custom branch input cancelled");
  });

  test("_resolveBaseBranch accepts custom branch via 'Type your own...'", async () => {
    createFakePi();
    setTestSettings(null);
    setTestSettings(null);
    const selectMock = vi.fn().mockResolvedValueOnce("Type your own...").mockResolvedValueOnce("This session only");
    const inputMock = vi.fn().mockResolvedValueOnce("trunk");

    const resolveBaseBranch = _resolveBaseBranch;

    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "refs/remotes/origin/main\n" }) // detectBaseBranch
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "  main\n" }) // branch --list main
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/master
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch --list develop
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" }) // branch -r --list origin/develop
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n" }); // rev-parse --verify refs/heads/trunk

    const ctx = {
      actions: { exec: mockExec },
      hasUI: true,
      ui: { select: selectMock, input: inputMock },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", null);

    const result = await resolveBaseBranch(ctx);
    expect(result).toBe("trunk");
    expect(inputMock).toHaveBeenCalledWith("Enter base branch name:", "main");
  });
});

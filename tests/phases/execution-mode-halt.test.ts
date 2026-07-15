// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Focused unit tests for createExecutionModeApplier's worktree-failure halt:
 * when branchPolicy is "worktree" and ensureWorktreeForExecution returns no
 * worktreePath (setup failed), the fy-implement skill must NOT be dispatched.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createExecutionModeApplier } from "../../src/phases/execution-mode.js";
import type { FeatureState } from "../../src/state/feature-state.js";
import { schedulePostTurnDrain } from "../../src/state/post-turn-dispatch.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import { cleanupAfterTest, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

function makeFeatureState(worktreePath: string | null): FeatureState {
  return {
    featureSlug: "test-feature",
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    completedAt: null,
    workflow: { currentPhase: "implement", designDoc: null, planDoc: null },
    git: { branch: null, baseCommitSha: null, worktreePath, baseBranch: null },
    design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
    plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
    implement: { taskReviewRounds: {} },
    verify: { verifyLoopCount: 0 },
    review: { reviewLoopCount: 0, reviewHistory: [] },
  } as unknown as FeatureState;
}

function makePi(): { pi: ExtensionAPI; sendUserMessage: ReturnType<typeof vi.fn> } {
  const sendUserMessage = vi.fn();
  const pi = { sendUserMessage, appendEntry: vi.fn() } as unknown as ExtensionAPI;
  return { pi, sendUserMessage };
}

function makeHandler(worktreePath: string | null) {
  return {
    getWorkflowState: () => ({ currentPhase: "plan" }),
    setCurrentPhase: vi.fn(),
    getActiveFeatureSlug: () => "test-feature",
    getActiveFeatureState: () => makeFeatureState(null),
    getFullState: () => ({ featureState: makeFeatureState(worktreePath), guardrailsState: {} }),
  } as unknown as Parameters<typeof createExecutionModeApplier>[0]["handler"];
}

describe("applyExecutionMode worktree-failure halt", () => {
  beforeEach(() => {
    setTestSettings(null);
    // Run in a temp dir: applyExecutionMode's success path calls saveFeatureState(state,
    // DEFAULT_DIR=null, null) → stateFilePath resolves to process.cwd/.pi. Must not touch the real repo.
    withTempCwd();
  });

  afterEach(() => {
    setSetting("branchPolicy", "current-branch");
    vi.restoreAllMocks();
    cleanupAfterTest();
  });

  test("worktree mode + setup failed → does NOT dispatch fy-implement skill", async () => {
    setSetting("branchPolicy", "worktree");

    const { pi, sendUserMessage } = makePi();
    const ensureWorktreeForExecution = vi.fn().mockResolvedValue(makeFeatureState(null));

    const apply = createExecutionModeApplier({
      pi,
      handler: makeHandler(null),
      expandSkillCommand: vi.fn().mockReturnValue("/skill:fy-implement"),
      applyModelOverrideForPhase: vi.fn().mockResolvedValue(undefined),
      resolveBaseBranch: vi.fn().mockResolvedValue("main"),
      ensureWorktreeForExecution,
    });

    await apply({ hasUI: false } as ExtensionContext);

    // Halt: the fy-implement skill was never dispatched.
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(ensureWorktreeForExecution).toHaveBeenCalled();
  });

  test("worktree mode + setup succeeded → dispatches fy-implement skill", async () => {
    setSetting("branchPolicy", "worktree");

    const { pi, sendUserMessage } = makePi();
    const ensureWorktreeForExecution = vi.fn().mockResolvedValue(makeFeatureState(".worktrees/test-feature"));

    const apply = createExecutionModeApplier({
      pi,
      handler: makeHandler(".worktrees/test-feature"),
      expandSkillCommand: vi.fn().mockReturnValue("/skill:fy-implement"),
      applyModelOverrideForPhase: vi.fn().mockResolvedValue(undefined),
      resolveBaseBranch: vi.fn().mockResolvedValue("main"),
      ensureWorktreeForExecution,
    });

    await apply({ hasUI: false } as ExtensionContext);

    // fy-implement is staged for agent_settled delivery — schedule the deferred drain and flush the timer.
    vi.useFakeTimers();
    schedulePostTurnDrain(pi);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  test("current-branch mode + no worktreePath → STILL dispatches fy-implement skill (inverse of the halt guard)", async () => {
    // : locks the `else if (worktreeMode)` guard against regressing to a bare `else`.
    // In current-branch mode a missing worktreePath is expected — dispatch must proceed.
    setSetting("branchPolicy", "current-branch");

    const { pi, sendUserMessage } = makePi();
    const ensureWorktreeForExecution = vi.fn().mockResolvedValue(makeFeatureState(null));

    const apply = createExecutionModeApplier({
      pi,
      handler: makeHandler(null),
      expandSkillCommand: vi.fn().mockReturnValue("/skill:fy-implement"),
      applyModelOverrideForPhase: vi.fn().mockResolvedValue(undefined),
      resolveBaseBranch: vi.fn().mockResolvedValue("main"),
      ensureWorktreeForExecution,
    });

    await apply({ hasUI: false } as ExtensionContext);

    expect(ensureWorktreeForExecution).toHaveBeenCalled();
    // fy-implement is staged for agent_settled delivery — schedule the deferred drain and flush the timer.
    vi.useFakeTimers();
    schedulePostTurnDrain(pi);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { setAutoAgentCallback } from "../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { isPhaseDone, type PhaseProgressionView } from "../../src/phases/phase-progression.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  cleanupAfterTest,
  createFakePi,
  enableSubagentMode,
  fireAllHandlers,
  NO_AUTO_AGENT_CALLBACK,
  settleAndDrainPostTurnFollowUp,
  UAT_ACTIVE_STATE,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

const mockCtx = {
  hasUI: true,
  sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
  ui: { setWidget: () => {}, notify: vi.fn() },
};

/** Derived-status view from a FeatureState. */
function view(state: { workflow: { currentPhase: string | null }; completedAt: string | null }): PhaseProgressionView {
  return {
    currentPhase: state.workflow.currentPhase as PhaseProgressionView["currentPhase"],
    completedAt: state.completedAt,
  };
}

// UAT is no longer a gated accept/reject fork: the user advances out of UAT via
// /fy:next, which routes one step uat-aware and replicates the former /uat-accept
// completion path exactly. The former /uat-accept and /uat-reject commands were
// removed (decision #21). These tests cover the /fy:next UAT advance + completion.

describe("fy:next from UAT (replaces former /uat-accept)", () => {
  beforeEach(() => {
    setTestSettings(null);
    enableSubagentMode();
  });

  afterEach(() => {
    _resetFeatureState();
    cleanupAfterTest();
  });

  test("completes the feature when finish already completed (after-finish mode)", async () => {
    setSetting("uatMode", "after-finish");
    const fake = createFakePi();
    const slug = writeFeatureStateFile("2026-05-16-uat-fynext-done-test", {
      workflow: { ...UAT_ACTIVE_STATE.workflow },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Reconstruct handler state
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    const nextHandler = fake.registeredCommands?.get("fy:next");
    expect(nextHandler).toBeDefined();

    await (nextHandler as (args: string, ctx: unknown) => Promise<void>)?.("", mockCtx);

    const state = loadFeatureState(slug, null);
    expect(
      isPhaseDone(
        view({
          workflow: { currentPhase: state?.workflow.currentPhase ?? null },
          completedAt: state?.completedAt ?? null,
        }),
        "uat",
      ),
    ).toBe(true);
    expect(state?.completedAt).not.toBeNull();
  });

  test("advances to finish when finish is pending (after-review mode)", async () => {
    setSetting("uatMode", "after-review");
    const fake = createFakePi();
    const slug = writeFeatureStateFile("2026-05-16-uat-fynext-finish-test", {
      workflow: { ...UAT_ACTIVE_STATE.workflow },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    const nextHandler = fake.registeredCommands?.get("fy:next");
    await (nextHandler as (args: string, ctx: unknown) => Promise<void>)?.("", mockCtx);

    const state = loadFeatureState(slug, null);
    expect(
      isPhaseDone(
        view({
          workflow: { currentPhase: state?.workflow.currentPhase ?? null },
          completedAt: state?.completedAt ?? null,
        }),
        "uat",
      ),
    ).toBe(true);
    expect(state?.workflow.currentPhase).toBe("finish");
    // fy-finish is staged for agent_end delivery — drain before asserting.
    await fireAllHandlers(fake.handlers, "agent_end", {}, mockCtx);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    // Should send finishing skill
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(fake.sentMessages[0].message).toContain("fy-finish");
  });

  test("calls cleanupWorktreeOnFinish in after-finish mode when worktreePath is set", async () => {
    setSetting("uatMode", "after-finish");
    const fake = createFakePi();
    const slug = writeFeatureStateFile("2026-05-16-uat-fynext-worktree-cleanup", {
      git: { branch: null, baseCommitSha: null, worktreePath: "/tmp/worktree-test", baseBranch: null },
      workflow: { ...UAT_ACTIVE_STATE.workflow },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    const mockExec = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("git rev-parse")) {
        return Promise.resolve({ exitCode: 0, stdout: "/home/user/project/.git\n" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "" });
    });
    const ctxWithExec = { ...mockCtx, actions: { exec: mockExec } };

    const nextHandler = fake.registeredCommands?.get("fy:next");
    await (nextHandler as (args: string, ctx: unknown) => Promise<void>)?.("", ctxWithExec);

    // Should have called git worktree remove
    const calls = (mockExec.mock.calls as unknown[][]).map((c) => c[0] as string).filter(Boolean);
    expect(calls.some((c: string) => c.includes("git worktree remove"))).toBe(true);

    const state = loadFeatureState(slug, null);
    expect(state?.completedAt).not.toBeNull();
  });

  test("notifies auto-agent on feature completion in after-finish mode", async () => {
    setSetting("uatMode", "after-finish");
    const fake = createFakePi();
    const slug = writeFeatureStateFile("2026-05-16-uat-fynext-auto-agent-test", {
      workflow: { ...UAT_ACTIVE_STATE.workflow },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Reconstruct handler state
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    // Set up auto-agent callback mock
    const onFeatureComplete = vi.fn();
    setAutoAgentCallback({
      onFeatureComplete,
      onFeatureError: async () => {},
      isActive: () => true,
    });

    const nextHandler = fake.registeredCommands?.get("fy:next");
    await (nextHandler as (args: string, ctx: unknown) => Promise<void>)?.("", mockCtx);

    // Auto-agent should be notified of feature completion
    expect(onFeatureComplete).toHaveBeenCalledWith(slug);

    // Clean up
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
  });
});

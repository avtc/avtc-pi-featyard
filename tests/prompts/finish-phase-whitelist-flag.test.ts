// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { isFinishPhaseWhitelisted, setFinishPhaseWhitelisted } from "../../src/git/worktrees/worktree-lifecycle.js";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  cleanupAfterTest,
  createFakePi,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  NO_UI_CTX,
} from "../helpers/workflow-monitor-test-helpers.js";

const IS_WHITELISTED = true;
const IS_NOT_WHITELISTED = false;

const NO_UI_MOCK_CTX = {
  hasUI: false,
  sessionManager: { getBranch: () => [] },
  ui: { setWidget: () => {} },
} as unknown as ExtensionContext;

describe("finish-phase guardrail whitelist flag lifecycle", () => {
  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FF_FEATURE;
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
    cleanupAfterTest();
  });

  test("flag armed by agent_start during finish phase (worktree policy)", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // 1. Create a design doc to set up the feature
    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-04-01-flag-clear-design.md" },
      } as unknown as ExtensionEvent,
      NO_UI_MOCK_CTX,
    );

    // 2. Set up the feature state with all phases complete, finish active, worktree path
    const featureState = loadFeatureState("2026-04-01-flag-clear", null);
    if (!featureState) throw new Error("Feature state not found");
    featureState.workflow.currentPhase = "finish";
    featureState.git.worktreePath = ".worktrees/2026-04-01-flag-clear";
    featureState.git.baseBranch = "main";
    saveFeatureState(featureState, null);
    setSetting("branchPolicy", "worktree");

    // 3. Reconstruct state from the file
    enableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_MOCK_CTX);
    disableSubagentMode();

    // session_start clears the flag
    expect(isFinishPhaseWhitelisted()).toBe(false);

    // 4. agent_start fires at the start of a finish turn → re-arms the flag
    await fireAllHandlers(fake.handlers, "agent_start", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(true);

    // 5. agent_end fires at turn end → clears the flag (per-turn clear)
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  test("flag cleared on performWorkflowReset", async () => {
    enableSubagentMode();
    setFinishPhaseWhitelisted(IS_WHITELISTED);

    const { api } = createFakePi();
    setTestSettings(null);
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    // Trigger workflow reset via the exposed globalThis function
    const resetFn = globalThis.__piWorkflowMonitor?.performWorkflowReset;
    expect(resetFn).toBeDefined();
    (resetFn as () => void)();

    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  test("flag cleared on session_start", async () => {
    enableSubagentMode();
    setFinishPhaseWhitelisted(IS_WHITELISTED);

    const { handlers, api } = createFakePi();
    setTestSettings(null);
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    await fireAllHandlers(handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  test("flag cleared on agent_end", async () => {
    enableSubagentMode();
    setFinishPhaseWhitelisted(IS_WHITELISTED);

    const { handlers, api } = createFakePi();
    setTestSettings(null);
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    const onAgentEnd = getSingleHandler(handlers, "agent_end");
    await onAgentEnd({} as unknown as ExtensionEvent, NO_UI_CTX);

    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  test("flag NOT armed by agent_start outside finish phase (e.g. UAT)", async () => {
    setSetting("uatMode", "after-finish");
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // 1. Create a design doc to set up the feature
    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-04-01-uat-ffnext-design.md" },
      } as unknown as ExtensionEvent,
      NO_UI_MOCK_CTX,
    );

    // 2. Set up the feature state: all phases complete including finish, uat active
    const featureState = loadFeatureState("2026-04-01-uat-ffnext", null);
    if (!featureState) throw new Error("Feature state not found");
    featureState.workflow.currentPhase = "uat";
    featureState.git.worktreePath = ".worktrees/2026-04-01-uat-ffnext";
    saveFeatureState(featureState, null);
    setSetting("branchPolicy", "worktree");

    // 3. Reconstruct state from the file
    enableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_MOCK_CTX);
    disableSubagentMode();

    // Even if the flag were somehow left true, agent_start during UAT must NOT re-arm it
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    await fireAllHandlers(fake.handlers, "agent_start", {}, NO_UI_MOCK_CTX);
    // agent_start did not re-arm (phase is uat, not finish) — flag retains whatever it was;
    // the agent_end clear then brings it down. Fire agent_end to confirm the per-turn clear.
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(false);
  });
});

describe("agent_start re-arm gating (variant C)", () => {
  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FF_FEATURE;
    disableSubagentMode();
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
    cleanupAfterTest();
  });

  /** Shared setup: a feature in the finish phase with worktree state, reconstructed
   *  via session_start so the workflow phase-progression is populated. */
  async function setupFinishWorktreeFeature(
    fake: ReturnType<typeof createPiWithToolCapture>["fake"],
    opts: { worktreePath?: string | null; branchPolicy?: string; phase?: string } = {},
  ): Promise<void> {
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-04-01-gating-design.md" },
      } as unknown as ExtensionEvent,
      NO_UI_MOCK_CTX,
    );
    const featureState = loadFeatureState("2026-04-01-gating", null);
    if (!featureState) throw new Error("Feature state not found");
    featureState.workflow.currentPhase = (opts.phase as "finish") ?? "finish";
    featureState.git.worktreePath =
      "worktreePath" in opts ? (opts.worktreePath ?? null) : ".worktrees/2026-04-01-gating";
    featureState.git.baseBranch = "main";
    saveFeatureState(featureState, null);
    // session_start reconstruction: subagent mode bypasses the interactive
    // "continue/reset" prompt that a non-subagent session_start would raise.
    enableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_MOCK_CTX);
    disableSubagentMode();
    // Apply branch policy AFTER session_start so it is authoritative at agent_start
    // time (isolate:false shares module state across tests; session_start may reload
    // settings from the env, so set it last).
    setSetting("branchPolicy", (opts.branchPolicy ?? "worktree") as "worktree");
  }

  test("agent_start does NOT arm for current-branch policy", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);
    await setupFinishWorktreeFeature(fake, { branchPolicy: "current-branch" });

    await fireAllHandlers(fake.handlers, "agent_start", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  test("agent_start does NOT arm when worktreePath is missing", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);
    await setupFinishWorktreeFeature(fake, { worktreePath: null });

    await fireAllHandlers(fake.handlers, "agent_start", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  test("agent_start does NOT arm when phase is implement (not finish)", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);
    await setupFinishWorktreeFeature(fake, { phase: "implement" });

    await fireAllHandlers(fake.handlers, "agent_start", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  test("agent_start does NOT arm in a subagent session", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);
    await setupFinishWorktreeFeature(fake);

    enableSubagentMode();
    await fireAllHandlers(fake.handlers, "agent_start", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  test("agent_start arms for finish + worktree policy + worktreePath", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);
    await setupFinishWorktreeFeature(fake);

    await fireAllHandlers(fake.handlers, "agent_start", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(true);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isFinishPhaseWhitelisted, setFinishPhaseWhitelisted } from "../../src/git/worktrees/worktree-lifecycle.js";
import workflowMonitorExtension, {
  expandSkillCommand as _expandSkillCommand,
  _resetFeatureState,
} from "../../src/index.js";
import { setAutoAgentCallback } from "../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { initGitDir } from "../helpers/git-template.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  IS_NOT_WHITELISTED,
  NO_AUTO_AGENT_CALLBACK,
  withTempCwd,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

const NO_UI_MOCK_CTX = {
  hasUI: false,
  sessionManager: { getBranch: () => [] },
  ui: { setWidget: () => {} },
} as unknown as ExtensionContext;

/** The whitelist check function from parallel-work-guardrail-integration.ts */
function whitelistCheck(categoryId: string): boolean {
  return (
    globalThis.__piWorkflowMonitor?.finishPhaseWhitelisted === true &&
    (categoryId === "branch-switch" || categoryId === "merge")
  );
}

/**
 * Integration test: finish lifecycle
 *
 * Exercises featyard's own code:
 * 1. Finish skill injection produces worktree finish content (worktree policy)
 * 2. The agent_start handler arms the whitelist flag during the finish phase
 * 3. Whitelist check function allows branch-switch + merge when flag is true
 * 4. Whitelist check function blocks non-whitelisted categories (push, reset)
 * 5. The agent_end handler clears the flag at turn end
 *
 * Guardrail's command→category mapping is tested in pi-parallel-work-guardrail.
 */
describe("finish lifecycle integration", () => {
  beforeEach(async () => {
    withTempCwd();
    initGitDir(process.cwd());
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
  });

  test("worktree auto-agent: injection produces content → agent_start arms flag → agent_end clears flag", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // 1. Create a design doc to set up the feature
    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/featyard/designs/2026-04-01-lifecycle-design.md" },
      } as unknown as ExtensionEvent,
      NO_UI_MOCK_CTX,
    );

    // 2. Set up the feature with all phases complete, finish active, worktreePath set
    const featureState = loadFeatureState("2026-04-01-lifecycle", null);
    if (!featureState) throw new Error("Feature state not found");
    featureState.workflow.currentPhase = "finish";
    featureState.git.worktreePath = ".worktrees/2026-04-01-lifecycle";
    featureState.git.baseBranch = "main";
    saveFeatureState(featureState, null);

    // 3. Reconstruct state from the file
    enableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_MOCK_CTX);

    // 4. Set up auto-agent callback to simulate auto-agent mode
    setAutoAgentCallback({ onFeatureComplete: () => {}, onFeatureError: () => {} });

    // 5. Expand the finishing skill — produces content but does NOT arm the flag
    disableSubagentMode();
    const result = _expandSkillCommand("/skill:fy-finish", null, null);

    // Verify injection produced worktree auto-agent content
    expect(result).toContain("branchPolicy: worktree");
    expect(result).toContain("mainRepoPath:");
    // Injection alone does not arm the flag (variant C: agent_start is the arming site)
    expect(isFinishPhaseWhitelisted()).toBe(false);

    // 6. agent_start fires at the start of the finish turn → arms the flag
    await fireAllHandlers(fake.handlers, "agent_start", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(true);

    // 7. Verify whitelist check function behaves correctly while armed
    expect(whitelistCheck("branch-switch")).toBe(true);
    expect(whitelistCheck("merge")).toBe(true);
    expect(whitelistCheck("push")).toBe(false);
    expect(whitelistCheck("reset-hard")).toBe(false);
    expect(whitelistCheck("stash")).toBe(false);
    expect(whitelistCheck("rebase")).toBe(false);

    // 8. agent_end fires at turn end → clears the flag
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_MOCK_CTX);
    expect(isFinishPhaseWhitelisted()).toBe(false);

    // 9. After agent_end, whitelist check should block everything
    expect(whitelistCheck("branch-switch")).toBe(false);
    expect(whitelistCheck("merge")).toBe(false);
  });

  test("worktree interactive: injection produces worktree finish content for Option 1", async () => {
    const { api } = createFakePi();
    setTestSettings(null);
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    // Set up feature with worktreePath but NO auto-agent callback (interactive mode)
    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    const slug = writeFeatureStateFile("lifecycle-interactive", {
      git: { branch: null, baseCommitSha: null, worktreePath: ".worktrees/lifecycle-interactive", baseBranch: "main" },
    });

    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    // Expand finishing skill — produces Option 1 content but does NOT arm the flag
    // (variant C: the agent_start handler is the sole arming site)
    const result = _expandSkillCommand("/skill:fy-finish", null, null);

    expect(result).toContain("branchPolicy: worktree");
    expect(result).toContain("Option 1");
    expect(isFinishPhaseWhitelisted()).toBe(false);

    // Cleanup
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
  });

  test("current-branch auto-agent: injection does NOT set whitelist flag", async () => {
    const { api } = createFakePi();
    setTestSettings(null);
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", "main");

    // Set up auto-agent callback
    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    // Create feature state and set active slug
    const slug = writeFeatureStateFile("lifecycle-current-branch");
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    // Expand finishing skill
    const result = _expandSkillCommand("/skill:fy-finish", null, null);

    expect(result).toContain("branchPolicy: current-branch");

    // Flag should NOT be set for current-branch
    expect(isFinishPhaseWhitelisted()).toBe(false);
  });
});

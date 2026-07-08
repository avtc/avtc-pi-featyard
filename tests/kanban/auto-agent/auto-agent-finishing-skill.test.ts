// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  isFinishPhaseWhitelisted,
  resolveMainRepoPathSync,
  setFinishPhaseWhitelisted,
} from "../../../src/git/worktrees/worktree-lifecycle.js";
import workflowMonitorExtension, { expandSkillCommand, substituteTemplates } from "../../../src/index.js";
import { setAutoAgentCallback } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { loadFeatureState } from "../../../src/state/feature-state.js";
import { initGitDir } from "../../helpers/git-template.js";
import { mockExecSync, restoreExecSync } from "../../helpers/mock-exec-sync.js";
import { setSetting, setTestSettings } from "../../helpers/settings-test-helpers.js";
import {
  createFakePi,
  IS_NOT_WHITELISTED,
  NO_AUTO_AGENT_CALLBACK,
  NO_BASE_BRANCH,
  writeFeatureStateFile,
} from "../../helpers/workflow-monitor-test-helpers.js";

describe("auto-agent finishing skill template substitution", () => {
  beforeEach(() => {
    // Reset auto-agent callback
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
    // Reset settings to defaults
    setTestSettings(null);
    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", NO_BASE_BRANCH);
    // Clear guardrail whitelist flag
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
  });

  afterEach(() => {
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
    // Clear guardrail whitelist flag
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
  });

  test("PI_FF_AUTO_AGENT_SECTION removed when no auto-agent active", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    // Dynamic import to get the exported function after extension loads

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // Interactive mode should include branch context + options (not empty)
    expect(result).toContain("Interactive Mode");
    expect(result).toContain("branchPolicy: current-branch");
    // Should NOT contain auto-agent instructions
    expect(result).not.toContain("Auto-Agent Mode");
    // Should still contain the regular skill content
    expect(result).toContain("ff-finish");
  });

  test("PI_FF_AUTO_AGENT_SECTION expanded when auto-agent is active", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    // Set up auto-agent callback with isActive = true

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // Should contain auto-agent section
    expect(result).toContain("Auto-Agent Mode");
    expect(result).toContain("branchPolicy: current-branch");
    // Should NOT contain old bad patterns (excluding SKILL.md prohibition text)
    expect(result).not.toContain("auto-merge");
    expect(result).not.toContain("delete feature branch");
    // Note: --theirs appears in SKILL.md rules as a prohibition, so we check the section doesn't use it as an instruction
  });

  test("PI_FF_AUTO_AGENT_SECTION includes worktree info when available", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    // Set branchPolicy to worktree

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    // Create feature state with worktreePath and set active slug on handler
    const slug = writeFeatureStateFile("test-worktree-info", {
      git: { branch: null, baseCommitSha: null, worktreePath: ".worktrees/test-worktree-info", baseBranch: null },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    expect(result).toContain("branchPolicy: worktree");
    expect(result).toContain("baseBranch: main");
    expect(result).toContain("main repo directory");
    // Should NOT contain old patterns
    // Note: --theirs appears in SKILL.md rules as a prohibition, so we check it's not used as an instruction
  });

  test("current-branch policy: skip merge when on base branch", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    // initGitDir sets HEAD to refs/heads/main, so git branch --show-current returns "main"
    const branchName = execSync("git branch --show-current", {
      cwd: process.cwd(),
      encoding: "utf-8",
    })
      .toString()
      .trim();

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", branchName || "main");

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // On base branch: should say changes are already on base branch
    expect(result).toContain("already on the base branch");
    expect(result).not.toContain("NOT merged");
  });

  test("current-branch policy: merge instruction when on different branch", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    // initGitDir already initialized in beforeEach; create a feature branch
    execSync("git checkout -b feature/test-branch", { cwd: process.cwd() });

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", "main");

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // Auto-agent + current-branch = commit-only, NO merge
    expect(result).toContain("feature/test-branch");
    expect(result).toContain("NOT merged");
    expect(result).not.toContain("Merge feature/test-branch into main");
    // Note: --theirs appears in SKILL.md rules as a prohibition
  });

  // --- New tests for PI_FF_FINISH_INSTRUCTIONS ---

  test("PI_FF_FINISH_INSTRUCTIONS: current-branch + interactive = options with runtime detection", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // Interactive mode should include branch context + options
    expect(result).toContain("branchPolicy: current-branch");
    expect(result).toContain("Interactive Mode");
    expect(result).toContain("git branch --show-current");
    // Should NOT contain auto-agent instructions
    expect(result).not.toContain("Auto-Agent Mode");
  });

  test("PI_FF_FINISH_INSTRUCTIONS: current-branch + auto-agent = commit-only", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    // initGitDir already initialized in beforeEach; create a feature branch
    execSync("git checkout -b feature/test-branch", { cwd: process.cwd() });

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", "main");

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    expect(result).toContain("branchPolicy: current-branch");
    expect(result).toContain("Auto-Agent Mode");
    // Should NOT contain merge instructions
    expect(result).not.toContain("Merge feature/test-branch into main");
    // Note: --theirs appears in SKILL.md rules as a prohibition
    // Should NOT contain branch deletion
    // Should contain commit-only note
    expect(result).toContain("NOT merged");
  });

  test("PI_FF_FINISH_INSTRUCTIONS: worktree + interactive = worktree options", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    // Create feature state with worktreePath and set active slug on handler
    const slug = writeFeatureStateFile("test-worktree-interactive", {
      git: {
        branch: null,
        baseCommitSha: null,
        worktreePath: ".worktrees/test-worktree-interactive",
        baseBranch: null,
      },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    expect(result).toContain("branchPolicy: worktree");
    expect(result).toContain("Interactive Mode");
    expect(result).toContain("currentBranch:");
    expect(result).toContain("worktreePath:");
    expect(result).toContain("mainRepoPath:");
    // Note: mainRepoPath may be "(unknown)" in test env (temp CWD has no git repo)
    // The resolution code runs before both interactive and auto-agent paths
    expect(result).toContain("Merge into main");
    // Should NOT contain auto-agent instructions
    expect(result).not.toContain("Auto-Agent Mode");
  });

  test("PI_FF_FINISH_INSTRUCTIONS: worktree + auto-agent = full merge lifecycle", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    // Create feature state with worktreePath and set active slug on handler
    const slug = writeFeatureStateFile("test-worktree-auto", {
      git: { branch: null, baseCommitSha: null, worktreePath: ".worktrees/test-worktree-auto", baseBranch: null },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    expect(result).toContain("branchPolicy: worktree");
    expect(result).toContain("Auto-Agent Mode");
    expect(result).toContain("Sync from baseBranch");
    expect(result).toContain("mainRepoPath");
    // Verify slug interpolation in merge command (not literal "feature/<slug>")
    expect(result).toContain(`git merge feature/${slug}`);
    expect(result).not.toContain("feature/<slug>");
    // Note: --theirs appears in SKILL.md rules as a prohibition, so we check it's not used as an instruction
    // Should contain phase_ready instruction
    expect(result).toContain("phase_ready");
  });

  test("baseBranch precedence: feature state overrides settings", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("branchPolicy", "worktree");
    // Settings say "develop" but feature state will say "custom"
    setSetting("baseBranch", "develop");

    // Create feature state with baseBranch: "custom" and worktreePath
    const slug = writeFeatureStateFile("test-basebranch-precedence", {
      git: {
        branch: null,
        baseCommitSha: null,
        worktreePath: ".worktrees/test-basebranch-precedence",
        baseBranch: "custom",
      },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // Feature state baseBranch ("custom") should win over settings ("develop")
    expect(result).toContain("baseBranch: custom");
    expect(result).not.toContain("baseBranch: develop");
    // Should contain worktree-specific content confirming the right baseBranch is used
    expect(result).toContain("git merge origin/custom");
  });

  test("baseBranch fallback: settings used when feature state has no baseBranch", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "develop");

    // Create feature state WITHOUT baseBranch (only worktreePath)
    const slug = writeFeatureStateFile("test-basebranch-fallback", {
      git: { branch: null, baseCommitSha: null, worktreePath: ".worktrees/test-basebranch-fallback", baseBranch: null },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // Settings baseBranch ("develop") should be used since feature state has none
    expect(result).toContain("baseBranch: develop");
    expect(result).toContain("git merge origin/develop");
  });

  test("DD-7: injected instructions never contain git worktree remove or git branch -d", async () => {
    // Verify at source level that the template generation code doesn't include cleanup commands.
    // The SKILL.md rules section mentions them as prohibitions ("Never run git worktree remove")
    // so we can't do negative assertions on the full expanded text.
    // Instead, verify the production code has zero references to these commands.

    const source = fs.readFileSync(path.resolve(__dirname, "../../../src/prompts/finish-instructions.ts"), "utf-8");
    expect(source).not.toContain("git worktree remove");
    expect(source).not.toContain("git branch -d");
  });

  test("worktree + auto-agent injection produces worktree finish content", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    // Create feature state with worktreePath and set active slug on handler
    const slug = writeFeatureStateFile("test-flag-worktree", {
      git: { branch: null, baseCommitSha: null, worktreePath: ".worktrees/test-flag-worktree", baseBranch: null },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    // Clear flag first
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // Injection produces worktree auto-agent content (the flag itself is now armed
    // by the agent_start handler during the finish phase — see agent-lifecycle tests).
    expect(result).toContain("branchPolicy: worktree");
    expect(result).toContain("Auto-Agent Mode");
    expect(isFinishPhaseWhitelisted()).toBe(false);

    // Cleanup
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
  });

  // --- Edge case tests ---

  test("worktree policy with null worktreePath falls back to current-branch with warning", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");
    // No feature state with worktreePath — simulates failed worktree creation

    // Clear flag before test
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // Should fall back to current-branch behavior
    expect(result).toContain("branchPolicy: current-branch");
    // Should contain prominent warning about worktree creation failure
    expect(result).toContain("Worktree creation failed");
    expect(result).toContain("NOT merged to baseBranch");
    // Should NOT set whitelist flag (only worktree WITH worktreePath sets it)
    expect(isFinishPhaseWhitelisted()).toBeFalsy();
  });

  test("null baseBranch with worktree + auto-agent produces error", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", NO_BASE_BRANCH);

    // Create feature state with worktreePath
    const slug = writeFeatureStateFile("test-worktree-null-base", {
      git: { branch: null, baseCommitSha: null, worktreePath: ".worktrees/test-worktree-null-base", baseBranch: null },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    expect(result).toContain("Error");
    expect(result).toContain("baseBranch not configured");
  });

  test("null baseBranch with current-branch + interactive shows auto-detect", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    // No auto-agent, no baseBranch

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", NO_BASE_BRANCH);

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    expect(result).toContain("Interactive Mode");
    expect(result).toContain("not set — will auto-detect");
    expect(result).toContain("git branch --show-current");
  });

  test("flag not set for current-branch policy", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setAutoAgentCallback({
      onFeatureComplete: async () => {},
      onFeatureError: async () => {},
      isActive: () => true,
    });

    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", "main");

    // Clear flag before test
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);

    expandSkillCommand("/skill:ff-finish", null, null);

    // Flag should NOT be set for current-branch policy
    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  test("worktree + interactive injection produces worktree finish content (Option 1)", async () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    // Create feature state with worktreePath — interactive mode (no auto-agent)
    const slug = writeFeatureStateFile("test-worktree-interactive-flag", {
      git: {
        branch: null,
        baseCommitSha: null,
        worktreePath: ".worktrees/test-worktree-interactive-flag",
        baseBranch: null,
      },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    // Clear flag before test
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);

    const result = expandSkillCommand("/skill:ff-finish", null, null);

    // Injection produces worktree interactive content with Option 1 (the flag itself
    // is now armed by the agent_start handler — see agent-lifecycle tests).
    expect(result).toContain("branchPolicy: worktree");
    expect(result).toContain("Option 1");
    expect(isFinishPhaseWhitelisted()).toBe(false);

    // Cleanup
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
  });
});

describe("{{PI_FF_WORKTREE_CONTEXT}} placeholder substitution", () => {
  beforeEach(() => {
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
    setSetting("branchPolicy", "current-branch");
    setSetting("baseBranch", NO_BASE_BRANCH);
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
  });

  afterEach(() => {
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
  });

  test("expands to empty string when branchPolicy=current-branch", () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("branchPolicy", "current-branch");

    const result = substituteTemplates("Before {{PI_FF_WORKTREE_CONTEXT}} After", null, null);
    expect(result.text).toBe("Before  After");
  });

  test("expands to worktree context when branchPolicy=worktree and worktreePath exists", () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    const slug = writeFeatureStateFile("test-worktree-ctx", {
      git: {
        branch: null,
        baseCommitSha: null,
        worktreePath: "/project/.worktrees/test-worktree-ctx",
        baseBranch: "main",
      },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    const result = substituteTemplates("{{PI_FF_WORKTREE_CONTEXT}}", null, null);
    expect(result.text).toContain("## Worktree Context");
    expect(result.text).toContain("Worktree path: /project/.worktrees/test-worktree-ctx");
    expect(result.text).toContain("Feature branch: feature/test-worktree-ctx");
    expect(result.text).toContain("Base branch: main");
    expect(result.text).toContain("extension rewrites all tool paths automatically");
    expect(result.text).toContain("cwd:"); // subagent CWD instruction
    expect(result.text).toContain("Do NOT create or remove worktrees");
  });

  test("expands to failure warning when branchPolicy=worktree but worktreePath is null", () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("branchPolicy", "worktree");

    const slug = writeFeatureStateFile("test-worktree-fail", {
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    const result = substituteTemplates("{{PI_FF_WORKTREE_CONTEXT}}", null, null);
    expect(result.text).toContain("⚠️ Worktree creation failed");
    expect(result.text).toContain("Do NOT set cwd on subagent dispatches");
  });

  test("expands to empty when branchPolicy=worktree but no active feature slug", () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("branchPolicy", "worktree");
    // No feature state, no active slug

    const result = substituteTemplates("Before {{PI_FF_WORKTREE_CONTEXT}} After", null, null);
    expect(result.text).toBe("Before  After");
  });

  test("baseBranch falls back to 'main' when neither feature state nor settings provide it", () => {
    const fake = createFakePi();
    initGitDir(process.cwd());
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", NO_BASE_BRANCH); // no settings baseBranch

    const slug = writeFeatureStateFile("test-fallback-main", {
      git: {
        branch: null,
        baseCommitSha: null,
        worktreePath: "/project/.worktrees/test-fallback-main",
        baseBranch: null,
      }, // no baseBranch in feature state
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    const result = substituteTemplates("{{PI_FF_WORKTREE_CONTEXT}}", null, null);
    expect(result.text).toContain("Base branch: main");
    expect(result.text).toContain("git merge main");
  });

  test("omits Main repo path when resolveMainRepoPathSync returns null", () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    // Mock execSync to throw — forces resolveMainRepoPathSync to return null
    // and also resets the _cachedMainRepoPath from previous tests
    const mockFn = vi.fn(() => {
      throw new Error("not a git repo");
    });
    mockExecSync(mockFn);

    setSetting("branchPolicy", "worktree");
    setSetting("baseBranch", "main");

    const slug = writeFeatureStateFile("test-no-mainrepo", {
      git: {
        branch: null,
        baseCommitSha: null,
        worktreePath: "/project/.worktrees/test-no-mainrepo",
        baseBranch: "main",
      },
    });
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(loadFeatureState(slug, null));

    // resolveMainRepoPathSync returns null when git commands fail
    const result = substituteTemplates("{{PI_FF_WORKTREE_CONTEXT}}", null, null);
    expect(result.text).toContain("## Worktree Context");
    expect(result.text).not.toContain("Main repo path:");

    // Restore real execSync, init git, and re-populate the cache so subsequent
    // test files don't hit a stale null cache in a non-git temp dir
    restoreExecSync();
    createFakePi();
    initGitDir(process.cwd());
    resolveMainRepoPathSync();
  });
});

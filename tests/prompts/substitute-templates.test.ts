// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, test } from "vitest";
import { _resetFeatureState, substituteTemplates } from "../../src/index.js";
import { initGitDir } from "../helpers/git-template.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import { makeFeatureState, resetSettingsToDefaults, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Tests for substituteTemplates via the barrel export wrapper.
 *
 * The barrel export wraps skill-expansion.substituteTemplates with module-level
 * refs (handler, emptyLoops, autoAgentCallback). The wrapper signature is:
 *   substituteTemplates(text: string, featureStateOverride?: FeatureState)
 *
 * Tests call the 2-arg wrapper directly. Handler-dependent behavior
 * (worktree context, finish instructions with auto-agent) is NOT tested
 * here — it requires a fully wired FeatureSession and auto-agent callback.
 */

describe("substituteTemplates", () => {
  beforeEach(() => {
    setTestSettings(null);
    withTempCwd();
    initGitDir(process.cwd());
    _resetFeatureState();
    resetSettingsToDefaults();
  });

  describe("PI_FY_IMPLEMENT_MODE", () => {
    test("replaces with the implementer guidance when no execution mode (current-session)", () => {
      const result = substituteTemplates("{{PI_FY_IMPLEMENT_MODE}}", null, null);
      // current-session emits the full implementer guidance (IMPLEMENTER_GUIDANCE)
      expect(result.text).toContain("## Cycle");
      expect(result.text).toContain("## Blockers");
      expect(result.text).not.toContain("{{PI_FY_IMPLEMENT_MODE}}");
      expect(result.text).not.toContain("orchestrator");
    });

    test("replaces with subagent orchestrator + escalation instructions when executionMode is subagent", () => {
      setSetting("implementMode", "subagent-driven");
      const featureState = makeFeatureState("test-slug", {});
      const result = substituteTemplates("{{PI_FY_IMPLEMENT_MODE}}", featureState, null);
      expect(result.text).toContain("orchestrator");
      expect(result.text).toContain("Escalate to the user");
      expect(result.text).not.toContain("{{PI_FY_IMPLEMENT_MODE}}");
      // subagent mode does NOT emit the implementer guidance (the subagent carries it)
      expect(result.text).not.toContain("## Cycle");
    });

    test("replaces with the implementer guidance when executionMode is checkpoint", () => {
      setSetting("implementMode", "current-session");
      const featureState = makeFeatureState("test-slug", {});
      const result = substituteTemplates("{{PI_FY_IMPLEMENT_MODE}}", featureState, null);
      expect(result.text).toContain("## Cycle");
      expect(result.text).not.toContain("orchestrator");
    });
  });

  describe("PI_FY_WORTH_NOTES", () => {
    test("subagent mode: emits the collect-and-append instruction with the resolved path", () => {
      setSetting("implementMode", "subagent-driven");
      const featureState = makeFeatureState("test-slug", {});
      const result = substituteTemplates("{{PI_FY_WORTH_NOTES}}", featureState, null);
      expect(result.text).not.toContain("{{PI_FY_WORTH_NOTES}}");
      expect(result.text).toContain("Collect worth-notes");
      // nested {{PI_FY_WORTH_NOTES_PATH}} is resolved by the chained generic pass
      expect(result.text).toContain("test-slug/test-slug-worth-notes.md");
      expect(result.text).not.toContain("{{PI_FY_WORTH_NOTES_PATH}}");
    });

    test("direct mode: emits the append-your-own instruction", () => {
      setSetting("implementMode", "current-session");
      const featureState = makeFeatureState("test-slug", {});
      const result = substituteTemplates("{{PI_FY_WORTH_NOTES}}", featureState, null);
      expect(result.text).not.toContain("{{PI_FY_WORTH_NOTES}}");
      expect(result.text).toContain("append it to");
      // direct instruction must NOT carry the subagent collect wording
      expect(result.text).not.toContain("Collect worth-notes");
      expect(result.text).toContain("test-slug/test-slug-worth-notes.md");
    });
  });
  describe("PI_FY_WORKTREE_CONTEXT", () => {
    test("replaces with empty string when default current-branch policy", () => {
      const result = substituteTemplates("{{PI_FY_WORKTREE_CONTEXT}}", null, null);
      // Default settings use current-branch policy — no worktree context
      expect(result.text).toBe("");
    });
  });

  describe("PI_FY_FINISH_INSTRUCTIONS", () => {
    test("replaces with current-branch interactive section by default", () => {
      const result = substituteTemplates("{{PI_FY_FINISH_INSTRUCTIONS}}", null, null);
      expect(result.text).not.toContain("{{PI_FY_FINISH_INSTRUCTIONS}}");
      expect(result.text.length).toBeGreaterThan(0);
    });

    test("substitutes finish instructions for current-branch policy", () => {
      const result = substituteTemplates("{{PI_FY_FINISH_INSTRUCTIONS}}", null, null);
      expect(result.text).toContain("branchPolicy: current-branch");
    });
  });

  describe("multiple placeholders", () => {
    test("replaces all placeholders in a single pass", () => {
      const featureState = makeFeatureState("test-slug", { executionMode: "checkpoint" } as Partial<
        import("../../src/state/feature-state.js").FeatureState
      >);
      const text = "Mode: {{PI_FY_IMPLEMENT_MODE}}\nNotes: {{PI_FY_WORTH_NOTES}}\nEnd";
      const result = substituteTemplates(text, featureState, null);
      expect(result.text).not.toContain("{{PI_FY_IMPLEMENT_MODE}}");
      expect(result.text).not.toContain("{{PI_FY_WORTH_NOTES}}");
      expect(result.text).toContain("Mode: ");
      expect(result.text).toContain("Notes: ");
      expect(result.text).toContain("End");
    });
  });

  describe("no placeholders", () => {
    test("returns original text unchanged", () => {
      const text = "Hello world, no placeholders here.";
      const result = substituteTemplates(text, null, null);
      expect(result.text).toBe(text);
    });

    test("returns empty string for empty input", () => {
      const result = substituteTemplates("", null, null);
      expect(result.text).toBe("");
    });
  });

  describe("generic placeholder substitution", () => {
    test("replaces PI_FY_FEATURE_SLUG placeholder", () => {
      const text = "Review passes: {{PI_FY_FEATURE_SLUG}}";
      const result = substituteTemplates(text, null, null);
      // After generic substitution, placeholder should be resolved
      expect(result.text).not.toContain("{{PI_FY_FEATURE_SLUG}}");
    });
  });

  describe("{{PI_FY_BASE_COMMIT_SHA}}", () => {
    test("resolves baseCommitSha from featureStateOverride", () => {
      const featureState = makeFeatureState("test-slug", {
        git: { branch: null, baseCommitSha: "abc123def456", worktreePath: null, baseBranch: null },
      });
      const result = substituteTemplates("Base: {{PI_FY_BASE_COMMIT_SHA}}", featureState, null);
      expect(result.text).toBe("Base: abc123def456");
    });

    test("resolves to (not available) when featureState has no baseCommitSha", () => {
      const featureState = makeFeatureState("test-slug", {
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
      });
      const result = substituteTemplates("Base: {{PI_FY_BASE_COMMIT_SHA}}", featureState, null);
      expect(result.text).toBe("Base: (not available)");
    });

    test("resolves to (not available) when baseCommitSha is undefined", () => {
      const featureState = makeFeatureState("test-slug", {
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
      });
      const result = substituteTemplates("Base: {{PI_FY_BASE_COMMIT_SHA}}", featureState, null);
      expect(result.text).toBe("Base: (not available)");
    });

    test("resolves to (not available) when no featureStateOverride", () => {
      const result = substituteTemplates("Base: {{PI_FY_BASE_COMMIT_SHA}}", null, null);
      expect(result.text).toBe("Base: (not available)");
    });
  });
});

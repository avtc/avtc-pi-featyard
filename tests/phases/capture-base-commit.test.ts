// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultGitRunner, setGitRunner } from "../../src/git/git-queries.js";
import type { PiWorkflowMonitorBridge } from "../../src/shared/types.js";
import { captureBaseCommitSha, resumeWorkflowForFeature } from "../../src/state/feature-management.js";
import { createFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import { withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

/** Runner that answers git-queries' (args, cwd) calls with canned values. */
function fakeRunner(revParseHead: string, abbrevRef: string) {
  return vi.fn((args: string[]) => {
    const cmd = args.join(" ");
    if (cmd === "rev-parse HEAD") return `${revParseHead}\n`;
    if (cmd === "symbolic-ref --short HEAD") return `${abbrevRef}\n`;
    if (cmd === "rev-parse --short HEAD") return `${revParseHead.slice(0, 7)}\n`;
    throw new Error(`unexpected git call: ${cmd}`);
  }) as unknown as import("../../src/git/git-queries.js").GitRunner;
}

/** No context (resume without UI context) */
const NO_CTX: unknown = null;

/** No model override function */
const NO_MODEL_OVERRIDE_FN: unknown = null;

describe("captureBaseCommitSha", () => {
  beforeEach(() => {
    setTestSettings(null);
    withTempCwd();
    setGitRunner(fakeRunner("abc123def456789012345678901234567890abcd", "feature/test"));
    setSetting("branchPolicy", "current-branch");
  });

  afterEach(() => {
    setGitRunner(defaultGitRunner);
  });

  test("sets baseCommitSha to current HEAD", () => {
    const state = createFeatureState("2026-06-06-test", "docs/ff/designs/2026-06-06-test-design.md");
    captureBaseCommitSha(state);
    expect(state.git.baseCommitSha).toBe("abc123def456789012345678901234567890abcd");
  });

  test("does not overwrite existing baseCommitSha", () => {
    const state = createFeatureState("2026-06-06-test", "docs/ff/designs/2026-06-06-test-design.md");
    state.git.baseCommitSha = "existing-sha";
    captureBaseCommitSha(state);
    expect(state.git.baseCommitSha).toBe("existing-sha");
  });

  test("sets branch from getCurrentGitRef for current-branch policy", () => {
    const state = createFeatureState("2026-06-06-test", "docs/ff/designs/2026-06-06-test-design.md");
    captureBaseCommitSha(state);
    expect(state.git.branch).toBe("feature/test");
  });

  test("sets branch to feature/{slug} for worktree policy", () => {
    setSetting("branchPolicy", "worktree");
    const state = createFeatureState("2026-06-06-test", "docs/ff/designs/2026-06-06-test-design.md");
    captureBaseCommitSha(state);
    expect(state.git.branch).toBe("feature/2026-06-06-test");
  });

  test("leaves baseCommitSha null when git fails", () => {
    setGitRunner(() => {
      throw new Error("not a git repo");
    });
    const state = createFeatureState("2026-06-06-test", "docs/ff/designs/2026-06-06-test-design.md");
    captureBaseCommitSha(state);
    expect(state.git.baseCommitSha).toBeNull();
    expect(state.git.branch).toBeNull(); // getBranchOrShortSha also fails, returns null
  });

  test("preserves existing branch when already set", () => {
    const state = createFeatureState("2026-06-06-test", "docs/ff/designs/2026-06-06-test-design.md");
    state.git.branch = "existing-branch";
    captureBaseCommitSha(state);
    expect(state.git.baseCommitSha).toBe("abc123def456789012345678901234567890abcd");
    expect(state.git.branch).toBe("existing-branch");
  });
});

describe("resumeWorkflowForFeature captures baseCommitSha (path 10)", () => {
  beforeEach(() => {
    withTempCwd();
    setGitRunner(fakeRunner("abcdef1234567890abcdef1234567890abcdef12", "feature/test"));
    setSetting("branchPolicy", "current-branch");
  });

  afterEach(() => {
    setGitRunner(defaultGitRunner);
    // Clean up globalThis handler
    if (globalThis.__piWorkflowMonitor) {
      delete globalThis.__piWorkflowMonitor;
    }
  });

  /** Factory for the minimal handler mock used by resume tests */
  function createMockHandler(slug: string) {
    return {
      setActiveFeatureState: vi.fn(function (this: { _state?: unknown }, fs: unknown) {
        this._state = fs;
      }),
      getWorkflowState: vi.fn(function (this: { _state?: unknown }) {
        return {
          currentPhase: (this._state as { workflow?: { currentPhase: string | null } })?.workflow?.currentPhase ?? null,
        };
      }),
      getActiveFeatureSlug: vi.fn(() => slug),
    };
  }

  test("captures baseCommitSha when resuming feature in execute phase", async () => {
    const slug = "2026-06-06-resume-test";

    // Create and save a feature state in execute phase without baseCommitSha
    const state = createFeatureState(slug, `docs/ff/designs/${slug}-design.md`);
    state.workflow.currentPhase = "implement";
    saveFeatureState(state, null);

    globalThis.__piWorkflowMonitor = { handler: createMockHandler(slug) } as unknown as PiWorkflowMonitorBridge;

    const result = await resumeWorkflowForFeature(
      slug,
      NO_CTX as unknown as ExtensionContext,
      NO_MODEL_OVERRIDE_FN as unknown as
        | ((pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>)
        | null,
    );

    // Verify baseCommitSha was captured
    expect(result).toBeDefined();
    expect((result as NonNullable<typeof result>).git.baseCommitSha).toBe("abcdef1234567890abcdef1234567890abcdef12");
    expect((result as NonNullable<typeof result>).git.branch).toBe("feature/test");
  });

  test("does not capture baseCommitSha when resuming feature in design phase", async () => {
    const slug = "2026-06-06-design-resume";

    const state = createFeatureState(slug, `docs/ff/designs/${slug}-design.md`);
    // createFeatureState sets workflow.currentPhase = "design" by default
    saveFeatureState(state, null);

    globalThis.__piWorkflowMonitor = { handler: createMockHandler(slug) } as unknown as PiWorkflowMonitorBridge;

    const result = await resumeWorkflowForFeature(
      slug,
      NO_CTX as unknown as ExtensionContext,
      NO_MODEL_OVERRIDE_FN as unknown as
        | ((pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>)
        | null,
    );

    expect(result).toBeDefined();
    expect((result as NonNullable<typeof result>).git.baseCommitSha).toBeNull();
  });

  test("leaves baseCommitSha null when git fails during resume in execute phase", async () => {
    const slug = "2026-06-06-git-failure-resume";

    // Make all git commands fail
    setGitRunner(() => {
      throw new Error("not a git repo");
    });

    const state = createFeatureState(slug, `docs/ff/designs/${slug}-design.md`);
    state.workflow.currentPhase = "implement";
    saveFeatureState(state, null);

    globalThis.__piWorkflowMonitor = { handler: createMockHandler(slug) } as unknown as PiWorkflowMonitorBridge;

    // Should not throw, baseCommitSha remains null
    const result = await resumeWorkflowForFeature(
      slug,
      NO_CTX as unknown as ExtensionContext,
      NO_MODEL_OVERRIDE_FN as unknown as
        | ((pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>)
        | null,
    );

    expect(result).toBeDefined();
    expect((result as NonNullable<typeof result>).git.baseCommitSha).toBeNull();
    expect((result as NonNullable<typeof result>).git.branch).toBeNull();
  });
});

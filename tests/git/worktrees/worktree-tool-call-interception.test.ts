// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { syncWorktreeStatus } from "../../../src/git/worktrees/worktree-helpers.js";
import workflowMonitorExtension, {
  _cleanupWorktreeOnFinish,
  _ensureWorktreeForExecution,
  bashSingleQuote,
} from "../../../src/index.js";
import { loadFeatureState } from "../../../src/state/feature-state.js";
import { setSetting } from "../../helpers/settings-test-helpers.js";
import {
  createFakePi,
  fireAllHandlers,
  getSingleHandler,
  makeFeatureState,
  setupPiCtx,
  TUI_MODE,
  withTempCwd,
  writeFeatureStateFile,
} from "../../helpers/workflow-monitor-test-helpers.js";

// --- Shared helpers ---

const DEFAULT_WORKTREE_PATH = "/project/.worktrees/test-feature";

function mockToolCall(toolName: string, input: Record<string, unknown>) {
  return { type: "tool_call", toolName, input: { ...input } };
}

/** Get the first (worktree interception) tool_call handler */
// Returns the first tool_call handler (worktree interception), registered before the guardrail.
// Use getSingleHandler() to get the last tool_call handler (guardrail) instead.
function getWorktreeToolCallHandler(fake: ReturnType<typeof createFakePi>) {
  const list = fake.handlers.get("tool_call") ?? [];
  expect(list.length).toBeGreaterThan(0);
  const first = list[0];
  if (!first) throw new Error("No tool_call handler");
  return first;
}

interface SetupOptions {
  phase?: string;
  branchPolicy?: string;
  worktreePath?: string | null;
  slug?: string | null;
}

/**
 * Unified setup for worktree interception tests.
 * Creates a fake pi, registers the extension, writes feature state,
 * and returns all handlers needed by either tool_call or before_agent_start tests.
 */
/** Build a workflow slice for a given active phase (status is derived from currentPhase). */
function buildWorkflowState(phase: string) {
  return { currentPhase: phase, designDoc: null, planDoc: null };
}

function setupWorktreeTest(opts: SetupOptions) {
  const {
    phase = "implement",
    branchPolicy = "worktree",
    worktreePath = DEFAULT_WORKTREE_PATH,
    slug = "test-feature",
  } = opts;

  withTempCwd();
  setSetting("branchPolicy", branchPolicy);

  const fake = createFakePi();
  workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

  if (slug) {
    // Write to disk (for any disk-based reads) and load the same record into the
    // handler as the active feature (SOTS). Both must agree on worktreePath + phase.
    const workflow = buildWorkflowState(phase);
    writeFeatureStateFile(slug, {
      git: { branch: null, baseCommitSha: null, worktreePath, baseBranch: null },
      workflow,
    });
    const featureState = loadFeatureState(slug, null);
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(featureState);
  }

  const onToolCall = getWorktreeToolCallHandler(fake);
  const onBeforeAgentStart = getSingleHandler(fake.handlers, "before_agent_start");
  const ctx = { hasUI: false };

  return { onToolCall, onBeforeAgentStart, ctx, slug };
}

// --- tool_call interception tests ---

describe("tool_call interception for worktree path rewriting", () => {
  // --- bash tool ---

  test("bash: prepends cd to worktree when active", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe(`cd '${DEFAULT_WORKTREE_PATH}' && git status`);
  });

  test("bash: escapes apostrophes in worktree path", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({
      worktreePath: "/path/with'apostrophe/worktree",
    });
    const event = mockToolCall("bash", { command: "ls" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe(`cd '/path/with'\\''apostrophe/worktree' && ls`);
  });

  // --- file tools with required path ---

  test("read: resolves relative path against worktree", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("read", { path: "src/file.ts" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(path.resolve(DEFAULT_WORKTREE_PATH, "src/file.ts"));
  });

  test("read: leaves absolute path unchanged", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("read", { path: "/absolute/path.ts" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe("/absolute/path.ts");
  });

  test("write: resolves relative path against worktree", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("write", { path: "src/new-file.ts", content: "hello" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(path.resolve(DEFAULT_WORKTREE_PATH, "src/new-file.ts"));
    expect(event.input.content).toBe("hello");
  });

  test("write: leaves absolute path unchanged", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("write", { path: "/absolute/src/new-file.ts", content: "hello" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe("/absolute/src/new-file.ts");
  });

  test("edit: leaves absolute path unchanged", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("edit", { path: "/absolute/src/edit.ts", edits: [] });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe("/absolute/src/edit.ts");
  });

  test("edit: resolves relative path against worktree", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("edit", { path: "src/edit.ts", edits: [] });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(path.resolve(DEFAULT_WORKTREE_PATH, "src/edit.ts"));
    expect(event.input.edits).toEqual([]);
  });

  // --- file tools with optional path ---

  test("grep: defaults to worktree when no path given", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("grep", { pattern: "todo" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(DEFAULT_WORKTREE_PATH);
  });

  test("grep: resolves relative path against worktree", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("grep", { pattern: "todo", path: "src/" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(path.resolve(DEFAULT_WORKTREE_PATH, "src/"));
  });

  test("grep: leaves absolute path unchanged", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("grep", { pattern: "todo", path: "/absolute/src/" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe("/absolute/src/");
  });

  test("find: defaults to worktree when no path given", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("find", { pattern: "*.ts" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(DEFAULT_WORKTREE_PATH);
  });

  test("find: resolves relative path against worktree", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("find", { pattern: "*.ts", path: "src/" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(path.resolve(DEFAULT_WORKTREE_PATH, "src/"));
  });

  test("find: leaves absolute path unchanged", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("find", { pattern: "*.ts", path: "/absolute/src/" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe("/absolute/src/");
  });

  test("ls: defaults to worktree when no path given", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("ls", {});
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(DEFAULT_WORKTREE_PATH);
  });

  test("ls: resolves relative path against worktree", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("ls", { path: "src/" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(path.resolve(DEFAULT_WORKTREE_PATH, "src/"));
  });

  test("ls: leaves absolute path unchanged", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("ls", { path: "/absolute/src/" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe("/absolute/src/");
  });

  // --- phase scoping ---

  test("active during execute phase", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ phase: "implement" });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toContain(DEFAULT_WORKTREE_PATH);
  });

  test("active during verify phase", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ phase: "verify" });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toContain(DEFAULT_WORKTREE_PATH);
  });

  test("active during review phase", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ phase: "review" });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toContain(DEFAULT_WORKTREE_PATH);
  });

  test("no rewriting during finish phase", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ phase: "finish" });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe("git status");
  });

  test("no rewriting during design phase", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ phase: "design" });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe("git status");
  });

  test("no rewriting during plan phase", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ phase: "plan" });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe("git status");
  });

  test("no rewriting during uat phase", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ phase: "uat" });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe("git status");
  });

  // --- policy scoping ---

  test("no rewriting when branchPolicy=current-branch", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ branchPolicy: "current-branch" });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe("git status");
  });

  // --- no active feature ---

  test("no rewriting when no active feature slug", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ slug: null });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe("git status");
  });

  // --- no worktreePath ---

  test("no rewriting when worktreePath is null", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({ worktreePath: null });
    const event = mockToolCall("bash", { command: "git status" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe("git status");
  });

  // --- unknown tools are not modified ---

  test("grep: defaults to worktree when path is empty string", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("grep", { pattern: "todo", path: "" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.path).toBe(DEFAULT_WORKTREE_PATH);
  });

  test("bash: prepends cd even when command already starts with cd", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("bash", { command: "cd /other && ls" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    // Double-cd is expected: the handler unconditionally prepends
    expect(event.input.command).toBe(`cd '${DEFAULT_WORKTREE_PATH}' && cd /other && ls`);
  });

  test("unknown tool is not modified", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("custom_tool", { data: "test" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.data).toBe("test");
    expect(Object.keys(event.input)).toEqual(["data"]);
  });
});

// --- before_agent_start tests ---

describe("before_agent_start system prompt update for worktree", () => {
  const WORKTREE_PATH_BAS = "/project/.worktrees/test-bas";
  const FF_INSTRUCTION =
    "⚠️ `.ff/` files are auto-managed external storage — gitignored, never committed. Never `git add -f` them.";

  test("updates CWD in system prompt when worktree active", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({
      phase: "implement",
      worktreePath: WORKTREE_PATH_BAS,
    });
    const result = await onBeforeAgentStart(
      {
        type: "agent_start",
        systemPrompt: "You are an agent.\nCurrent working directory: /main/repo\nBe helpful.",
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    expect(result).toBeDefined();
    expect((result as { systemPrompt: string }).systemPrompt).toContain(
      `Current working directory: ${WORKTREE_PATH_BAS}`,
    );
    expect((result as { systemPrompt: string }).systemPrompt).not.toContain("Current working directory: /main/repo");
  });

  test("no CWD update when branchPolicy=current-branch (but FF_INSTRUCTION still appended)", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({ branchPolicy: "current-branch" });
    const result = await onBeforeAgentStart(
      {
        type: "agent_start",
        systemPrompt: "You are an agent.\nCurrent working directory: /main/repo\nBe helpful.",
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    expect(result).toBeDefined();
    expect((result as { systemPrompt: string }).systemPrompt).toContain(FF_INSTRUCTION);
    expect((result as { systemPrompt: string }).systemPrompt).toContain("Current working directory: /main/repo"); // unchanged
  });

  test("no CWD update when no active feature (but FF_INSTRUCTION still appended)", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({ slug: null });
    const result = await onBeforeAgentStart(
      {
        type: "agent_start",
        systemPrompt: "You are an agent.\nCurrent working directory: /main/repo\nBe helpful.",
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    expect(result).toBeDefined();
    expect((result as { systemPrompt: string }).systemPrompt).toContain(FF_INSTRUCTION);
    expect((result as { systemPrompt: string }).systemPrompt).toContain("Current working directory: /main/repo"); // unchanged
  });

  test("no CWD update when worktreePath is null (but FF_INSTRUCTION still appended)", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({ worktreePath: null });
    const result = await onBeforeAgentStart(
      {
        type: "agent_start",
        systemPrompt: "You are an agent.\nCurrent working directory: /main/repo\nBe helpful.",
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    expect(result).toBeDefined();
    expect((result as { systemPrompt: string }).systemPrompt).toContain(FF_INSTRUCTION);
    expect((result as { systemPrompt: string }).systemPrompt).toContain("Current working directory: /main/repo"); // unchanged
  });

  test("no CWD update during finish phase (but FF_INSTRUCTION still appended)", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({
      phase: "finish",
      worktreePath: WORKTREE_PATH_BAS,
    });
    const result = await onBeforeAgentStart(
      {
        type: "agent_start",
        systemPrompt: "You are an agent.\nCurrent working directory: /main/repo\nBe helpful.",
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    expect(result).toBeDefined();
    expect((result as { systemPrompt: string }).systemPrompt).toContain(FF_INSTRUCTION);
    expect((result as { systemPrompt: string }).systemPrompt).toContain("Current working directory: /main/repo"); // unchanged
  });

  test("no CWD update during plan phase (but FF_INSTRUCTION still appended)", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({
      phase: "plan",
      worktreePath: WORKTREE_PATH_BAS,
    });
    const result = await onBeforeAgentStart(
      {
        type: "agent_start",
        systemPrompt: "You are an agent.\nCurrent working directory: /main/repo\nBe helpful.",
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    expect(result).toBeDefined();
    expect((result as { systemPrompt: string }).systemPrompt).toContain(FF_INSTRUCTION);
    expect((result as { systemPrompt: string }).systemPrompt).toContain("Current working directory: /main/repo"); // unchanged
  });

  test("no CWD update during uat phase (but FF_INSTRUCTION still appended)", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({
      phase: "uat",
      worktreePath: WORKTREE_PATH_BAS,
    });
    const result = await onBeforeAgentStart(
      {
        type: "agent_start",
        systemPrompt: "You are an agent.\nCurrent working directory: /main/repo\nBe helpful.",
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    expect(result).toBeDefined();
    expect((result as { systemPrompt: string }).systemPrompt).toContain(FF_INSTRUCTION);
    expect((result as { systemPrompt: string }).systemPrompt).toContain("Current working directory: /main/repo"); // unchanged
  });

  test("updates CWD during verify phase", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({
      phase: "verify",
      worktreePath: WORKTREE_PATH_BAS,
    });
    const result = await onBeforeAgentStart(
      {
        type: "agent_start",
        systemPrompt: "You are an agent.\nCurrent working directory: /main/repo\nBe helpful.",
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    expect(result).toBeDefined();
    expect((result as { systemPrompt: string }).systemPrompt).toContain(
      `Current working directory: ${WORKTREE_PATH_BAS}`,
    );
    expect((result as { systemPrompt: string }).systemPrompt).not.toContain("Current working directory: /main/repo");
  });

  test("updates CWD during review phase", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({
      phase: "review",
      worktreePath: WORKTREE_PATH_BAS,
    });
    const result = await onBeforeAgentStart(
      {
        type: "agent_start",
        systemPrompt: "You are an agent.\nCurrent working directory: /main/repo\nBe helpful.",
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    expect(result).toBeDefined();
    expect((result as { systemPrompt: string }).systemPrompt).toContain(
      `Current working directory: ${WORKTREE_PATH_BAS}`,
    );
    expect((result as { systemPrompt: string }).systemPrompt).not.toContain("Current working directory: /main/repo");
  });

  test("appends FF_INSTRUCTION when system prompt lacks CWD line", async () => {
    const { onBeforeAgentStart, ctx } = setupWorktreeTest({
      worktreePath: WORKTREE_PATH_BAS,
    });
    const originalPrompt = "You are an agent. Be helpful. No CWD info here.";
    const result = await onBeforeAgentStart(
      { type: "agent_start", systemPrompt: originalPrompt } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    const r = result as { systemPrompt: string };
    expect(r).toBeDefined();
    expect(r.systemPrompt).toContain(FF_INSTRUCTION);
  });
});

// --- footer indicator tests ---

describe("worktree footer indicator", () => {
  test("setStatus called after worktree creation", async () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");

    // _ensureWorktreeForExecution now also wires a real .ff junction in the worktree, so the
    // worktree dir must exist on disk (with a .git so resolveProjectRootFs treats it as a repo).
    fs.mkdirSync(path.join(".worktrees", "test-footer", ".git"), { recursive: true });

    const setStatusMock = vi.fn();
    const mockExec = vi
      .fn()
      // detectBaseBranch: symbolic-ref succeeds
      .mockResolvedValueOnce({ exitCode: 0, stdout: "refs/remotes/origin/main\n" })
      // getBaseBranchCandidates: rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "feature/test\n" })
      // branch --list main (found)
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
      hasUI: true,
      actions: { exec: mockExec },
      ui: { setStatus: setStatusMock, select: vi.fn().mockResolvedValue("main (detected)") },
    };
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    const featureState = makeFeatureState("test-footer", {
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    });

    await _ensureWorktreeForExecution(featureState, ctx as unknown as ExtensionContext);

    expect(setStatusMock).toHaveBeenCalledWith("worktree", expect.stringContaining("📂"));
  });

  test("setStatus cleared after worktree cleanup", async () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");

    const setStatusMock = vi.fn();
    const mockExec = vi
      .fn()
      // resolveMainRepoPath: rev-parse --show-toplevel
      .mockResolvedValueOnce({ exitCode: 0, stdout: "/project/main\n" })
      // removeWorktree: success
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" });

    const ctx = {
      hasUI: true,
      actions: { exec: mockExec },
      ui: { setStatus: setStatusMock },
    };
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    const featureState = makeFeatureState("test-footer-cleanup", {
      git: {
        branch: null,
        baseCommitSha: null,
        worktreePath: "/project/.worktrees/test-footer-cleanup",
        baseBranch: "main",
      },
    });

    await _cleanupWorktreeOnFinish(featureState, ctx as unknown as ExtensionContext);

    expect(setStatusMock).toHaveBeenCalledWith("worktree", undefined);
  });
});

// --- reload/resume restore: footer indicator must survive a reload ---

describe("worktree footer indicator restore on session restore", () => {
  /** Build a session branch with a feature_flow_state entry carrying a worktreePath. */
  function branchWithWorktree(worktreePath: string, completedAt: string | null) {
    return [
      {
        id: "entry-0",
        type: "custom",
        customType: "feature_flow_state",
        data: {
          featureState: {
            featureSlug: "reload-feature",
            git: { branch: null, baseCommitSha: null, worktreePath, baseBranch: "main" },
            createdAt: "2026-06-29T00:00:00.000Z",
            updatedAt: "2026-06-29T00:00:00.000Z",
            completedAt,
            workflow: { currentPhase: "implement", designDoc: null, planDoc: null },
            sessionFiles: [],
            featureId: null,
            design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
            plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
            implement: { taskReviewRounds: {} },
            verify: { verifyLoopCount: 0 },
            review: { reviewLoopCount: 0, reviewHistory: [] },
          },
          guardrailsState: {
            tdd: { stage: "idle", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
            verification: "not-run",
          },
        },
      },
    ];
  }

  function makeRestoreCtx(branch: ReturnType<typeof branchWithWorktree>, setStatus: ReturnType<typeof vi.fn>) {
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => branch },
      ui: { setWidget: () => {}, setStatus },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);
    return ctx;
  }

  test("reload restores 📂 status from session entries (the reported bug)", async () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const setStatusMock = vi.fn();
    const ctx = makeRestoreCtx(branchWithWorktree("/proj/.worktrees/reload-feature", null), setStatusMock);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);

    expect(setStatusMock).toHaveBeenCalledWith(
      "worktree",
      expect.stringContaining("📂 /proj/.worktrees/reload-feature"),
    );
  });

  test("startup restores 📂 status when a feature entry is present", async () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const setStatusMock = vi.fn();
    const ctx = makeRestoreCtx(branchWithWorktree("/proj/.worktrees/startup-feature", null), setStatusMock);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "startup" }, ctx);

    expect(setStatusMock).toHaveBeenCalledWith(
      "worktree",
      expect.stringContaining("📂 /proj/.worktrees/startup-feature"),
    );
  });

  test("resume restores 📂 status from session entries", async () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const setStatusMock = vi.fn();
    const ctx = makeRestoreCtx(branchWithWorktree("/proj/.worktrees/resume-feature", null), setStatusMock);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "resume" }, ctx);

    expect(setStatusMock).toHaveBeenCalledWith(
      "worktree",
      expect.stringContaining("📂 /proj/.worktrees/resume-feature"),
    );
  });

  test("reload clears status when the restored feature is completed (worktreePath lingers)", async () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const setStatusMock = vi.fn();
    const ctx = makeRestoreCtx(
      branchWithWorktree("/proj/.worktrees/done-feature", "2026-06-29T00:00:00.000Z"),
      setStatusMock,
    );

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);

    expect(setStatusMock).toHaveBeenCalledWith("worktree", undefined);
  });

  test("reload with no feature entry clears the status", async () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const setStatusMock = vi.fn();
    const ctx = makeRestoreCtx([], setStatusMock);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);

    expect(setStatusMock).toHaveBeenCalledWith("worktree", undefined);
  });
});

// --- edge case tests ---

describe("tool_call interception edge cases", () => {
  test("bash: skips rewriting when command is empty", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    const event = mockToolCall("bash", { command: "" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    expect(event.input.command).toBe("");
  });

  test("bash: handles path with apostrophe via bashSingleQuote", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({
      worktreePath: "/project/user's dir/.worktrees/test",
    });
    const event = mockToolCall("bash", { command: "echo hello" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    // bashSingleQuote wraps in '...' and escapes internal quotes
    expect(event.input.command).toContain("cd '/project/user'\\''s dir/.worktrees/test' && echo hello");
  });

  test("no rewriting when active feature slug has no state file (loadFeatureState returns null)", async () => {
    const { onToolCall, ctx } = setupWorktreeTest({});
    // SOTS: production reads handler.getActiveFeatureState() (the in-memory record),
    // not loadFeatureState. Clear the active record so there is no feature state
    // (and thus no worktreePath) — equivalent to the old "no state file" case.
    const handler = globalThis.__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(null);

    const event = mockToolCall("bash", { command: "echo test" });
    await onToolCall(event as unknown as ExtensionEvent, ctx as unknown as ExtensionContext);
    // No active feature → getActiveWorktreeContext returns null → no rewriting
    expect(event.input.command).toBe("echo test");
  });
});

describe("bashSingleQuote helper", () => {
  test("wraps plain string in single quotes", () => {
    expect(bashSingleQuote("hello")).toBe("'hello'");
  });

  test("wraps empty string", () => {
    expect(bashSingleQuote("")).toBe("''");
  });

  test("escapes internal single quotes", () => {
    // 'user's dir' → 'user' + \'' + 's dir' = 'user'\''s dir'
    expect(bashSingleQuote("user's dir")).toBe("'user'\\''s dir'");
  });

  test("handles path with spaces", () => {
    expect(bashSingleQuote("/path/with spaces/dir")).toBe("'/path/with spaces/dir'");
  });

  test("handles multiple apostrophes", () => {
    expect(bashSingleQuote("it's user's file")).toBe("'it'\\''s user'\\''s file'");
  });
});

// --- syncWorktreeStatus: footer indicator sync (restored on reload) ---

describe("syncWorktreeStatus", () => {
  function makeCtx() {
    const setStatus = vi.fn();
    const ui = { setStatus };
    setupPiCtx(ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);
    return {
      ctx: { hasUI: true, ui } as unknown as ExtensionContext,
      setStatus,
    };
  }

  test("shows 📂 path when worktreePath set, branchPolicy=worktree, not done", () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");
    const { setStatus } = makeCtx();
    const state = makeFeatureState("sync-show", {
      git: { branch: null, baseCommitSha: null, worktreePath: "/proj/.worktrees/sync-show", baseBranch: null },
    });

    syncWorktreeStatus(state);

    expect(setStatus).toHaveBeenCalledWith("worktree", expect.stringContaining("📂 /proj/.worktrees/sync-show"));
  });

  test("clears status when worktreePath is null", () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");
    const { setStatus } = makeCtx();
    const state = makeFeatureState("sync-null", {
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    });

    syncWorktreeStatus(state);

    expect(setStatus).toHaveBeenCalledWith("worktree", undefined);
  });

  test("clears status when feature is completed (worktreePath lingers in done state)", () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");
    const { setStatus } = makeCtx();
    const state = makeFeatureState("sync-done", {
      git: { branch: null, baseCommitSha: null, worktreePath: "/proj/.worktrees/sync-done", baseBranch: null },
      completedAt: "2026-06-29T00:00:00.000Z",
    });

    syncWorktreeStatus(state);

    expect(setStatus).toHaveBeenCalledWith("worktree", undefined);
  });

  test("clears status when branchPolicy is not worktree", () => {
    withTempCwd();
    setSetting("branchPolicy", "current-branch");
    const { setStatus } = makeCtx();
    const state = makeFeatureState("sync-no-policy", {
      git: { branch: null, baseCommitSha: null, worktreePath: "/proj/.worktrees/sync-no-policy", baseBranch: null },
    });

    syncWorktreeStatus(state);

    expect(setStatus).toHaveBeenCalledWith("worktree", undefined);
  });

  test("clears status when featureState is null", () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");
    const { setStatus } = makeCtx();

    syncWorktreeStatus(null);

    expect(setStatus).toHaveBeenCalledWith("worktree", undefined);
  });

  test("no-op when ctx.hasUI is false", () => {
    withTempCwd();
    setSetting("branchPolicy", "worktree");
    const setStatus = vi.fn();
    const _ctx = {
      hasUI: false,
      ui: { setStatus },
    } as unknown as ExtensionContext;
    const state = makeFeatureState("sync-noui", {
      git: { branch: null, baseCommitSha: null, worktreePath: "/proj/.worktrees/sync-noui", baseBranch: null },
    });

    syncWorktreeStatus(state);

    expect(setStatus).not.toHaveBeenCalled();
  });
});

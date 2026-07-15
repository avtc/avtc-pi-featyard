// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vitest";
import type { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import { PiCtx } from "../../src/shared/types.js";
import { ensureFeatyardJunction } from "../../src/state/artifact-junction.js";
import type { FeatureState } from "../../src/state/feature-state.js";
import { createFeatureState } from "../../src/state/feature-state.js";
import { registerTaskReadyAdvance } from "../../src/tools/task-ready-advance.js";
import { ensureTestSettings, resetSettingsState } from "./settings-test-helpers.js";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

const ORIGINAL_CWD = process.cwd();
const TEMP_DIRS: string[] = [];

/**
 * Change to a temp directory for the duration of the test.
 * Cleaned up automatically via cleanupAfterTest.
 */
export function withTempCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfm-test-"));
  TEMP_DIRS.push(dir);
  process.chdir(dir);
  // State + artifacts are co-located under the `.featyard` junction. Ensure it immediately so any
  // later state/artifact write (saveFeatureState, writeFileSync, …) lands in the external store
  // and survives a subsequent `workflowMonitorExtension` activation (which would otherwise
  // `ensureFeatyardJunction(onRealDir:"rename")` a stray real `.featyard` aside and lose it). Idempotent.
  ensureTestFeatyardJunction();
  return dir;
}

/**
 * Initialize the current temp cwd as a git repo with one baseline commit, so the
 * TDD write-order check (git-based) has a real working tree to inspect. Files
 * written after this call appear as untracked/modified in `git status` — i.e.
 * in the change set. Requires `withTempCwd()` first.
 */
export function initTempGitRepo(): void {
  execSync("git init -q", { cwd: process.cwd() });
  execSync('git config user.email "test@test"', { cwd: process.cwd() });
  execSync('git config user.name "test"', { cwd: process.cwd() });
  fs.writeFileSync(".gitignore", ".featyard/\n");
  execSync("git add .gitignore", { cwd: process.cwd() });
  execSync('git commit -q -m "baseline"', { cwd: process.cwd() });
}

/**
 * Ensure the `.featyard` junction exists for the current (temp) cwd BEFORE writing state/artifacts.
 * State is co-located under `.featyard` (the junction → test PI_FY_HOME external store); without this,
 * a later `workflowMonitorExtension` activation would `ensureFeatyardJunction(onRealDir:"rename")` a
 * stray REAL `.featyard` aside and lose anything written to it. Idempotent — safe to re-call on activation.
 */
export function ensureTestFeatyardJunction(): void {
  ensureFeatyardJunction(process.cwd(), "current-branch", process.env.PI_FY_HOME ?? os.homedir(), "rename");
}

/**
 * Reset settings to factory defaults for beforeEach/afterEach isolation: delegates to the canonical
 * {@link resetSettingsState} (re-wires a fresh default holder + clears the env var + resets the
 * model-overrides cache). Keeps the mock-DI override active so settings reads still hit the holder.
 */
export function resetSettingsToDefaults(): void {
  resetSettingsState();
}

/**
 * Cleanup after each test: restore CWD, reset settings, clean env vars and temp dirs.
 * Call in afterEach of each test file.
 */
export function cleanupAfterTest(): void {
  if (process.cwd() !== ORIGINAL_CWD) {
    process.chdir(ORIGINAL_CWD);
  }
  delete process.env.PI_FY_FEATURE;
  resetSettingsToDefaults();
  delete process.env.PI_FY_STAGE;
  delete process.env.PI_FY_REVIEW_LOOP;
  delete process.env.PI_FY_EXECUTION_MODE;
  // Clean up globals that persist between tests (isolate: false)
  delete globalThis.__piCtx;
  // Clear the background-archive sweep timer so an activation in one test never leaks a live
  // setInterval into later tests (the bridge persists across files under isolate:false).
  const wfm = globalThis.__piWorkflowMonitor;
  if (wfm?.archiveTimer) {
    clearInterval(wfm.archiveTimer);
    wfm.archiveTimer = undefined;
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Set up globalThis.__piCtx with a mock UI.
 * Use this when code under test reads UI from the guard (e.g. updateWidget, syncWorktreeStatus).
 * Pass the same mock UI object you'd put on your ctx so assertions on UI calls work.
 *
 * Example:
 *  const ui = { notify: vi.fn, setStatus: vi.fn };
 *  setupPiCtx(ui);
 */
export const TUI_MODE: "tui" = "tui";

export function setupPiCtx(
  ui: Partial<ExtensionContext["ui"]> & { notify?: () => void; select?: () => unknown },
  mode: "tui" | "rpc" | "json" | "print",
): void {
  globalThis.__piCtx = new PiCtx();
  globalThis.__piCtx.refresh({
    ui: ui as ExtensionContext["ui"],
    hasUI: Object.keys(ui).length > 0,
    mode,
    model: undefined,
    modelRegistry: undefined,
    sessionManager: undefined,
    cwd: process.cwd(),
  } as unknown as ExtensionCommandContext);
}

/**
 * Creates a fake pi API for testing.
 * NOTE: Changes process.cwd to a temp directory to prevent state file
 * pollution. CWD is restored in afterEach.
 */
export function createFakePi() {
  withTempCwd();
  // Ensure a settings holder exists for the test (inject schema defaults if the test hasn't set
  // one). Idempotent — does not clobber a holder the test already injected via setTestSettings.
  ensureTestSettings();

  const handlers = new Map<string, Handler[]>();
  const appendedEntries: unknown[] = [];
  const sentMessages: { message: string; options?: unknown }[] = [];
  const registeredCommands = new Map<string, unknown>();

  return {
    handlers,
    appendedEntries,
    sentMessages,
    registeredCommands,
    api: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      events: (() => {
        const eventHandlers = new Map<string, Handler[]>();
        return {
          on(channel: string, handler: Handler) {
            const list = eventHandlers.get(channel) ?? [];
            list.push(handler);
            eventHandlers.set(channel, list);
            return () => {
              const list = eventHandlers.get(channel);
              if (list) {
                const idx = list.indexOf(handler);
                if (idx >= 0) list.splice(idx, 1);
              }
            };
          },
          emit(channel: string, data: unknown) {
            const list = eventHandlers.get(channel) ?? [];
            for (const h of list) h(data as ExtensionEvent, {} as ExtensionContext);
          },
        };
      })(),
      registerTool() {},
      registerCommand(name: string, definition: { handler: unknown }) {
        registeredCommands.set(name, definition.handler);
      },
      appendEntry(customType: string, data: unknown) {
        appendedEntries.push({ customType, data });
      },
      sendUserMessage(message: string, options: unknown | null) {
        sentMessages.push({ message, options });
      },
      // setModel/getModel: mutable so tests can override them for model-override tests
      setModel: async () => true,
      getModel: () => undefined,
    },
  };
}

/** Build a complete FeatureState for testing, merging overrides on top of a real base. */
export function makeFeatureState(slug: string, overrides: Partial<FeatureState>): FeatureState {
  return { ...createFeatureState(slug, "docs/featyard/designs/design-doc-placeholder.md"), ...overrides };
}

export function getSingleHandler(handlers: Map<string, Handler[]>, event: string): Handler {
  const list = handlers.get(event) ?? [];
  expect(list.length).toBeGreaterThan(0);
  // For tool_call, return the last handler (the guardrail) since the worktree
  // interception handler is registered first and returns undefined when inactive.
  // Use getWorktreeToolCallHandler in interception tests to get the first handler.
  // For all other events, return the first (only) handler.
  const index = event === "tool_call" ? list.length - 1 : 0;
  const handler = list[index];
  if (!handler) throw new Error(`No handler found for ${event} at index ${index}`);
  return handler;
}

export function getHandlers(handlers: Map<string, Handler[]>, event: string): Handler[] {
  return handlers.get(event) ?? [];
}

/** Fire ALL handlers for an event sequentially, returning the result of the last one.
 *  Use this for session_start/session_tree where multiple handlers must all fire. */
export async function fireAllHandlers(
  handlers: Map<string, Handler[]>,
  event: string,
  ...args: unknown[]
): Promise<unknown> {
  const list = handlers.get(event) ?? [];
  expect(list.length).toBeGreaterThan(0);
  let result: unknown;
  for (const handler of list) {
    result = await (handler as (...args: unknown[]) => Promise<unknown>)(...args);
  }
  return result;
}

/**
 * Fire `agent_settled` (the deferred phase-transition followUp drain point) and flush
 * the ~DRAIN_DELAY_MS timer so the staged followUp is delivered synchronously.
 * Mirrors the real lifecycle: agent_end (per-cycle) → agent_settled (pi idle) →
 * deferred drain fires. Use after firing `agent_end` when a test needs the staged
 * followUp to have been dispatched. Enables fake timers BEFORE agent_settled so the
 * drain's setTimeout is captured, then advances and restores real timers.
 */
export async function settleAndDrainPostTurnFollowUp(handlers: Map<string, Handler[]>): Promise<void> {
  vi.useFakeTimers();
  await fireAllHandlers(handlers, "agent_settled", {});
  vi.advanceTimersByTime(1000);
  vi.useRealTimers();
}

export type FakePi = ReturnType<typeof createFakePi>;

export type ToolHandlers = {
  onToolCall: Handler;
  onToolResult: Handler;
};

export type ExtendedToolHandlers = ToolHandlers & {
  onInput: Handler;
};

export function getToolHandlers(fake: FakePi): ToolHandlers {
  return {
    onToolCall: getSingleHandler(fake.handlers, "tool_call"),
    onToolResult: getSingleHandler(fake.handlers, "tool_result"),
  };
}

export function getExtendedToolHandlers(fake: FakePi): ExtendedToolHandlers {
  return {
    ...getToolHandlers(fake),
    onInput: getSingleHandler(fake.handlers, "input"),
  };
}

/** Write design doc → creates feature state, completes design phase. */
export async function writeDesignDoc(
  { onToolCall, onToolResult }: ToolHandlers,
  ctx: ExtensionContext,
  opts: { slug?: string; toolCallId?: string } = {},
) {
  const slug = opts.slug ?? "2026-05-10-test-feature";
  const tcId = opts.toolCallId ?? "tc-design";
  const designPath = `docs/featyard/designs/${slug}-design.md`;
  await onToolCall(
    {
      type: "tool_call",
      toolName: "write",
      toolCallId: tcId,
      input: { path: designPath, content: "# Design" },
    } as unknown as ExtensionEvent,
    ctx,
  );
  await onToolResult(
    {
      type: "tool_call",
      toolName: "write",
      toolCallId: tcId,
      input: { path: designPath, content: "# Design" },
      content: [{ type: "text", text: "ok" }],
    } as unknown as ExtensionEvent,
    ctx,
  );
}

/** User invokes /skill:fy-plan → advances to plan phase. */
export async function readWritingPlansSkill(handlers: ExtendedToolHandlers, ctx: ExtensionContext) {
  await handlers.onInput({ type: "input", text: "/skill:fy-plan" } as unknown as ExtensionEvent, ctx);
}

/** Write implementation plan → records artifact on plan phase. */
export async function writeImplementationPlan(
  { onToolCall, onToolResult }: ToolHandlers,
  ctx: ExtensionContext,
  opts: { slug?: string; toolCallId?: string } = {},
) {
  const slug = opts.slug ?? "2026-05-10-test-feature";
  const tcId = opts.toolCallId ?? "tc-plan";
  const planPath = `.featyard/task-plans/${slug}-task-plan.md`;
  await onToolCall(
    {
      type: "tool_call",
      toolName: "write",
      toolCallId: tcId,
      input: { path: planPath, content: "# Plan" },
    } as unknown as ExtensionEvent,
    ctx,
  );
  await onToolResult(
    {
      type: "tool_call",
      toolName: "write",
      toolCallId: tcId,
      input: { path: planPath, content: "# Plan" },
      content: [{ type: "text", text: "ok" }],
    } as unknown as ExtensionEvent,
    ctx,
  );
}

export function writeFeatureStateFile(slug: string, overrides: Record<string, unknown> = {}): string {
  // Ensure we're in a temp directory so state files never leak to the real store.
  if (process.cwd() === ORIGINAL_CWD) withTempCwd();
  // `withTempCwd` already ensured the `.featyard` junction (idempotent), so state written here lands in
  // the external store and survives a later `workflowMonitorExtension` activation.
  const stateDir = path.join(".featyard", "feature-state");
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, `${slug}.json`);
  const state = {
    featureSlug: slug,
    git: {
      branch: null,
      baseCommitSha: null,
      worktreePath: null,
      baseBranch: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    workflow: { currentPhase: null, designDoc: null, planDoc: null },
    design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
    plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
    implement: { tasks: [] },
    verify: { verifyLoopCount: 0 },
    review: { reviewLoopCount: 0, reviewHistory: [] },
    sessionFiles: [],
    featureId: null,
    ...overrides,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.env.PI_FY_FEATURE = slug;
  return slug;
}

/** Helper: create fake pi that captures registered tools */
export function createPiWithToolCapture() {
  const fake = createFakePi();
  const registeredTools: unknown[] = [];
  const api = {
    ...fake.api,
    registerTool(def: unknown) {
      registeredTools.push(def);
    },
  };
  return { fake, registeredTools, api };
}

export const NO_UI_CTX = {
  hasUI: false,
  sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
  ui: { setWidget: () => {} },
} as unknown as ExtensionContext;

// --- Boolean sentinel values for test calls ---

/** Finish phase is whitelisted */
export const IS_WHITELISTED = true;

/** Finish phase is not whitelisted */
export const IS_NOT_WHITELISTED = false;

/** All todos are done */
export const ALL_TODOS_DONE = true;

/** Not all todos are done */
export const NOT_ALL_TODOS_DONE = false;

/** Successful exit code */
export const EXIT_CODE_SUCCESS = 0;

/** Failed exit code */
export const EXIT_CODE_FAILURE = 1;

/** Null sentinel: no auto-agent callback */
export const NO_AUTO_AGENT_CALLBACK: null = null;

/** Null sentinel: no database */
export const NO_DATABASE: KanbanDatabase | null = null;

/** Null sentinel: no todo override (clear override) */
export const NO_TODO_OVERRIDE: boolean | null = null;

/** Null sentinel: no base branch override */
export const NO_BASE_BRANCH: string | null = null;

/** Null sentinel: no feature state override */
export const NO_FEATURE_STATE_OVERRIDE: FeatureState | null = null;

/** Mock was called (track that a call occurred) */
export const MOCK_CALLED = true;

/** TDD test result: tests passed */
export const TDD_TESTS_PASSED = true;

/** TDD state: verification flag is off */
export const TDD_VERIFICATION_OFF = false;

export const BRAINSTORM_ACTIVE_STATE = {
  workflow: { currentPhase: "design", designDoc: null, planDoc: null },
  completedAt: null,
};

export const EXECUTE_ACTIVE = {
  workflow: {
    currentPhase: "implement",
    designDoc: "docs/featyard/designs/design.md",
    planDoc: ".featyard/task-plans/impl-task-plan.md",
  },
  completedAt: null,
};

export const PLAN_ACTIVE_STATE = {
  workflow: {
    currentPhase: "plan",
    designDoc: "docs/featyard/designs/test-design.md",
    planDoc: null,
  },
  completedAt: null,
};

/** Workflow state with all phases through review complete, UAT active. */
export const UAT_ACTIVE_STATE = {
  workflow: {
    currentPhase: "uat",
    designDoc: null,
    planDoc: null,
  },
  completedAt: null,
};

// --- RPC subagent / root context helpers -------------------------------------
// In RPC spawn mode a subagent child has ctx.hasUI === true (rpc-mode passes a real uiContext),
// so gates that used to key off `!ctx.hasUI` now key off isSubagentSession (reads
// PI_SUBAGENT_PARENT_PID). Tests simulating a subagent/non-interactive context must set that env
// var; tests simulating a root session must provide a real ctx.ui. These helpers centralize both.

/** Mark this test as a subagent session (isSubagentSession === true). Idempotent. */
export function enableSubagentMode(): void {
  process.env.PI_SUBAGENT_PARENT_PID = "test-parent";
}

/** Mark this test as a root session (isSubagentSession === false). Idempotent. */
export function disableSubagentMode(): void {
  delete process.env.PI_SUBAGENT_PARENT_PID;
}

/** A captured sendUserMessage call (text + its delivery options). */
export interface Sent {
  text: string;
  options: { deliverAs?: string };
}

/**
 * Register `task_ready_advance` against a minimal fake pi and capture both the registered
 * tool definition and every `sendUserMessage` it dispatches (text + options). Shared by the
 * task-ready-advance tests so they all assert against the same `Sent` shape (incl. deliverAs).
 */
export function captureTaskReadyAdvanceTool(): {
  getTool: () => ToolDefinition | undefined;
  sent: Sent[];
  /** The fake pi — exposed so tests can drain staged post-turn followUps via drainPostTurnFollowUp(pi). */
  pi: ExtensionAPI;
} {
  let toolDef: ToolDefinition | undefined;
  const sent: Sent[] = [];
  const pi = {
    on() {},
    registerTool(tool: ToolDefinition) {
      toolDef = tool;
    },
    sendUserMessage: (text: string, options: { deliverAs?: string }) => sent.push({ text, options }),
    appendEntry() {},
  } as unknown as ExtensionAPI;
  registerTaskReadyAdvance(pi, () => {});
  return {
    getTool: () => toolDef,
    sent,
    pi,
  };
}

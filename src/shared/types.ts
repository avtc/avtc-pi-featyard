// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Shared types for cross-extension communication.
 *
 * Contains:
 * - Bridge interfaces for globalThis typed access
 * - HandlerContext for ctx.actions.exec augmentation
 * - PiCtx for stale context workaround
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
// --- MutableRef (cross-module mutable state sharing) ---

/** Mutable reference to a value — used for cross-module state sharing. */
export interface MutableRef<T> {
  value: T;
}

// --- Bridge interfaces ---

export interface PiWorkflowMonitorBridge {
  handler: import("../state/feature-session.js").FeatureSession;
  requestWidgetUpdate(): void;
  performWorkflowReset(): void;
  modelOverrideRefs: { pi: import("@earendil-works/pi-coding-agent").ExtensionAPI | undefined };
  finishPhaseWhitelisted: boolean;
  workflowInitiatedNewSession: boolean | undefined;
  newSessionMessage: string | null | undefined;
  /** Handle to the 24h artifact-archive sweep interval. Cleared on session_shutdown so
   *  /reload (which re-evaluates this module) never leaks a duplicate timer. undefined = not running. */
  archiveTimer: ReturnType<typeof setInterval> | undefined;
}

export interface PiKanbanBridge {
  autoAgent: import("../kanban/auto-agent/auto-agent-state-machine.js").AutoAgentStateMachine | null;
  autoAgentCallback: import("../kanban/auto-agent/auto-agent-state-machine.js").AutoAgentCallback | undefined;
  /** True while the auto-agent is mid-`newSession`/`switchSession`. Distinguishes auto-initiated
   *  session replacements from external ones (manual /new, /resume, /fork, /reload). External
   *  replacements orphan the agent's command-context-only `newSession`/`switchSession`, so the
   *  session_start handler pauses the agent unless this flag is set. */
  autoAgentInitiatingReplacement: boolean | undefined;
  database: import("../kanban/data/kanban-database.js").KanbanDatabase | null;
  tools: import("../kanban/kanban-operations.js").KanbanTools | null;
  activateFeature:
    | ((
        result: {
          feature: import("../kanban/data/kanban-types.js").Feature;
          skill: string;
          kanbanFeatureId: number;
        },
        piCtx: { sendUserMessage: (msg: string, options?: { deliverAs?: "steer" | "followUp" }) => void },
      ) => Promise<void>)
    | undefined;
  createGracePeriodManager:
    | ((
        sm: import("../kanban/auto-agent/auto-agent-state-machine.js").AutoAgentStateMachine,
        tools: import("../kanban/kanban-operations.js").KanbanTools,
      ) => import("../kanban/auto-agent/auto-agent-grace-period.js").GracePeriodManager)
    | undefined;
  terminalInputUnsubscribe: (() => void) | null;
  gracePeriod: import("../kanban/auto-agent/auto-agent-grace-period.js").GracePeriodManager | undefined;
}

// --- CompactFollowUp (stored-message pattern) ---

export interface CompactFollowUp {
  /** Specific note appended after the skill+framing (e.g. "Context was reset between tasks — next task: X",
   *  "Run plan review iteration #1"). Must NOT contain a `/skill:` prefix or generic compaction framing
   *  the compact-handler owns the skill + framing line. Empty string = no caller note. */
  message: string;
  /** Skill name the handler should expand (e.g. "fy-implement", "fy-plan-review"). When omitted,
   *  the handler falls back to getExpectedSkill. Lets callers that carry a skill avoid the
   *  duplicate-skill the old prepend logic produced. */
  skillName?: string;
  /** Optional callback to execute after the session_compact handler sends the followUp message */
  onAfterFollowUp?: () => void;
}

// --- HandlerContext ---

/** ExtensionContext augmented with ctx.actions.exec (internal runtime property) */
export interface HandlerContext extends ExtensionContext {
  actions: {
    exec: (command: string, options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
  };
}

// --- PiCtx ---

const noopNotify = (_msg: string, _level: "info" | "warning" | "error" | null) => {};

/**
 * After ctx.newSession, ctx.switchSession, or /reload, the runner is
 * permanently invalidated — all ctx objects from that runner become stale.
 *
 * This class stashes essential functions that survive session transitions
 * and provides safe access regardless of ctx staleness.
 */

/**
 * Portable shape of the ctx passed to withSession callbacks. The real SDK type
 * (ReplacedSessionContext) isn't re-exported from the package root, so this minimal
 * structural type keeps declarations portable while exposing the members callers use.
 */
type ReplacedSessionCtx = ExtensionCommandContext & {
  sendUserMessage: (
    content: string | ReadonlyArray<{ type: string }>,
    options?: { deliverAs?: "steer" | "followUp" },
  ) => Promise<void>;
};

/** Signature of ctx.newSession used by PiCtx (defined once to avoid duplicating the options shape in the getter return type + the stashed cast). */
type NewSessionFn = (options?: {
  parentSession?: string;
  setup?: (sessionManager: unknown) => Promise<void>;
  withSession?: (ctx: ReplacedSessionCtx) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export class PiCtx {
  private stashed: {
    newSession?: ExtensionCommandContext["newSession"];
    switchSession?: ExtensionCommandContext["switchSession"];
    sessionManager?: ExtensionCommandContext["sessionManager"];
    notify?: (msg: string, level?: "info" | "warning" | "error") => void;
    ui?: ExtensionContext["ui"];
    hasUI?: boolean;
    mode?: ExtensionCommandContext["mode"];
    model?: ExtensionCommandContext["model"];
    modelRegistry?: ExtensionCommandContext["modelRegistry"];
    cwd?: string;
  } = {};
  /** Stash essential functions from a fresh ctx. Call after every session transition.
   * Bound methods (ui, notify) survive runner invalidation — they're bound to the
   * uiContext object directly, which lives independently of the runner's assertActive gate.
   * The guard is the single safe access point for ctx in event handlers that may fire
   * after compaction/session replacement invalidates the runner. */
  refresh(ctx: ExtensionCommandContext): void {
    if (typeof ctx.newSession === "function") this.stashed.newSession = ctx.newSession.bind(ctx);
    if (typeof ctx.switchSession === "function") this.stashed.switchSession = ctx.switchSession.bind(ctx);
    if (ctx.sessionManager) this.stashed.sessionManager = ctx.sessionManager;
    if (ctx.ui) this.stashed.ui = ctx.ui;
    if (ctx.ui?.notify) this.stashed.notify = ctx.ui.notify.bind(ctx.ui);
    this.stashed.hasUI = ctx.hasUI;
    if (ctx.mode) this.stashed.mode = ctx.mode;
    if (ctx.model) this.stashed.model = ctx.model;
    if (ctx.modelRegistry) this.stashed.modelRegistry = ctx.modelRegistry;
    if (ctx.cwd) this.stashed.cwd = ctx.cwd;
  }

  get newSession(): NewSessionFn | undefined {
    return this.stashed.newSession as NewSessionFn | undefined;
  }
  get switchSession():
    | ((
        sessionPath: string,
        options?: { withSession?: (ctx: ReplacedSessionCtx) => Promise<void> },
      ) => Promise<{ cancelled: boolean }>)
    | undefined {
    return this.stashed.switchSession as
      | ((
          sessionPath: string,
          options?: { withSession?: (ctx: ReplacedSessionCtx) => Promise<void> },
        ) => Promise<{ cancelled: boolean }>)
      | undefined;
  }
  get sessionManager(): { getSessionFile?: () => string | undefined } | undefined {
    return this.stashed.sessionManager;
  }
  get notify() {
    return this.stashed.notify ?? noopNotify;
  }
  /** Full ui object (bound to uiContext — survives runner invalidation). Undefined if never refreshed or no UI. */
  get ui() {
    return this.stashed.ui;
  }
  /** Whether the last known-good ctx had UI. Undefined if never refreshed. */
  get hasUI() {
    return this.stashed.hasUI;
  }
  /** Last known mode. Undefined if never refreshed. */
  get mode(): ExtensionCommandContext["mode"] | undefined {
    return this.stashed.mode;
  }
  get model() {
    return this.stashed.model;
  }
  get modelRegistry() {
    return this.stashed.modelRegistry;
  }
  get cwd() {
    return this.stashed.cwd;
  }
}

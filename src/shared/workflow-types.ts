// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * DI interfaces for workflow-monitor module decomposition.
 *
 * Each module declares its cross-module dependencies as interfaces.
 * The orchestrator creates modules in topological dependency order and injects them.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { getSettings } from "../settings/settings-ui.js";
import type { FeatureSession } from "../state/feature-session.js";

/** Shared context passed to all modules. */
export interface ModuleContext {
  pi: ExtensionAPI;
  handler: FeatureSession;
}

/** Common phase-transition dependencies shared by PhaseReadyDeps and WorkflowCommandDeps (pi + handler + model override + review→UAT transition). */
export interface WorkflowTransitionDeps {
  pi: ExtensionAPI;
  handler: FeatureSession;
  applyModelOverrideForPhase: (pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>;
  handleReviewToUatTransition: (
    ctx: ExtensionContext,
    slug: string,
    settings: ReturnType<typeof getSettings>,
    // Review-report context for the worth-notes merge. Non-null on the after-review path
    // so the report + handoff + worth-notes pointer merge into ONE notify; null at the
    // off/after-finish paths and non-loop call sites (no merge). Required (no-optional-params).
    reportCtx: { report: string | null; level: "info" | "warning"; pointer: string | null } | null,
  ) => Promise<void>;
}

/**
 * Compaction module — tracks empty loops, agent-finished state, and reviewer skip logic.
 * Written to by Guardrails (incrementEmptyLoop), PhaseReady (resetEmptyLoop, isReviewerSkipped),
 * and AgentLifecycle (setAgentFinished). Read by SessionLifecycle (resetTracking).
 */
export interface ICompaction {
  setAgentFinished(value: boolean): void;
  incrementEmptyLoop(slug: string, reviewer: string): void;
  resetEmptyLoop(slug: string, reviewer: string): void;
  isReviewerSkipped(slug: string, reviewer: string, threshold: number): boolean;
  resetTracking(): void;
  /** Get empty loops for a specific slug (used by substituteTemplates) */
  getEmptyLoopsForSlug(slug: string): Record<string, number>;
  /** Reset all empty loops across all slugs */
  resetAllEmptyLoops(): void;
  /** Get all reviewer empty loops (used by tests and debug) */
  getReviewerEmptyLoops(): Record<string, Record<string, number>>;
  /** Resolve expected skill for current workflow phase */
  getExpectedSkill(): string | null;
  /**
   * Recover from a FAILED compact: the agent's turn was aborted by ctx.compact(), so
   * deliver the full follow-up resume (reusing the session_compact assembly — new-phase
   * skill / task confirmation / todo details) + clear the re-entrancy guard. Injected into
   * triggerContextCompact callers as the ctx.compact({onError}) handler.
   */
  recoverCompactFailure(): void;
  /**
   * session_compact handler body: clear any pending deferred follow-up, then deliver
   * the stored follow-up for the compaction reason (or delegate to the subagent
   * compact path). Called by events/session/session-compact.ts.
   */
  onSessionCompact(event: { reason: "manual" | "threshold" | "overflow" }): Promise<void>;
  /**
   * session_shutdown handler body: clear any pending deferred follow-up so a deferred
   * inject never fires into a dead session. Called by events/session/session-shutdown.ts.
   */
  onSessionShutdown(): void;
}

/**
 * Guardrails module — handles tool_call and tool_result guardrail checks,
 * tracks verify-tests-passed state, pending violations, and branch tracking.
 * Consumed by PhaseReady, SessionLifecycle, and the orchestrator.
 */
/** Per-tool tool_result advisory: warnings to prepend to the tool's output
 * (TDD/process/pre-commit violations). */
export interface ToolResultAdvisory {
  warnings: string[];
  /** Workflow state changed — the router persists + refreshes the widget. */
  changed?: boolean;
}

/** Structural shape of a bash tool_result event (input.command + details.exitCode).
 * The SDK exports only the ToolResultEvent union, not the bash-specific member. */
export interface BashResultEvent {
  input: Record<string, unknown>;
  content: ReadonlyArray<{ type: string; text?: string }>;
  details: { exitCode?: number } | unknown;
}

/** Per-tool tool_call decision: block the call with a reason, or allow; optionally
 * signal that workflow state changed (router persists + refreshes the widget). */
export interface ToolCallDecision {
  /** Block the tool call with this reason; undefined/null to allow. */
  block?: string;
  /** Workflow state changed — the router persists + refreshes the widget. */
  changed?: boolean;
}

export interface IGuardrails {
  /** bash tool_call: fy-force-add block, publish gate, pre-commit discipline. */
  onBashCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallDecision>;
  /** write/edit tool_call: TDD check, verify flag reset, phase-write-restriction, doc activation. */
  onWriteEditCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallDecision>;
  /** phase_ready tool_call: subagent + implement-phase gating. */
  onPhaseReadyCall(event: ToolCallEvent): ToolCallDecision;
  /** task_ready_advance tool_call: subagent gating. */
  onTaskReadyAdvanceCall(event: ToolCallEvent): ToolCallDecision;
  /** read tool_result: log + record investigation. */
  onReadResult(event: ToolResultEvent): ToolResultAdvisory;
  /** write/edit tool_result: pending TDD violations + process warnings. */
  onWriteEditResult(toolCallId: string): ToolResultAdvisory;
  /** bash tool_result: record test outcome + verify flag, pending pre-commit warning. */
  onBashResult(event: BashResultEvent, toolCallId: string): ToolResultAdvisory;
  setVerifyTestsPassed(passed: boolean): void;
  isVerifyTestsPassed(): boolean;
  resetTracking(): void;
  /** Complete a code-review loop from a phase_ready({issuesFound, cannotFix}) call:
   *  record review history, track reviewer empty loops, then drive the loop
   *  decision + (UAT/finish) transition. The counts come from the fy-review
   *  skill. */
  completeCodeReviewLoop(
    ctx: ExtensionContext,
    issuesFound: number,
    cannotFixIssues: number,
    falsePositives: number,
  ): Promise<void>;
}

/**
 * PhaseReady module — phase_ready tool handler.
 * Design doc specifies this interface for DI consistency.
 * Called by SessionLifecycle (resetTracking on fy:reset).
 */
export interface IPhaseReady {
  resetTracking(): void;
}

/**
 * SessionLifecycle module — the bodies of the session_start (state branch) and
 * session_tree handlers as callable methods, plus the shared workflow reset.
 * Pure domain logic (no pi.on registration); the events/session/ routers call these.
 */
export interface ISessionLifecycle {
  /** session_start handler body (state branch). */
  onSessionStart(event: unknown, ctx: ExtensionContext): Promise<void>;
  /** session_tree handler body. */
  onSessionTree(ctx: ExtensionContext): Promise<void>;
  /** Shared reset logic used by /fy:reset, /resume session_start, and user-initiated /new. */
  performWorkflowReset(): void;
}

/** Re-export ViolationType from the closure scope — used by escalation tracking. */
export type ViolationType = "phase-write-restriction" | "tdd-write-order";

/**
 * AgentLifecycle module — the bodies of the agent_start and agent_end handlers as
 * callable methods. agent_start re-arms the finish guardrail + signals a fresh
 * agent turn; agent_end clears the guardrail, resets the phase_ready guard, flags
 * the agent finished (for compaction), and notifies the auto-agent on non-retryable
 * execution-phase errors. Pure domain logic (no pi.on registration); the
 * events/agent/ routers call these.
 */
export interface IAgentLifecycle {
  /** agent_start handler body. */
  onAgentStart(): Promise<void>;
  /** agent_end handler body. */
  onAgentEnd(
    event: { messages?: ReadonlyArray<{ role: string; stopReason?: string; errorMessage?: string }> },
    ctx: ExtensionContext,
  ): Promise<void>;
  /** agent_settled handler body — pi will not continue automatically. */
  onAgentSettled(): Promise<void>;
}

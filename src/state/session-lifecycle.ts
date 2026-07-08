// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Session lifecycle module — session_start + session_tree domain logic.
 *
 * Handles state reconstruction on reload/resume/fork, feature resumption,
 * branch gating, execution mode dialog, widget setup, and workflow reset.
 *
 * All factory-coupled dependencies are injected via SessionLifecycleDeps.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { syncWorktreeStatus } from "../git/worktrees/worktree-helpers.js";
import { setFinishPhaseWhitelisted } from "../git/worktrees/worktree-lifecycle.js";
import { notifyAutoAgentBlocked, notifyAutoAgentUnblocked } from "../kanban/auto-agent/auto-agent-notify.js";
import { log } from "../log.js";
import {
  clearActiveFeatureEnv,
  clearFeatureEnvVars,
  setActiveFeatureEnv,
  syncEnvVarsFromState,
} from "../phases/env-sync.js";
import { applyModelOverride } from "../phases/phase-transitions.js";
import { findLatestCustomEntry } from "../shared/session-entries.js";
import { NO_AGENT_NAME, NO_FEATURE_STATE_OVERRIDE } from "../shared/workflow-refs.js";
import type { ICompaction, IGuardrails, IPhaseReady, ISessionLifecycle } from "../shared/workflow-types.js";
import { withCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import { type FeatureSession, NO_ACTIVE_FEATURE_STATE } from "../state/feature-session.js";
import { NO_FEATURE_STATE, updateWidget } from "../ui/feature-flow-widget.js";
import { recoverArtifactsFromDisk, trackSessionFileInState } from "./feature-management.js";
import {
  DEFAULT_DIR,
  type ExpandSkillCommandFn,
  type FeatureState,
  stateFilePath as featureStateFilePath,
  loadFeatureState,
} from "./feature-state.js";
import {
  FEATURE_FLOW_STATE_ENTRY_TYPE,
  isSubagentSession,
  persistState,
  reconstructState,
} from "./state-persistence.js";

export interface SessionLifecycleDeps {
  pi: ExtensionAPI;
  handler: FeatureSession;
  compaction: ICompaction;
  guardrails: IGuardrails;
  phaseReady: IPhaseReady;
  expandSkillCommand: ExpandSkillCommandFn;
  applyModelOverrideForPhase: (pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>;
  /** Resolve base branch via UI dialog or auto-detection */
  resolveBaseBranch: (ctx: ExtensionContext) => Promise<string>;
  /** Ensure worktree exists for execution if branch policy requires it */
  ensureWorktreeForExecution: (featureState: FeatureState, ctx: ExtensionContext) => Promise<FeatureState>;
  /** Resolve loop index for a given stage */
  resolveLoopIndex: (stage: string) => number;
}

/**
 * Set the workflow-initiated new-session flag and optional pending message.
 */
export function setWorkflowInitiatedNewSession(message: string | null): void {
  if (globalThis.__piWorkflowMonitor) {
    globalThis.__piWorkflowMonitor.workflowInitiatedNewSession = true;
    if (message) globalThis.__piWorkflowMonitor.newSessionMessage = message;
  }
}

/** Read and clear the pending new-session message. Returns undefined if none. */
function consumeNewSessionMessage(): string | undefined {
  const msg = globalThis.__piWorkflowMonitor?.newSessionMessage;
  if (globalThis.__piWorkflowMonitor) globalThis.__piWorkflowMonitor.newSessionMessage = undefined;
  return msg ?? undefined;
}

/** Check and consume the workflow-initiated flag. Returns true if set, clears it. */
function consumeWorkflowInitiatedNewSession(): boolean {
  const value = globalThis.__piWorkflowMonitor?.workflowInitiatedNewSession === true;
  if (globalThis.__piWorkflowMonitor) globalThis.__piWorkflowMonitor.workflowInitiatedNewSession = undefined;
  return value;
}

/**
 * Create the session-lifecycle domain object: the bodies of the session_start
 * (state branch) and session_tree handlers as callable methods, plus the shared
 * workflow-reset. Pure domain logic — no pi.on registration.
 */
export function createSessionLifecycle(deps: SessionLifecycleDeps): ISessionLifecycle {
  const { pi, handler, compaction, guardrails, expandSkillCommand } = deps;

  const resetSessionTracking = () => {
    guardrails.resetTracking();
    compaction.resetTracking();
    deps.phaseReady.resetTracking();
  };

  const trackSessionFile = (ctx: ExtensionContext, slug: string) => {
    trackSessionFileInState(ctx, slug);
  };

  /**
   * Restore workflow state from session branch entries.
   */
  const restoreFromSessionEntries = (ctx: ExtensionContext): boolean => {
    const data = findLatestCustomEntry(ctx, FEATURE_FLOW_STATE_ENTRY_TYPE);
    if (data) {
      handler.setFullState(data);
      const slug = handler.getActiveFeatureSlug();
      if (slug) {
        setActiveFeatureEnv(slug);
      } else {
        clearActiveFeatureEnv();
      }
      syncEnvVarsFromState(handler);
      return true;
    }
    return false;
  };

  /**
   * Shared handler for session events that restore from session entries.
   */
  const restoreAndReset = async (
    ctx: ExtensionContext,
    { clearOnMissing }: { clearOnMissing: boolean },
  ): Promise<boolean> => {
    const restored = restoreFromSessionEntries(ctx);
    if (restored) {
      recoverArtifactsFromDisk(handler);
      resetSessionTracking();
      updateWidget(handler, NO_FEATURE_STATE);
      // Restore the worktree footer indicator from reconstructed state (lost on
      // reload/resume/fork). Cleared below when no active feature remains.
      syncWorktreeStatus(handler.getActiveFeatureState());
      return true;
    }
    if (clearOnMissing) {
      handler.resetState();
      clearActiveFeatureEnv();
      resetSessionTracking();
      updateWidget(handler, NO_FEATURE_STATE);
      syncWorktreeStatus(handler.getActiveFeatureState());
      return true;
    }
    return false;
  };

  /**
   * Shared reset logic used by /ff:reset, /resume session_start, and user-initiated /new.
   */
  function performWorkflowReset(): void {
    setFinishPhaseWhitelisted(false);
    handler.setActiveFeatureState(NO_ACTIVE_FEATURE_STATE);
    clearActiveFeatureEnv();
    clearFeatureEnvVars();
    handler.resetState();
    resetSessionTracking();
    persistState(pi, handler);
    updateWidget(handler, NO_FEATURE_STATE);
    syncWorktreeStatus(handler.getActiveFeatureState());
  }

  // --- session_start handler branches ---

  /**
   * Handle reload/startup: restore state from session entries when present.
   * On miss, keep state and fall through (env/file path for fresh subagents,
   * clearAndReset for a clean new session). Startup shares this because it
   * covers BOTH a clean new session (empty branch → miss → clean) AND opening
   * an existing one via `pi --session`/`--continue`/`--fork` (branch has the
   * feature entry → restore, like /resume). The forked-session copy also
   * carries entries into a fork subagent, so the host's point-in-time state is
   * restored there too.
   */
  async function handleReloadOrStartup(ctx: ExtensionContext): Promise<boolean> {
    return restoreAndReset(ctx, { clearOnMissing: false });
  }

  /** Handle resume/fork: restore state from session entries, clear if missing. */
  async function handleResumeOrFork(ctx: ExtensionContext): Promise<void> {
    await restoreAndReset(ctx, { clearOnMissing: true });
  }

  /**
   * Handle new session: if workflow-initiated, send pending followUp message;
   * otherwise if active feature exists, prompt user to continue or reset.
   */
  async function handleNewSession(ctx: ExtensionContext): Promise<boolean> {
    if (consumeWorkflowInitiatedNewSession()) {
      const pendingMessage = consumeNewSessionMessage();
      if (pendingMessage) {
        pi.sendUserMessage(expandSkillCommand(pendingMessage, NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME), {
          deliverAs: "followUp",
        });
      }
      return false; // do not continue to feature binding
    }
    if (process.env.PI_FF_FEATURE && !isSubagentSession()) {
      const slug = process.env.PI_FF_FEATURE;
      // Headless / non-interactive: no UI to prompt — proceed without the continue/reset dialog
      // (mirrors the hasUI guard c6fee0b9 added to resolveBaseBranch). The feature stays active;
      // a later interactive session can still offer the reset choice.
      if (!ctx.hasUI) {
        return false;
      }
      notifyAutoAgentBlocked(slug);
      const choice = await withCoordinator(() =>
        ctx.ui.select(`You have an active workflow (${slug}). Continue or reset?`, [
          `Continue: ${slug}`,
          "Reset workflow",
        ]),
      );
      notifyAutoAgentUnblocked(slug);
      if (choice === "Reset workflow") {
        performWorkflowReset();
        return true; // handled — stop processing
      }
    }
    return false;
  }

  /**
   * Bind feature from PI_FF_FEATURE env var: reconstruct state,
   * sync env vars, optionally resume last session, apply execution mode.
   */
  async function bindFeatureFromEnv(ctx: ExtensionContext): Promise<boolean> {
    const slug = process.env.PI_FF_FEATURE;
    if (!slug) return false;
    const stateFile = loadFeatureState(slug, DEFAULT_DIR);
    if (!stateFile) {
      log.warn(`PI_FF_FEATURE=${slug} but no state file found — clearing env var`);
      clearActiveFeatureEnv();
      return false;
    }

    log.info(`Feature binding from env var: ${slug}`);
    reconstructState(ctx, handler, featureStateFilePath(slug, DEFAULT_DIR));
    resetSessionTracking();
    updateWidget(handler, NO_FEATURE_STATE);
    syncWorktreeStatus(handler.getActiveFeatureState());
    syncEnvVarsFromState(handler);

    trackSessionFile(ctx, slug);

    if (!isSubagentSession()) {
      const ws = handler.getWorkflowState();
      if (ws?.currentPhase) {
        await applyModelOverride(pi, ctx, ws.currentPhase, deps.resolveLoopIndex(ws.currentPhase));
      }
    }

    const lastSession = stateFile.sessionFiles?.at(-1);
    if (lastSession && fs.existsSync(lastSession) && !isSubagentSession()) {
      notifyAutoAgentBlocked(slug);
      const choice = await withCoordinator(() =>
        ctx.ui.select(`Resume from last session? (${path.basename(lastSession)})`, [
          "Resume from last session",
          "Continue fresh",
        ]),
      );
      notifyAutoAgentUnblocked(slug);
      if (choice === "Resume from last session") {
        // The session_start runtime context carries command capabilities even though
        // the static event type is ExtensionContext; switchSession requires the command context.
        await (ctx as ExtensionCommandContext).switchSession(lastSession, {
          withSession: async (newCtx) => {
            newCtx.ui.notify(`Resumed session for: ${slug}`, "info");
          },
        });
        return true; // handled — session switched
      }
    }

    return true; // feature bound
  }

  /** Clear all feature state — used for headless sessions or clean starts. */
  function clearAndReset(): void {
    clearFeatureEnvVars();
    handler.resetState();
    resetSessionTracking();
    updateWidget(handler, NO_FEATURE_STATE);
    syncWorktreeStatus(handler.getActiveFeatureState());
  }

  // --- session_start handler body (state branch) ---
  async function onSessionStart(event: unknown, ctx: ExtensionContext): Promise<void> {
    setFinishPhaseWhitelisted(false);
    const reason = ((event as unknown as Record<string, unknown>).reason as string | undefined) ?? "startup";
    log.info(
      `session_start fired — reason=${reason}, hasUI=${ctx.hasUI}, PI_FF_FEATURE=${process.env.PI_FF_FEATURE ?? "unset"}`,
    );

    handler.setActiveFeatureState(NO_ACTIVE_FEATURE_STATE);

    if (reason === "reload" || reason === "startup") {
      if (await handleReloadOrStartup(ctx)) return;
    }

    if (reason === "resume" || reason === "fork") {
      await handleResumeOrFork(ctx);
      return;
    }

    if (reason === "new") {
      const resetHandled = await handleNewSession(ctx);
      if (resetHandled) return;
    }

    if (process.env.PI_FF_FEATURE) {
      const bound = await bindFeatureFromEnv(ctx);
      if (bound) return;
    }

    if (isSubagentSession()) {
      log.warn("Subagent session started without PI_FF_FEATURE — no feature loaded");
      clearAndReset();
      return;
    }

    clearAndReset();
  }

  // --- session_tree handler body ---
  async function onSessionTree(ctx: ExtensionContext): Promise<void> {
    await restoreAndReset(ctx, { clearOnMissing: true });
  }

  return { onSessionStart, onSessionTree, performWorkflowReset };
}

/**
 * Wire the globalThis workflow-monitor bridge hooks (requestWidgetUpdate,
 * performWorkflowReset) so non-event callers (widgets, commands) can trigger them.
 */
export function wireSessionLifecycleBridge(handler: FeatureSession, lifecycle: ISessionLifecycle): void {
  if (globalThis.__piWorkflowMonitor) {
    globalThis.__piWorkflowMonitor.requestWidgetUpdate = () => {
      // updateWidget now uses PiCtx for safe ctx access — no raw ctx needed
      updateWidget(handler, NO_FEATURE_STATE);
    };
    globalThis.__piWorkflowMonitor.performWorkflowReset = lifecycle.performWorkflowReset;
  }
}

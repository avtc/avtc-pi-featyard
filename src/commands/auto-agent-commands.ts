// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Register auto-agent commands (/fy:auto-agent, /fy:auto-worker, /fy:auto-designer, /fy:auto-pause)
 * + startAutoAgent + _activateFeature + polling/grace-period
 * + onFeatureComplete/onFeatureError/onBlock/onUnblock/onFeatureUatHandoff callbacks.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cleanupStoppedAgents } from "../kanban/auto-agent/auto-agent-cleanup.js";
import { GracePeriodManager } from "../kanban/auto-agent/auto-agent-grace-period.js";
import {
  activateFeature as _activateFeature,
  onFeatureComplete as _onFeatureComplete,
  type OnFeatureCompleteDeps,
} from "../kanban/auto-agent/auto-agent-lifecycle.js";
import {
  type AutoAgentRole,
  AutoAgentStateMachine,
  startAgentHeartbeat,
} from "../kanban/auto-agent/auto-agent-state-machine.js";
import { interactiveSessionIdFor, normalizeRepoPath } from "../kanban/data/kanban-database.js";
import type { Feature } from "../kanban/data/kanban-types.js";
import { DEFAULT_NOTIFY_LEVEL } from "../kanban/kanban-bridge.js";
import type { KanbanContext } from "../kanban/kanban-context.js";
import { log, NO_ERROR } from "../log.js";
import { getSettings } from "../settings/settings-ui.js";

/** Remove stopped/error agent reference so it doesn't block new agents. */
export async function registerAutoAgent(pi: ExtensionAPI, ctx: KanbanContext): Promise<void> {
  const { getDatabase, getTools, notify, requestWidgetUpdate } = ctx;

  /** Resolve the project for the current working directory, creating one if needed. */
  async function resolveProject(
    database: Awaited<ReturnType<typeof getDatabase>>,
  ): Promise<{ id: number; name: string } | null> {
    let cwd = process.cwd();
    try {
      const { resolveRepoPath } = await import("../kanban/data/kanban-detect-project.js");
      const resolved = await resolveRepoPath(process.cwd());
      log.info(`[kanban] resolveProject: git resolved repoPath="${resolved}", process.cwd()="${process.cwd()}"`);
      cwd = resolved;
    } catch (err) {
      log.warn(`[kanban] resolveProject: git resolution failed, using process.cwd()="${process.cwd()}": ${err}`);
    }
    let project = database.findProjectByRepoPath(cwd);
    if (!project) {
      const allProjects = database.listProjects();
      const targetBasename = basename(normalizeRepoPath(cwd));
      for (const p of allProjects) {
        if (!p.repo_path) continue;
        const storedBasename = basename(normalizeRepoPath(p.repo_path));
        if (storedBasename === targetBasename) {
          log.info(
            `[kanban] resolveProject: matched existing project ${p.id} "${p.name}" by basename (stored="${p.repo_path}", target="${cwd}")`,
          );
          project = p;
          break;
        }
      }
    }
    if (!project) {
      log.info(
        `[kanban] resolveProject: no project found for repoPath="${cwd}", auto-creating with name="${basename(cwd)}"`,
      );
      const newProjectId = database.createProject({ name: basename(cwd), repoPath: cwd });
      project = database.getProject(newProjectId);
    }
    if (project) {
      log.info(`[kanban] resolveProject: project ${project.id} "${project.name}" for repoPath="${cwd}"`);
    }
    return project;
  }

  /** True if the agent exists and is in a mutable (non-terminal) state.
   *
   * NOTE: distinct from the `isActive()` auto-agent callback (below). `isAgentLive`
   * answers "can this SM be mutated in place (role switch)?" — it is true for every
   * state except `stopped`/`error`, including `idle`. `isActive()` answers the
   * external "is auto-mode currently on?" question for skill-expansion / phase-ready
   * and excludes `idle`/`error`/`stopped`. The `idle` divergence is unreachable in
   * practice: an SM reaches the bridge only after `start()` succeeds (`idle`→
   * `working`), so a bridge agent is never `idle`. Kept as two helpers because they
   * serve genuinely different callers; do not collapse them without auditing both. */
  function isAgentLive(agent: AutoAgentStateMachine | null | undefined): agent is AutoAgentStateMachine {
    return !!agent && agent.getState() !== "stopped" && agent.getState() !== "error";
  }

  /** The configured wait-timeout duration for a role (single source of truth). */
  function waitTimeoutMsFor(role: AutoAgentRole): number | null {
    const settings = getSettings();
    return role === "worker" ? settings.autoWorkerWaitTimeoutMs : settings.autoDesignerWaitTimeoutMs;
  }

  /** Try to resume a paused agent of the same role+project. Returns true if resumed. */
  function tryResumePausedAgent(role: AutoAgentRole, projectId: number, agentCtx: ExtensionCommandContext): boolean {
    const current = globalThis.__piKanban?.autoAgent;
    if (current && current.getRole() === role && current.projectId === projectId && current.getState() === "paused") {
      current.unpause();
      globalThis.__piCtx?.refresh(agentCtx);
      const pollingFn = current.getStartPollingFn();
      if (pollingFn) pollingFn();
      agentCtx.ui.notify(`Auto-${role} resumed`, "info");
      requestWidgetUpdate();
      return true;
    }
    return false;
  }

  /** Check if a worker is already running for the given project. Returns error message or null. */
  function checkWorkerNotRunning(projectId: number): string | null {
    const current = globalThis.__piKanban?.autoAgent;
    if (current && current.getRole() === "worker" && current.projectId === projectId && isAgentLive(current)) {
      return "An auto-worker is already running for this project. Pause it with /fy:auto-pause first.";
    }
    return null;
  }

  /** Try to match current session's active slug to a kanban feature. Returns true if matched. */
  async function tryMatchSessionSlug(
    sm: AutoAgentStateMachine,
    projectId: number,
    sessionId: string,
    agentCtx: ExtensionCommandContext,
  ): Promise<boolean> {
    try {
      const { getActiveFeatureSlug } = await import("../index.js");
      const activeSlug = process.env.PI_FY_FEATURE ?? getActiveFeatureSlug();
      if (!activeSlug) return false;
      const database = await getDatabase();
      const feature = database.findFeatureBySlug(activeSlug, projectId);
      if (!feature || !sm.getLanes().includes(feature.lane)) return false;
      // Handle existing lock
      if (feature.locked_at) {
        if (feature.locked_by_session === interactiveSessionIdFor(activeSlug)) {
          database.unlockFeature(feature.id);
        } else {
          agentCtx.ui.notify(
            `Feature ${activeSlug} is locked by another session. Release the lock on the kanban board first.`,
            "warning",
          );
        }
      }
      const locked = database.lockFeature(feature.id, sessionId);
      if (locked) {
        sm.adoptFeature(feature.id, feature.lane);
        database.updateFeature({ featureId: feature.id, assignedSession: sessionId });
        startAgentHeartbeat(sm, feature.id, getTools);
        log.info(`[kanban] tryMatchSessionSlug: matched active slug "${activeSlug}" to kanban feature ${feature.id}`);
        agentCtx.ui.notify(`Auto-${sm.getRole()} locked existing feature: "${feature.title}"`, "info");
        requestWidgetUpdate();
        return true;
      }
    } catch (err) {
      log.warn(`[kanban] tryMatchSessionSlug: session-slug matching failed, falling back to normal pick: ${err}`);
    }
    return false;
  }

  async function startAutoAgent(role: AutoAgentRole, agentCtx: ExtensionCommandContext): Promise<void> {
    const database = await getDatabase();
    const project = await resolveProject(database);
    if (!project) {
      agentCtx.ui.notify("Failed to create project. Please try again.", "error");
      return;
    }
    const projectId = project.id;
    const sessionId = crypto.randomUUID();

    // Pause-resume: if a paused agent of the same role+project exists, unpause it
    if (tryResumePausedAgent(role, projectId, agentCtx)) return;

    // Check if the same role is already running — no-op
    const currentAgent = globalThis.__piKanban?.autoAgent;
    if (currentAgent && currentAgent.getRole() === role && isAgentLive(currentAgent)) {
      agentCtx.ui.notify(`Auto-${role} already running`, "warning");
      return;
    }

    // Single-worker enforcement (scoped per project)
    if (role === "worker") {
      const workerError = checkWorkerNotRunning(projectId);
      if (workerError) {
        agentCtx.ui.notify(workerError, "error");
        return;
      }
    }

    // Role switch: a different-role agent is already running. Mutate its role
    // in place instead of tearing it down and recreating it. This preserves the
    // current feature, its lock (same sessionId UUID), all timers, and the
    // callback/overlay wiring — so the user's in-flight feature is not orphaned
    // or double-locked. The next feature pick uses the new role's lanes.
    if (currentAgent && currentAgent.getRole() !== role && isAgentLive(currentAgent)) {
      const wasPaused = currentAgent.getState() === "paused";
      globalThis.__piCtx?.refresh(agentCtx);
      currentAgent.setRole(role);
      // Refresh the wait-timeout duration to the new role's configured value
      // (the onTimeout callback itself is role-agnostic: it reads sm.getRole() at fire time).
      currentAgent.setWaitTimeoutMs(waitTimeoutMsFor(role));
      if (wasPaused) {
        // A paused agent is resumed by re-running a role command (mirrors the
        // same-role resume path, tryResumePausedAgent). Switching its role resumes
        // it too, so one command yields a running agent of the new role (rather
        // than leaving it paused and forcing a second command to resume).
        currentAgent.unpause();
        const pollingFn = currentAgent.getStartPollingFn();
        if (pollingFn) pollingFn();
        agentCtx.ui.notify(`Auto-${role} resumed`, "info");
      } else {
        agentCtx.ui.notify(`Auto-${role} started`, "info");
      }
      requestWidgetUpdate();
      return;
    }

    const sm = new AutoAgentStateMachine(role, projectId, sessionId);
    if (!sm.start()) {
      agentCtx.ui.notify(`Auto-${role} already running`, "warning");
      return;
    }
    // Stash session functions from the command handler agentCtx so the initial
    // feature pick (and subsequent polling) can use them.
    globalThis.__piCtx?.refresh(agentCtx);
    // Stash notify for timer callbacks (polling, grace period) — handled by PiCtx
    // Register terminal input listener for activity detection (persists across sessions)
    const unsubscribeInput = agentCtx.ui.onTerminalInput(() => {
      const gpm = globalThis.__piKanban?.gracePeriod as GracePeriodManager | undefined;
      gpm?.onUserActivity();
    });
    if (globalThis.__piKanban) globalThis.__piKanban.terminalInputUnsubscribe = unsubscribeInput;
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = sm;

    agentCtx.ui.notify(`Auto-${role} started`, "info");

    // Wire overlay callback for waiting-for-response status
    // (must be before session-slug matching so it's available on early return)
    sm.setOverlayCallback((featureId, status) => {
      try {
        // Access database synchronously via the bridge (already initialized by this point)
        const db = globalThis.__piKanban?.database;
        if (!db) return;
        if (status) {
          db.setOverlayStatus(featureId, status);
        } else {
          db.clearOverlayStatus(featureId);
        }
      } catch (err) {
        log.warn(`[kanban] overlay status update failed: ${err}`);
      }
    });

    /**
     * Thin wrapper around the extracted activateFeature function.
     * Binds closure-captured dependencies to the extracted module-level function.
     */
    const activateFeature = async (
      result: { feature: Feature; skill: string; kanbanFeatureId: number },
      piCtx: { sendUserMessage: (msg: string, options?: { deliverAs?: "steer" | "followUp" }) => void },
    ): Promise<void> => {
      return _activateFeature(result, piCtx, {
        database,
        sm,
        getTools,
        activateWorkflowForFeature: ctx.activateWorkflowForFeature,
        resumeWorkflowForFeature: ctx.resumeWorkflowForFeature,
        setWorkflowInitiatedNewSession: ctx.setWorkflowInitiatedNewSession,
      });
    };
    // Store on globalThis so callbacks registered by previous module instances
    // (before extension reload) can still call it. Without this, the closure
    // reference breaks when jiti reloads the module via ctx.newSession().
    if (globalThis.__piKanban) globalThis.__piKanban.activateFeature = activateFeature;

    // Session-slug matching: if the current session already has an active feature,
    // look it up in kanban and lock it instead of picking a new one.
    if (await tryMatchSessionSlug(sm, projectId, sessionId, agentCtx)) return;

    // Wire wait timeout and autoOnBlock behavior. getSettings() is the cached,
    // in-memory accessor (same source as waitTimeoutMsFor above) — avoids the
    // 2x sync readFileSync+parse that loadSettingsFromFiles would do here.
    const settings = getSettings();
    const timeoutMs = waitTimeoutMsFor(role);
    const autoOnBlock = settings.autoOnBlock;
    const onWaitTimeout: (featureId: number, reason: "timeout") => void = (featureId, _reason) => {
      if (autoOnBlock === "wait") {
        // Keep waiting — restart the timeout
        sm.startWaitTimeoutForFeature(featureId);
        log.info("[kanban] auto-agent wait timeout expired (autoOnBlock=wait), restarting timer");
        return;
      }
      // autoOnBlock === "switch": release lock, clear overlay, take next feature
      log.info("[kanban] auto-agent wait timeout expired (autoOnBlock=switch), switching to next feature");
      const originalLane = sm.getCurrentFeatureLane() ?? "ready";
      // Use promise chain to handle async operations
      getTools()
        .then(async (tools) => {
          sm.unblock(); // This clears overlay via callback
          tools.kanbanMove({
            featureId,
            toLane: originalLane,
            changedBy: `agent:${sessionId}`,
            note: "Wait timeout expired",
          });
          tools.kanbanRelease({ featureId });
          const next = sm.pickNextFeature(tools, projectId, sessionId);
          if (next) {
            await activateFeature(next, pi);
          }
        })
        .catch((err) => {
          log.warn(`[kanban] auto-agent switch failed: ${err}`);
          sm.error(String(err));
          notify(`❌ Auto-${sm.getRole()} error: ${err}`, "error");
          requestWidgetUpdate();
        });
    };
    // Wait timeout is started after a feature is successfully picked (not here)

    sm.setWaitTimeoutConfig(timeoutMs, onWaitTimeout);

    // Polling timer: when no feature is available, retry after autoPollMs
    function startPollingTimer() {
      const pollMs = getSettings().autoPollMs ?? 30_000;
      const timer = setTimeout(async () => {
        if (sm.getState() !== "polling") return;
        log.info(
          `[kanban] auto-agent (${sm.getRole()}) polling timer fired, retrying feature pick (project=${projectId})`,
        );
        try {
          const kanbanTools = await getTools();

          // Peek first to check lane without locking
          const peeked = kanbanTools.kanbanPeek({ projectId, lanes: sm.getLanes() });
          if (!peeked) {
            // Still no features — keep polling
            startPollingTimer();
            return;
          }

          // Grace period for design lane features
          // Note: peeked feature may differ from the feature ultimately locked on expire.
          // kanbanPeek is read-only; pickNextFeature on expire does its own search.
          if (peeked.lane === "design") {
            const gpm = createGracePeriodManager(sm, kanbanTools);
            gpm.start();
            sm.enterGracePeriod(); // after GPM created — avoids stuck state if constructor fails
            notify(
              `🔄 Auto-${sm.getRole()} found new feature in design lane. Starting in 30s...`,
              DEFAULT_NOTIFY_LEVEL,
            );
            return;
          }

          // Non-design lane: immediate activation (existing behavior)
          sm.featureFound();
          const result = sm.pickNextFeature(kanbanTools, projectId, sessionId);
          if (result) {
            log.info(
              `[kanban] auto-agent (${sm.getRole()}) polling: picked feature "${result.feature.title}" (id=${result.kanbanFeatureId})`,
            );
            notify(`🔄 Auto-${sm.getRole()} found new feature. Activating...`, DEFAULT_NOTIFY_LEVEL);
            await activateFeature(result, pi);
          } else {
            // Still no feature — keep polling
            log.info(`[kanban] auto-agent (${sm.getRole()}) polling: still no features, scheduling next poll`);
            startPollingTimer();
          }
        } catch (err) {
          log.error(`[kanban] auto-agent (${sm.getRole()}) polling pick failed (project=${projectId})`, err);
          sm.error(String(err));
          notify(`❌ Auto-${sm.getRole()} error: ${err}`, "error");
          requestWidgetUpdate();
        }
      }, pollMs);
      // Track timer for cleanup on stop
      sm.setPollingTimer(timer);
    }

    function createGracePeriodManager(
      sm: AutoAgentStateMachine,
      kanbanTools: import("../kanban/kanban-operations.js").KanbanTools,
    ): GracePeriodManager {
      // Stop any previous GPM for this agent (defensive — shouldn't happen in normal flow)
      const prevGpm = globalThis.__piKanban?.gracePeriod as { stop?: () => void } | undefined;
      if (prevGpm) prevGpm.stop?.();

      const gpm = new GracePeriodManager(
        // onExpired
        async () => {
          // Guard: if agent left grace-period state (error, stop, pause), don't activate
          if (sm.getState() !== "grace-period") return;
          sm.exitGracePeriod();
          const projectId = sm.projectId;
          if (projectId === undefined) return;
          const result = sm.pickNextFeature(kanbanTools, projectId, sm.sessionId);
          if (result) {
            notify("⏰ Grace period ended. Activating next feature...", DEFAULT_NOTIFY_LEVEL);
            await activateFeature(result, pi);
          } else {
            // pickNextFeature already transitioned to polling via noFeatureAvailable()
            startPollingTimer();
          }
        },
        // onTick
        () => {
          const requestUpdate = globalThis.__piWorkflowMonitor?.requestWidgetUpdate;
          requestUpdate?.();
        },
        // onEnd
        () => {
          if (globalThis.__piKanban?.gracePeriod === gpm) {
            if (globalThis.__piKanban) globalThis.__piKanban.gracePeriod = undefined;
          }
        },
        { durationMs: 30_000 },
      );
      if (globalThis.__piKanban) globalThis.__piKanban.gracePeriod = gpm;
      return gpm;
    }

    // Expose on globalThis so onFeatureComplete callback (at kanbanExtension top level)
    // can create grace period managers. Same pattern as globalThis.__piKanban.activateFeature.
    if (globalThis.__piKanban) globalThis.__piKanban.createGracePeriodManager = createGracePeriodManager;

    // Register polling function on state machine so onFeatureComplete can access it
    sm.setStartPollingFn(startPollingTimer);

    // Kick off the first feature pick
    try {
      log.info(
        `[kanban] auto-agent (${sm.getRole()}): starting initial feature pick for project ${projectId}, lanes: [${sm.getLanes().join(", ")}]`,
      );
      const kanbanTools = await getTools();
      const result = sm.pickNextFeature(kanbanTools, projectId, sessionId);
      if (result) {
        log.info(
          `[kanban] auto-agent (${sm.getRole()}): picked feature "${result.feature.title}" (id=${result.kanbanFeatureId}, slug="${result.feature.slug}", lane="${result.feature.lane}", description=${result.feature.description ? "present" : "MISSING"})`,
        );
        await activateFeature(result, pi);
      } else {
        // No feature available — pickNextFeature already transitioned to polling
        startPollingTimer();
        requestWidgetUpdate();
        const pollMs = getSettings().autoPollMs ?? 30_000;
        log.info(
          `[kanban] auto-agent (${sm.getRole()}): no features available at startup (project=${projectId}, lanes=[${sm.getLanes().join(", ")}]), polling every ${pollMs}ms`,
        );
      }
    } catch (err) {
      log.error(`[kanban] auto-agent (${sm.getRole()}) initial pick failed (project=${projectId})`, err);
      sm.error(String(err));
      notify(`❌ Auto-${sm.getRole()} error: ${err}`, "error");
      requestWidgetUpdate();
    }
  }

  pi.registerCommand("fy:auto-agent", {
    description: "Start autonomous loop: picks from design and ready lanes",
    async handler(_args, cmdCtx) {
      await startAutoAgent("agent", cmdCtx);
    },
  });

  pi.registerCommand("fy:auto-worker", {
    description: "Start autonomous loop: picks from ready lane only",
    async handler(_args, cmdCtx) {
      await startAutoAgent("worker", cmdCtx);
    },
  });

  pi.registerCommand("fy:auto-designer", {
    description: "Start autonomous loop: picks from design lane only",
    async handler(_args, cmdCtx) {
      await startAutoAgent("designer", cmdCtx);
    },
  });

  pi.registerCommand("fy:auto-pause", {
    description: "Pause auto-loop (keeps current feature, heartbeat alive)",
    async handler(_args, cmdCtx) {
      const current = globalThis.__piKanban?.autoAgent;
      if (!current || current.getState() === "stopped" || current.getState() === "error") {
        cmdCtx.ui.notify("No auto-agent running", "warning");
        return;
      }
      // Resolve current project to scope pause to this project only
      try {
        const db = await getDatabase();
        let cwd = process.cwd();
        try {
          const { resolveRepoPath } = await import("../kanban/data/kanban-detect-project.js");
          cwd = await resolveRepoPath(process.cwd());
        } catch (err) {
          log.warn(`[kanban] auto-pause: git resolution failed, using process.cwd(): ${err}`);
        }
        const project = db.findProjectByRepoPath(cwd);
        if (project && current.projectId !== project.id) {
          cmdCtx.ui.notify("No auto-agent running for this project", "warning");
          return;
        }
      } catch (err) {
        log.warn(`[kanban] auto-pause: database unavailable, pausing agent anyway: ${err}`);
      }
      current.pause();
      // Stop grace period manager if active
      const gpm = globalThis.__piKanban?.gracePeriod as GracePeriodManager | undefined;
      if (gpm) {
        gpm.stop();
        notify("Auto-agent paused. Grace period cancelled.", DEFAULT_NOTIFY_LEVEL);
      }
      cmdCtx.ui.notify("Auto-loop paused (heartbeat stays, no auto-next-feature)", "info");
      requestWidgetUpdate();
    },
  });

  // Wire cross-extension callbacks so workflow-monitor can notify kanban
  // Auto-agent callback: workflow-monitor calls this on feature completion
  const { setAutoAgentCallback } = await import("../kanban/auto-agent/auto-agent-state-machine.js");
  const onFCtx: OnFeatureCompleteDeps = {
    getDatabase,
    getTools,
    notify,
    pi,
    activateWorkflowForFeature: ctx.activateWorkflowForFeature,
    resumeWorkflowForFeature: ctx.resumeWorkflowForFeature,
    setWorkflowInitiatedNewSession: ctx.setWorkflowInitiatedNewSession,
  };
  setAutoAgentCallback({
    async onFeatureComplete(slug: string): Promise<void> {
      return _onFeatureComplete(slug, onFCtx);
    },
    async onFeatureError(slug: string, error: string): Promise<void> {
      log.warn(`[kanban] onFeatureError called for slug "${slug}": ${error}`);
      const { findAgentForSlug } = await import("./kanban-commands.js");
      const current = globalThis.__piKanban?.autoAgent;
      const match = current
        ? await findAgentForSlug(slug, current, getDatabase, { state: ["working", "paused"] })
        : null;
      if (match) {
        const { sm, featureId } = match;
        log.warn(`[kanban] auto-agent error on ${slug}: ${error}`);
        sm.handleFeatureTransientError(featureId, error);
        requestWidgetUpdate();
      } else {
        log.warn(`[kanban] onFeatureError: no agent found for slug "${slug}"`);
      }
      cleanupStoppedAgents();
    },
    async onBlock(slug: string): Promise<void> {
      const { findAgentForSlug } = await import("./kanban-commands.js");
      const current = globalThis.__piKanban?.autoAgent;
      const match = current ? await findAgentForSlug(slug, current, getDatabase, { state: "working" }) : null;
      if (!match) {
        log.info(`[kanban] onBlock: no working agent found for slug "${slug}"`);
        return;
      }
      match.sm.block();
      log.info(`[kanban] auto-agent blocked on ${slug}, waiting for user input`);
      requestWidgetUpdate();
    },
    async onUnblock(slug: string): Promise<void> {
      const { findResumableAgent } = await import("./kanban-commands.js");
      const current = globalThis.__piKanban?.autoAgent;
      const match = current ? await findResumableAgent(slug, current, getDatabase) : null;
      if (!match) {
        log.info(`[kanban] onUnblock: no waiting agent found for slug "${slug}"`);
        return;
      }
      match.sm.unblock();
      log.info(`[kanban] auto-agent unblocked on ${slug}, resuming work`);
      requestWidgetUpdate();
    },
    async onFeatureUatHandoff(slug: string): Promise<void> {
      log.info(`[kanban] onFeatureUatHandoff called for slug "${slug}"`);
      const current = globalThis.__piKanban?.autoAgent;
      if (current) {
        log.info(
          `[kanban] onFeatureUatHandoff: agent state=${current.getState()}, featureId=${current.getCurrentFeatureId()}, role=${current.getRole()}`,
        );
      }
      const { findAnyActiveAgent } = await import("./kanban-commands.js");
      const match = current ? await findAnyActiveAgent(slug, current, getDatabase) : null;
      log.info(`[kanban] onFeatureUatHandoff: findAnyActiveAgent result=${match ? "found" : "not found"}`);
      if (!match) {
        log.warn(`[kanban] onFeatureUatHandoff: no agent found for slug "${slug}" — feature will stay locked`);
        return;
      }
      if (match.sm.projectId === undefined) {
        log.warn(`[kanban] onFeatureUatHandoff: agent for slug "${slug}" has undefined projectId`);
        return;
      }
      const { sm, featureId } = match;
      log.info(
        `[kanban] onFeatureUatHandoff: found agent for slug "${slug}", featureId=${featureId}, role=${sm.getRole()}`,
      );

      try {
        const tools = await getTools();
        const projectId = sm.projectId;
        if (projectId === undefined) {
          log.warn("[kanban] UAT handoff: state machine has no projectId");
          return;
        }
        const nextFeature = sm.handleFeatureUatHandoff(tools, featureId, sm.sessionId, projectId);
        if (nextFeature) {
          log.info(
            `[kanban] onFeatureUatHandoff: picked next feature "${nextFeature.feature.title}" (id=${nextFeature.kanbanFeatureId})`,
          );
          const doActivate = globalThis.__piKanban?.activateFeature;
          if (!doActivate) {
            log.error("[kanban] activateFeature not available on __piKanban bridge", NO_ERROR);
            return;
          }
          await doActivate(nextFeature, pi);
          return;
        }
        log.info(`[kanban] onFeatureUatHandoff: no next feature available after "${slug}"`);
      } catch (err) {
        log.error(`[kanban] onFeatureUatHandoff: handleFeatureUatHandoff failed for slug "${slug}"`, err);
      }
      const pollingFn = sm.getStartPollingFn();
      if (pollingFn) pollingFn();
      log.info("[kanban] auto-agent: no more features available after UAT handoff, polling...");
      cleanupStoppedAgents();
    },
    isActive(): boolean {
      const sm = globalThis.__piKanban?.autoAgent;
      if (!sm) return false;
      const s = sm.getState();
      return s === "working" || s === "polling" || s === "waiting" || s === "paused" || s === "grace-period";
    },
  });
}

// === UAT command (fy:auto-stop) — merged from uat-commands.ts ===

/**
 * UAT-related commands.
 *
 * UAT is a collaborative phase: the agent works WITH the user to fix issues in
 * place, and the user advances out of UAT via /fy:next (which routes one step,
 * uat-aware, including terminal completion). This module registers /fy:auto-stop.
 */

import type { FeatureSession } from "../state/feature-session.js";
import { persistState } from "../state/state-persistence.js";
import { NO_FEATURE_STATE, updateWidget } from "../ui/featyard-widget.js";

export interface UatCommandDeps {
  handler: FeatureSession;
  getExpectedSkill: () => string | null;
  getAutoAgentCallback: () => import("../kanban/auto-agent/auto-agent-state-machine.js").AutoAgentCallback | null;
}

export function registerUatCommands(pi: ExtensionAPI, deps: UatCommandDeps): void {
  const { handler } = deps;

  // --- Continue Interactive Command ---
  // Allows user to manually unblock a conversation that was waiting for auto-agent.
  // Clears any auto-agent waiting state and continues the session interactively.
  pi.registerCommand("fy:auto-stop", {
    description: "Stop the auto-agent and resume interactive control (detaches auto-agent, no skill re-dispatch)",
    async handler(_args, ctx: ExtensionCommandContext) {
      globalThis.__piCtx?.refresh(ctx);

      const slug = handler.getActiveFeatureSlug();

      // Stop the auto-agent and hand control back to the user. The feature the
      // agent was working on is NOT released or moved — instead its lock is
      // reassigned from the agent's session UUID to the interactive identity
      // `session:<slug>`. Interactive locks are never swept by cleanupExpiredLocks,
      // so the lock survives indefinitely (user can step away, or pi can crash)
      // until the user releases it on the kanban board or starts an auto-agent in
      // this session, at which point tryMatchSessionSlug reassigns it back to a UUID.
      const current = globalThis.__piKanban?.autoAgent;
      if (current) {
        const featureId = current.getCurrentFeatureId();
        const agentSessionId = current.sessionId;
        // requestStop is immediate: clears heartbeat/polling/wait timers, clears
        // any waiting-for-response overlay, transitions to "stopped".
        current.requestStop();

        // requestStop does not own the GracePeriodManager (it is stopped externally
        // by its caller — see /fy:auto-pause). If the agent was in grace-period state,
        // stop the GPM too so its setInterval doesn't keep ticking widget updates
        // for up to 30s after the user stopped the agent (requirement: clear timers
        // from any state). Mirrors the /fy:auto-pause GPM stop.
        globalThis.__piKanban?.gracePeriod?.stop();

        // Reassign the agent-held lock to the interactive identity so it persists
        // without a heartbeat. Use the feature's own slug (source of truth) rather
        // than the session's active slug, so the lock identity always matches the
        // feature — this mirrors how tryMatchSessionSlug looks the feature up by slug
        // and will reassign it back to a UUID when an auto-agent starts here.
        // Each failure path is logged (not silent) so a lost lock is observable.
        if (featureId !== null) {
          const { getDatabaseInstance } = await import("../kanban/kanban-bridge.js");
          const { interactiveSessionIdFor } = await import("../kanban/data/kanban-database.js");
          const db = getDatabaseInstance();
          const feature = db?.getFeature(featureId) ?? null;
          if (!db) {
            log.warn("[auto-stop] kanban database unavailable; feature lock not reassigned");
          } else if (!feature) {
            log.warn(`[auto-stop] feature ${featureId} not found; lock not reassigned`);
          } else if (!feature.slug) {
            // A slugless feature has no stable interactive identity; the lock stays
            // under the agent UUID and will be swept on the next activation.
            log.warn(
              `[auto-stop] feature ${featureId} has no slug; cannot form an interactive lock identity, ` +
                "lock left under the agent and will expire",
            );
          } else {
            const interactiveSession = interactiveSessionIdFor(feature.slug);
            if (db.reassignLock(featureId, agentSessionId, interactiveSession)) {
              db.updateFeature({ featureId, assignedSession: interactiveSession });
            } else {
              log.warn(`[auto-stop] lock on feature ${featureId} not held by agent ${agentSessionId}; not reassigned`);
            }
          }
        }
      }
      const { NO_AUTO_AGENT_CALLBACK, setAutoAgentCallback } = await import(
        "../kanban/auto-agent/auto-agent-state-machine.js"
      );
      setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
      const { cleanupStoppedAgents } = await import("../kanban/auto-agent/auto-agent-cleanup.js");
      cleanupStoppedAgents();

      if (ctx.hasUI) {
        const phase = handler.getActiveFeatureState()?.workflow.currentPhase ?? null;
        ctx.ui.notify?.(
          phase
            ? `Auto-agent stopped. Interactive control resumed (${phase} phase).`
            : slug
              ? "Auto-agent stopped. Interactive control resumed."
              : "No active feature. Auto-agent stopped.",
          "info",
        );
      }

      persistState(pi, handler);
      updateWidget(handler, NO_FEATURE_STATE);
    },
  });
}

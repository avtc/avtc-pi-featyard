// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Auto-agent feature lifecycle functions.
 *
 * Each function receives its dependencies explicitly rather than via closure.
 */

import * as fs from "node:fs";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log, NO_ERROR } from "../../log.js";
import { clearActiveFeatureEnv } from "../../phases/env-sync.js";
import { type Phase, SKILL_TO_PHASE } from "../../phases/phase-progression.js";
import { expandSkillCommand } from "../../prompts/skill-block-builder.js";
import { substitutePlaceholders } from "../../prompts/template-engine.js";
import { getSettings } from "../../settings/settings-ui.js";
import { trackSessionFileInState } from "../../state/feature-management.js";
import type { FeatureState } from "../../state/feature-state.js";
import type { KanbanDatabase } from "../data/kanban-database.js";
import type { Feature } from "../data/kanban-types.js";
import { DEFAULT_NOTIFY_LEVEL } from "../kanban-bridge.js";
import type { KanbanTools } from "../kanban-operations.js";
import { cleanupStoppedAgents } from "./auto-agent-cleanup.js";
import type { GracePeriodManager } from "./auto-agent-grace-period.js";
import { type AutoAgentStateMachine, computeTargetLane, startAgentHeartbeat } from "./auto-agent-state-machine.js";

/** Compute the skill-injection message for a freshly-matched feature: resolves the target phase + builds the expandSkillCommand text (skill + feature title + optional description). Shared by the two activate paths. */
function buildFeatureActivationMessage(
  result: { feature: Feature; skill: string },
  substituteFn: (text: string) => string,
): { targetPhase: Phase; skillMessage: string } {
  const targetPhase: Phase = SKILL_TO_PHASE[result.skill] ?? "design";
  const desc = result.feature.description ? `\n${result.feature.description}` : "";
  const skillMessage = expandSkillCommand(
    `/skill:${result.skill} Work on feature: ${result.feature.title}${desc}`,
    substituteFn,
  );
  return { targetPhase, skillMessage };
}

// --- Constants ---

/** Lanes where features enter the workflow (need skill injection) */
const ENTRY_LANES = new Set(["design", "ready"]);

/** Type for the createGracePeriodManager factory stored on globalThis */
type CreateGracePeriodManagerFn = (sm: AutoAgentStateMachine, tools: KanbanTools) => GracePeriodManager;

// --- Context types for extracted functions ---

/** Shared workflow-lifecycle callbacks injected into both ActivateFeatureDeps and OnFeatureCompleteDeps. */
export interface WorkflowLifecycleDeps {
  activateWorkflowForFeature: (slug: string, phase: Phase, ctx: ExtensionContext | null) => Promise<void>;
  resumeWorkflowForFeature: (slug: string, ctx: ExtensionContext | null) => Promise<FeatureState | null>;
  setWorkflowInitiatedNewSession: (message: string | null) => void;
}

/** Dependencies needed by activateFeature */
export interface ActivateFeatureDeps extends WorkflowLifecycleDeps {
  database: KanbanDatabase;
  sm: AutoAgentStateMachine;
  getTools: () => Promise<KanbanTools>;
}

/** Dependencies needed by onFeatureComplete */
export interface OnFeatureCompleteDeps extends WorkflowLifecycleDeps {
  getDatabase: () => Promise<KanbanDatabase>;
  getTools: () => Promise<KanbanTools>;
  notify: (msg: string, level: "info" | "warning" | "error") => void;
  pi: ExtensionAPI;
}

// --- Extracted functions ---

/**
 * Run an auto-agent-initiated session replacement (newSession/switchSession) with the
 * autoAgentInitiatingReplacement flag held high. session_start fires (via rebind, before
 * withSession) while this flag is set, so the kanban session_start handler treats the
 * replacement as auto-initiated and does not pause the orphaned agent. The flag clears
 * on settle — by then withSession has refreshed __piCtx with a live command context.
 */
function withAutoAgentReplacement<T>(fn: () => Promise<T>): Promise<T> {
  if (globalThis.__piKanban) globalThis.__piKanban.autoAgentInitiatingReplacement = true;
  return fn().finally(() => {
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgentInitiatingReplacement = false;
  });
}

/**
 * Common helper: start heartbeat, wait timeout, bootstrap feature state,
 * load existing session if available, and inject skill for entry lanes.
 */
export async function activateFeature(
  result: { feature: Feature; skill: string; kanbanFeatureId: number },
  piCtx: { sendUserMessage: (msg: string, options?: { deliverAs?: "steer" | "followUp" }) => void },
  deps: ActivateFeatureDeps,
): Promise<void> {
  const {
    database,
    sm,
    getTools,
    activateWorkflowForFeature,
    resumeWorkflowForFeature,
    setWorkflowInitiatedNewSession,
  } = deps;

  // Use session guard (refreshed by session_start events and withSession callbacks)
  // instead of captured agentCtx — agentCtx goes stale after newSession/switchSession.
  const guard = globalThis.__piCtx;
  const ctx = {
    switchSession: guard?.switchSession,
    newSession: guard?.newSession,
    sessionManager: guard?.sessionManager,
  };
  // Clean up expired locks from crashed agents before activating
  try {
    const timeoutMs = getSettings().autoLockTimeoutMs ?? 1_800_000;
    const cleaned = database.cleanupExpiredLocks(timeoutMs);
    if (cleaned > 0) {
      log.info(`[kanban] cleaned up ${cleaned} expired lock(s)`);
    }
  } catch (err) {
    log.warn(`[kanban] expired lock cleanup failed: ${err}`);
  }
  startAgentHeartbeat(sm, result.kanbanFeatureId, getTools);

  const slug = result.feature.slug;
  if (!slug) {
    log.warn("[kanban] activateFeature: feature has no slug, skipping activation");
    return;
  }
  const originalLane = sm.getCurrentFeatureLane() ?? result.feature.lane;
  const isEntryLane = ENTRY_LANES.has(originalLane);

  // Bootstrap feature state file from kanban if it doesn't exist yet
  let existingState: FeatureState | null = null;
  try {
    const { loadFeatureState, saveFeatureState, createFeatureStateFromKanban, stateDir, stateFilePath } = await import(
      "../../state/feature-state.js"
    );
    existingState = loadFeatureState(slug, stateDir());
    if (!existingState) {
      const state = createFeatureStateFromKanban(slug, { lane: result.feature.lane, branch: null, worktreePath: null });
      state.featureId = result.kanbanFeatureId;
      saveFeatureState(state, stateDir());
      existingState = state;
    } else if (existingState.featureId === null) {
      // Backfill kanbanFeatureId for state files created before kanban tracking
      existingState.featureId = result.kanbanFeatureId;
      saveFeatureState(existingState, stateDir());
      log.info(`[kanban] backfilled kanbanFeatureId=${result.kanbanFeatureId} for existing state ${slug}`);
    }
    // Ensure state_file is populated on the kanban feature. NOTE: the DB `state_file` column
    // stores an ABSOLUTE path captured at creation; after the one-time relocation to
    // .ff/feature-state/ older rows point at the legacy.pi path and are stale.
    // This is benign — the card renders from DB metadata; resume uses stateDir/scanActiveFeatures
    // as ground truth. Only freshly-created (no state_file) rows get the current path here.
    const feature = database.getFeature(result.kanbanFeatureId);
    if (feature && !feature.state_file) {
      database.updateFeature({
        featureId: result.kanbanFeatureId,
        stateFile: stateFilePath(slug, stateDir()),
      });
    }
  } catch (err) {
    log.warn(`[kanban] failed to bootstrap feature state for ${result.feature.slug}: ${err}`);
  }

  // --- Session management: ensure feature has a session file tracked ---
  const lastSession = existingState?.sessionFiles?.at(-1);

  // Placeholder substitution function for skill expansion.
  // Uses the closure's `slug` (from result.feature.slug), NOT process.env.PI_FF_FEATURE
  // (the env var is deleted before this point).
  const substituteFn = (text: string) => substitutePlaceholders(text, { slug });

  const hasSession = !!(lastSession && fs.existsSync(lastSession) && ctx.switchSession);
  log.info(
    `[kanban] activateFeature: session decision for ${slug} — hasSession=${hasSession}, lastSession=${lastSession ?? "none"}, hasNewSession=${!!ctx.newSession}, hasSwitchSession=${!!ctx.switchSession}`,
  );
  // Track whether skill injection was already handled (newSession path sends via session_start)
  let skillHandled = false;

  if (hasSession) {
    // Clear the previous feature's env var before switching to prevent session_start
    // from binding the new session to the old feature.
    clearActiveFeatureEnv();
    log.info(`[kanban] activateFeature: loading session ${lastSession} for feature ${slug}`);
    const _desc = result.feature.description ? `\n${result.feature.description}` : "";
    const _skillMessage = expandSkillCommand(
      `/skill:${result.skill} Work on feature: ${result.feature.title}${_desc}`,
      substituteFn,
    );
    const _continuationMessage = `Continuing work on feature: ${result.feature.title}. Pick up where you left off.`;
    const _targetPhase: Phase = SKILL_TO_PHASE[result.skill] ?? "design";
    // All post-switch work MUST happen inside withSession — the old ctx/pi are stale after switchSession.
    const sessionToLoad = lastSession;
    if (sessionToLoad) {
      await withAutoAgentReplacement(async () => {
        await ctx.switchSession?.(sessionToLoad, {
          withSession: async (newCtx) => {
            // Refresh stash with fresh command context from the new session
            globalThis.__piCtx?.refresh(newCtx as unknown as ExtensionCommandContext);
            if (isEntryLane) {
              log.info(`[kanban] activateFeature: activating phase ${_targetPhase} for ${slug} in resumed session`);
              await activateWorkflowForFeature(slug, _targetPhase, newCtx);
              log.info(`[kanban] activateFeature: sending skill command into resumed session for ${slug}`);
              newCtx.sendUserMessage(_skillMessage, { deliverAs: "followUp" });
            } else {
              // Mid-workflow: reconstruct state without advancing phase, then continue.
              await resumeWorkflowForFeature(slug, newCtx);
              log.info(`[kanban] activateFeature: resuming mid-workflow feature ${slug} from session`);
              newCtx.sendUserMessage(_continuationMessage, { deliverAs: "followUp" });
            }
            trackSessionFileInState(newCtx, slug);
          },
        });
      });
      skillHandled = true;
    }
  } else if (ctx.newSession) {
    log.info(`[kanban] activateFeature: creating new session for feature ${slug}`);
    clearActiveFeatureEnv();
    const parentSession = ctx.sessionManager?.getSessionFile?.();

    const newSession = ctx.newSession;
    if (isEntryLane) {
      const { targetPhase, skillMessage } = buildFeatureActivationMessage(result, substituteFn);
      setWorkflowInitiatedNewSession(skillMessage);
      const res = await withAutoAgentReplacement(() =>
        newSession({
          parentSession: parentSession || undefined,
          withSession: async (newCtx) => {
            globalThis.__piCtx?.refresh(newCtx as unknown as ExtensionCommandContext);
            await activateWorkflowForFeature(slug, targetPhase, newCtx);
            trackSessionFileInState(newCtx, slug);
            skillHandled = true;
            log.info(`[kanban] activateFeature: new session created and tracked for ${slug}`);
          },
        }),
      );
      if (res?.cancelled) {
        log.info(`[kanban] activateFeature: new session cancelled for ${slug}`);
        await activateWorkflowForFeature(slug, targetPhase, ctx as unknown as ExtensionContext);
        trackSessionFileInState(ctx as unknown as ExtensionContext, slug);
      }
    } else {
      const _continuationMsg = `Continuing work on feature: ${result.feature.title}. Pick up where you left off.`;
      setWorkflowInitiatedNewSession(_continuationMsg);
      const res = await withAutoAgentReplacement(() =>
        newSession({
          parentSession: parentSession || undefined,
          withSession: async (newCtx) => {
            globalThis.__piCtx?.refresh(newCtx as unknown as ExtensionCommandContext);
            await resumeWorkflowForFeature(slug, newCtx);
            trackSessionFileInState(newCtx, slug);
            skillHandled = true;
            log.info(`[kanban] activateFeature: new session created for mid-workflow feature ${slug}`);
          },
        }),
      );
      if (res?.cancelled) {
        await resumeWorkflowForFeature(slug, ctx as unknown as ExtensionContext);
        trackSessionFileInState(ctx as unknown as ExtensionContext, slug);
      }
    }
  } else {
    trackSessionFileInState(ctx as unknown as ExtensionContext, slug);
  }

  // Skill injection (skip if already handled by switchSession/newSession paths above)
  if (!skillHandled) {
    if (isEntryLane) {
      const { targetPhase, skillMessage } = buildFeatureActivationMessage(result, substituteFn);
      await activateWorkflowForFeature(slug, targetPhase, piCtx as unknown as ExtensionContext);

      log.info("[kanban] activateFeature: sending skill command via sendUserMessage");
      piCtx.sendUserMessage(skillMessage, { deliverAs: "followUp" });
      log.info(`[kanban] activateFeature: skill command dispatched successfully for ${result.feature.slug}`);
    } else {
      await resumeWorkflowForFeature(slug, piCtx as unknown as ExtensionContext);
      log.info(`[kanban] activateFeature: continuing mid-workflow feature ${slug} without session`);
      piCtx.sendUserMessage(`Continuing work on feature: ${result.feature.title}. Pick up where you left off.`, {
        deliverAs: "followUp",
      });
    }
  }
}

/**
 * Handle feature completion notification from workflow-monitor.
 * Called when a feature's workflow completes (all phases done).
 */
export async function onFeatureComplete(slug: string, deps: OnFeatureCompleteDeps): Promise<void> {
  const { getDatabase, getTools, notify, pi } = deps;

  log.info(`[kanban] onFeatureComplete called for slug "${slug}"`);
  const current = globalThis.__piKanban?.autoAgent;
  if (current) {
    log.info(
      `[kanban] onFeatureComplete: agent state=${current.getState()}, featureId=${current.getCurrentFeatureId()}, role=${current.getRole()}`,
    );
  }
  // Match working, paused, and waiting agents.
  const { findAnyActiveAgent } = await import("../../commands/kanban-commands.js");
  const match = await findAnyActiveAgent(slug, current ?? null, getDatabase);
  log.info(`[kanban] onFeatureComplete: findAnyActiveAgent result=${match ? "found" : "not found"}`);
  if (!match) {
    // Check actual lock state to give accurate warning
    try {
      const { detectProject } = await import("../data/kanban-detect-project.js");
      const database = await getDatabase();
      const projectId = await detectProject(database, process.cwd());
      const feature = database.findFeatureBySlug(slug, projectId ?? undefined);
      if (feature?.locked_at) {
        log.warn(
          `[kanban] onFeatureComplete: no agent found for slug "${slug}" — feature will stay locked (agent may have moved to another feature)`,
        );
      } else {
        log.info(
          `[kanban] onFeatureComplete: no agent found for slug "${slug}" — lock already released (duplicate or late completion event)`,
        );
      }
    } catch {
      log.warn(`[kanban] onFeatureComplete: no agent found for slug "${slug}" — lock status unknown`);
    }
    return;
  }
  if (match.sm.projectId === undefined) {
    log.warn(`[kanban] onFeatureComplete: agent for slug "${slug}" has undefined projectId`);
    return;
  }
  const { sm, featureId } = match;
  log.info(`[kanban] onFeatureComplete: found agent for slug "${slug}", featureId=${featureId}, role=${sm.getRole()}`);

  try {
    const tools = await getTools();
    const settings = getSettings();
    const designApprovalEnabled = settings.designApprovalEnabled;

    const currentFeatureLane = sm.getCurrentFeatureLane();
    if (!currentFeatureLane) {
      log.warn(`[kanban] onFeatureComplete: no currentFeatureLane for slug "${slug}"`);
      try {
        sm.complete();
      } catch {}
      if (sm.getState() === "idle") {
        sm.start();
        sm.noFeatureAvailable();
      }
      const pollingFn = sm.getStartPollingFn();
      if (pollingFn) pollingFn();
      cleanupStoppedAgents();
      return;
    }

    // Check actual current lane in DB — user may have moved the card while agent worked
    const actualDb = await getDatabase();
    const actualFeature = actualDb.getFeature(featureId);
    const actualLane = actualFeature?.lane;

    if (actualLane && actualLane !== "design") {
      log.info(
        `[kanban] onFeatureComplete: feature ${featureId} is in lane "${actualLane}" (not design), skipping move`,
      );
      try {
        tools.kanbanRelease({ featureId });
      } catch {}
      sm.complete();
      if (sm.start()) {
        const projectId = sm.projectId;
        if (projectId === undefined) {
          log.warn("[kanban] onFeatureComplete: state machine has no projectId, cannot pick next feature");
        } else {
          const nextResult = sm.pickNextFeature(tools, projectId, sm.sessionId);
          if (nextResult) {
            const doActivate = globalThis.__piKanban?.activateFeature;
            if (!doActivate) {
              log.error("[kanban] activateFeature not available on __piKanban bridge", NO_ERROR);
              return;
            }
            notify(`✅ Auto-${sm.getRole()} finished: "${slug}". Activating next feature...`, DEFAULT_NOTIFY_LEVEL);
            await doActivate(nextResult, pi);
            return;
          }
        }
      }
      const pollingFn2 = sm.getStartPollingFn();
      if (pollingFn2) pollingFn2();
      cleanupStoppedAgents();
      return;
    }

    // Feature is still in design — normal completion flow
    const targetLane = computeTargetLane(currentFeatureLane, designApprovalEnabled);
    const useGracePeriod = currentFeatureLane === "design" && targetLane === "design-approval";

    let nextFeature: { feature: Feature; skill: string; kanbanFeatureId: number } | null;
    try {
      if (sm.projectId === undefined) {
        throw new Error("auto-agent state machine has no projectId");
      }
      nextFeature = sm.handleFeatureCompletion(tools, featureId, sm.sessionId, sm.projectId, {
        designApprovalEnabled,
        completeOnly: useGracePeriod,
      });
    } catch (err) {
      log.error(`[kanban] onFeatureComplete: handleFeatureCompletion failed for slug "${slug}"`, err);
      const pollingFn = sm.getStartPollingFn();
      if (pollingFn) pollingFn();
      cleanupStoppedAgents();
      return;
    }

    // Grace period path (→ design-approval)
    if (useGracePeriod && sm.getState() !== "stopped") {
      if (sm.start()) {
        const createGpm = globalThis.__piKanban?.createGracePeriodManager as CreateGracePeriodManagerFn | undefined;
        if (createGpm) {
          const gpm = createGpm(sm, tools);
          gpm.start();
          sm.enterGracePeriod();
          notify(
            `✅ Auto-${sm.getRole()} finished: "${slug}" → ${targetLane}. Searching for next feature in 30s...`,
            DEFAULT_NOTIFY_LEVEL,
          );
        } else {
          log.warn("[kanban] onFeatureComplete: createGracePeriodManager not available, falling back to polling");
          const pollingFn = sm.getStartPollingFn();
          if (pollingFn) pollingFn();
        }
      }
      return;
    }

    // Point B: design → ready, no next feature (immediate new session)
    if (currentFeatureLane === "design" && targetLane === "ready" && !nextFeature) {
      const resetFn = globalThis.__piWorkflowMonitor?.performWorkflowReset;
      if (resetFn) resetFn();

      const guard = globalThis.__piCtx;
      const newSession = guard?.newSession;
      if (newSession) {
        await withAutoAgentReplacement(() =>
          newSession({
            parentSession: guard?.sessionManager?.getSessionFile?.() || undefined,
            withSession: async (newCtx) => {
              globalThis.__piCtx?.refresh(newCtx as unknown as ExtensionCommandContext);
              const resetFn2 = globalThis.__piWorkflowMonitor?.performWorkflowReset;
              if (resetFn2) resetFn2();
              notify(
                `✅ Auto-${sm.getRole()} finished: "${slug}" → ready. New session started, polling for next design feature...`,
                DEFAULT_NOTIFY_LEVEL,
              );
            },
          }),
        );
      } else {
        notify(
          `✅ Auto-${sm.getRole()} finished: "${slug}" → ready. Polling for next design feature...`,
          DEFAULT_NOTIFY_LEVEL,
        );
      }

      const pollingFn = sm.getStartPollingFn();
      if (pollingFn) pollingFn();
      cleanupStoppedAgents();
      return;
    }

    // Standard path: next feature found
    if (nextFeature) {
      log.info(`[kanban] onFeatureComplete: picked next feature "${nextFeature.feature.title}"`);
      notify(`✅ Auto-${sm.getRole()} finished: "${slug}". Activating next feature...`, DEFAULT_NOTIFY_LEVEL);
      const doActivate = globalThis.__piKanban?.activateFeature;
      if (!doActivate) {
        log.error("[kanban] activateFeature not available on __piKanban bridge", NO_ERROR);
        return;
      }
      await doActivate(nextFeature, pi);
      return;
    }

    // No next feature — enter polling
    log.info(`[kanban] onFeatureComplete: no next feature available after "${slug}"`);
    notify(`💤 Auto-${sm.getRole()} finished: "${slug}". Waiting for new features...`, DEFAULT_NOTIFY_LEVEL);
  } catch (err) {
    log.error(`[kanban] onFeatureComplete: handleFeatureCompletion failed for slug "${slug}"`, err);
  }

  const pollingFn = sm.getStartPollingFn();
  if (pollingFn) pollingFn();
  log.info("[kanban] auto-agent: no more features available, polling...");
  cleanupStoppedAgents();
}

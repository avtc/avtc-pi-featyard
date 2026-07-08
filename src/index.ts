// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Workflow Monitor extension — feature-flow orchestration.
 *
 * Wires the tool_call / tool_result / session event handlers that drive a
 * feature through its phases (design → plan → implement → verify → review →
 * uat → finish): TDD write-order enforcement, guardrail warnings, review-loop
 * tracking, worktree + feature-state management, and the TUI widget.
 */

import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerUatCommands } from "./commands/auto-agent-commands.js";
import { registerWorkflowCommands } from "./commands/workflow-commands.js";
import { createCompaction } from "./compaction/compact-handler.js";
import { registerAllEvents } from "./events/index.js";
import { resolveBaseBranch as _resolveBaseBranch } from "./git/resolve-base-branch.js";
// --- Shared utility functions (in helper modules to eliminate circular imports) ---
import { cleanupWorktreeOnFinishWrapper, createGitExec, syncWorktreeStatus } from "./git/worktrees/worktree-helpers.js";
import { createWorktree } from "./git/worktrees/worktree-lifecycle.js";
import {
  applyExtensionOverride,
  buildExtensionOverride,
  resetExtensionOverride,
} from "./guardrails/file-classifier.js";
import { createGuardrails } from "./guardrails/guardrails-engine.js";
import { getTodoCompletedItemId, getTodoInProgressItem } from "./integrations/todo-integration.js";
import { createAgentLifecycle } from "./kanban/auto-agent/auto-agent-events.js";
import * as autoAgentNotify from "./kanban/auto-agent/auto-agent-notify.js";
import kanbanExtension from "./kanban/kanban-bridge.js";
import { createKanbanTurnHandlers } from "./kanban/kanban-turn-handlers.js";
import { getLogFilePath, log } from "./log.js";
import { clearActiveFeatureEnv, syncEnvVarsFromState } from "./phases/env-sync.js";
import { createExecutionModeApplier } from "./phases/execution-mode.js";
import type { Phase } from "./phases/phase-progression.js";
import { createReviewLoopHandlers } from "./review/review-loops.js";
import { DEFAULT_GLOBAL_DIR, getSettings, loadFeatureFlowConfig, resolveReviewSkill } from "./settings/settings-ui.js";
import { PiCtx } from "./shared/types.js";
// --- Orchestrator refs (shared module-level state for child modules) ---
import * as orchestratorRefs from "./shared/workflow-refs.js";
import { subscribeToNotificationApi } from "./snippets/vendored/subscribe-to-notifications.js";
import { archiveDesignsOlderThan, archiveStaleArtifacts, MS_PER_DAY } from "./state/archive-artifacts.js";
import {
  type EnsureFfJunctionResult,
  ensureFfJunction,
  resolveArchiveBase,
  resolveDesignsDirs,
} from "./state/artifact-junction.js";
import {
  activateWorkflowForFeature as _activateWorkflowForFeature,
  resumeWorkflowForFeature as _resumeWorkflowForFeature,
  captureBaseCommitSha,
  handleSubFeatureWrite,
  recoverArtifactsFromDisk,
} from "./state/feature-management.js";
import { createFeatureSession, NO_ACTIVE_FEATURE_STATE } from "./state/feature-session.js";
import type { FeatureState } from "./state/feature-state.js";
import {
  createSessionLifecycle,
  setWorkflowInitiatedNewSession,
  wireSessionLifecycleBridge,
} from "./state/session-lifecycle.js";
import { isSubagentSession, reconstructState } from "./state/state-persistence.js";
import { registerPhaseReady } from "./tools/phase-ready.js";
import { registerTaskReadyAdvance } from "./tools/task-ready-advance.js";

// Idempotent wiring guard. feature-flow can be bundled into the avtc-pi umbrella
// AND installed standalone — whichever copy loads first wires, the rest no-op.
const WIRED_KEY = "__avtcPiFeatureFlowWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

export { stripFrontmatter } from "@earendil-works/pi-coding-agent";
export { safeSetEditorText } from "./compaction/safe-editor-write.js";
export { resolveBaseBranch as _resolveBaseBranch } from "./git/resolve-base-branch.js";
export {
  bashSingleQuote,
  cleanupWorktreeOnFinishWrapper as _cleanupWorktreeOnFinish,
  createGitExec,
  getActiveWorktreeContext,
  WORKTREE_STATUS_KEY,
} from "./git/worktrees/worktree-helpers.js";
export { selectValue } from "./ui/select-dialog.js";
// --- Re-exports for backward compatibility with test imports ---
export { reconstructState };

export async function _ensureWorktreeForExecution(
  featureState: FeatureState,
  ctx: ExtensionContext,
): Promise<FeatureState> {
  const settings = getSettings();
  if (settings.branchPolicy !== "worktree") return featureState;
  if (featureState.git.worktreePath) return featureState; // already has worktree

  const slug = featureState.featureSlug;
  const baseBranch = await _resolveBaseBranch(ctx);
  const gitExec = createGitExec(ctx);

  try {
    const result = await createWorktree({
      slug,
      baseBranch,
      exec: gitExec,
    });

    // .ff must never be tracked. git worktree add may have checked out a tracked.ff/ as a
    // real directory; untrack it from the worktree index (aligns with the.ff guardrail) so
    // the worktree's git status stays clean and the implementer never sees a wall of
    // "deleted.ff/..." files. --ignore-unmatch makes this a no-op when.ff is untracked.
    // Non-fatal: a failure here (e.g. exotic git state) only leaves stale index entries; the
    // junction is still created below, so log rather than halt worktree setup.
    const rmResult = await gitExec("git rm -r --cached --ignore-unmatch .ff", { cwd: result.path });
    if (rmResult.exitCode !== 0) {
      log.info(
        `[workflow] git rm --cached .ff in worktree ${result.path} exited ${rmResult.exitCode} (non-fatal): ${rmResult.stdout.trim()}`,
      );
    }

    // Ensure <worktree>/.ff is a junction to the shared external store (same key/dir the
    // main repo uses). ensureFfJunction heals any real-directory / wrong-target entry into
    // the correct junction. Required before the implementer subagent runs in this worktree
    // (its skills read/write relative.ff/... paths, resolved against the worktree cwd).
    // Worktree checkout: a real-dir.ff here is the git-checked-out tracked content (also in
    // git + the external store), so delete-and-replace is safe — avoids leaving stale backups.
    ensureFfJunction(
      result.path,
      settings.branchPolicy ?? "current-branch",
      process.env.PI_FF_HOME ?? homedir(),
      "delete",
    );

    // All setup steps succeeded — commit the worktree path.
    featureState.git.worktreePath = result.path;
    featureState.git.baseBranch = baseBranch; // store for finish phase
    log.info(`[workflow] Created worktree for ${slug}: ${result.path}`);
    // Footer indicator (syncWorktreeStatus is the single source of truth for the
    // indicator; also re-applied on every UI restore so it survives a reload).
    syncWorktreeStatus(featureState);
  } catch (err: unknown) {
    // Programming errors (TypeError/ReferenceError/SyntaxError) propagate — they are bugs.
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
      throw err;
    }
    // Predictable setup failure (git error,.ff healing, path validation). In worktree mode
    // execution cannot fall back to the main repo (the implementer is dispatched into the
    // worktree with path-rewriting interception), so HALT visibly without throwing (pi must
    // not exit over this). The caller checks worktreePath and skips dispatch when unset.
    const errMsg = err instanceof Error ? err.message : String(err);
    // Trace arg carries err — the logger appends it; do not also inline it (would double-print).
    log.error(`[workflow] Worktree setup failed for ${slug}`, err);
    if (ctx.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(
        `Worktree setup failed for "${slug}": ${errMsg} — log: ${getLogFilePath(new Date())}. To continue without a worktree, set branchPolicy="current-branch".`,
        "error",
      );
    }
    // Leave worktreePath unset so the caller halts (does not dispatch the implementer).
  }
  return featureState;
}

export const {
  expandSkillCommand,
  substituteTemplates,
  resolveLoopIndex,
  applyModelOverrideForPhase,
  getActiveFeatureSlug,
} = orchestratorRefs;
export type { SubstitutionResult } from "./shared/workflow-refs.js";

/** Test-only: clear active feature slug while preserving handler and workflow state */
export function _clearActiveFeatureSlug(): void {
  orchestratorRefs.getHandlerRef()?.setActiveFeatureState(NO_ACTIVE_FEATURE_STATE);
  clearActiveFeatureEnv();
}

// globalThis key for cross-module-instance handler reference.
// Pi loads each extension with jiti moduleCache:false, so kanban/index.ts's import
// of workflow-monitor creates a separate module instance with its own _handlerRef (null).
// Using globalThis.__piWorkflowMonitor ensures all instances share the same handler.
// Initialization order: workflow-monitor factory (this file) MUST initialize
// __piWorkflowMonitor before any kanban code runs. This is guaranteed because:
// 1. package.json pi.extensions lists workflow-monitor.ts, NOT kanban/index.ts
// 2. kanban/ is loaded via dynamic imports from workflow-monitor sub-modules
// 3. KanbanExtensionDeps provides typed callbacks instead of direct bridge access

export async function activateWorkflowForFeature(
  slug: string,
  phase: Phase,
  ctx: ExtensionContext | null,
): Promise<void> {
  await _activateWorkflowForFeature(slug, phase, ctx, applyModelOverrideForPhase);
}

export async function resumeWorkflowForFeature(
  slug: string,
  ctx: ExtensionContext | null,
): Promise<FeatureState | null> {
  return _resumeWorkflowForFeature(slug, ctx, applyModelOverrideForPhase);
}

// globalThis keys for workflow-initiated new-session state.
// Set before ctx.newSession by /ff:next.
// Checked in session_start (reason="new") to distinguish user-initiated vs workflow-initiated /new.

export { applyModelOverride } from "./phases/phase-transitions.js";
export { resolveReviewLoopDecision } from "./review/review-loops.js";
export { trackSessionFileInState } from "./state/feature-management.js";
export { setWorkflowInitiatedNewSession };

export const {
  _getExpectedSkill,
  _resetFeatureState,
  _incrementEmptyLoop,
  _resetEmptyLoop,
  _getEmptyLoopsForSlug,
  _resetAllEmptyLoops,
  _isReviewerSkipped,
  _getReviewerEmptyLoops,
  getStateFilePath,
} = orchestratorRefs;

export { handleSubFeatureWrite } from "./state/feature-management.js";

import _settingsExtension from "./settings/settings-ui.js";

const settingsExtension = _settingsExtension;

import { initGuardrailIntegration } from "./integrations/parallel-work-guardrail-integration.js";
import { initSubagentIntegration } from "./integrations/subagent-integration.js";
import { initTodoIntegration } from "./integrations/todo-integration.js";

/**
 * Build the background-sweep options, reading the threshold from settings at call time. Extracted
 * as an exported seam so the setting→threshold wiring is testable without driving the 24h timer
 * (the on-start dispatch is gated off in the test sandbox). The sweep closure delegates here, so a
 * regression hardcoding/mistyping the threshold fails this contract ((c)).
 */
export function buildArchiveSweepOptions(
  externalDir: string,
  archiveBase: string,
): {
  externalDir: string;
  archiveBase: string;
  maxAgeDays: number;
} {
  return {
    externalDir,
    archiveBase,
    maxAgeDays: getSettings().autoArchiveArtifactsOlderThanDays,
  };
}

export default async function (pi: ExtensionAPI) {
  const g = globalThis as GlobalWithWired;
  if (g[WIRED_KEY]) return;
  g[WIRED_KEY] = true;

  subscribeToNotificationApi(pi);

  // Settings
  settingsExtension(pi);

  // Integration wiring (all sync — subscribeToTodo returns lazy proxy).
  // Each integration logs via its own avtc-pi-logger singleton (no shared logger injection).
  initGuardrailIntegration(pi);
  initSubagentIntegration(pi);
  const todoApi = initTodoIntegration(pi);

  // Workflow monitor
  try {
    await initWorkflowMonitor(pi, { todoApi });
  } catch (err) {
    // Clean up partially-initialized globalThis bridge on failure
    delete globalThis.__piWorkflowMonitor;
    throw err;
  }
}

async function initWorkflowMonitor(pi: ExtensionAPI, _deps: { todoApi: ReturnType<typeof initTodoIntegration> }) {
  // Ensure the.ff junction for external artifact storage (throws on failure — visible + debuggable).
  // Runs at init (cwd is fixed for the pi process). Cross-platform; aggregates worktrees.
  // When PI_FF_HOME is set we're in the test sandbox → be best-effort (never block extension load
  // on test-filesystem quirks). Production (no PI_FF_HOME) throws so real failures surface.
  const ffHome = process.env.PI_FF_HOME;
  const testSandbox = ffHome !== undefined;
  let ffResult: EnsureFfJunctionResult | undefined;
  try {
    // Main-repo/init path: a stray real-dir.ff is preserved (moved aside) — never lose data.
    ffResult = ensureFfJunction(
      process.cwd(),
      getSettings().branchPolicy ?? "current-branch",
      ffHome ?? homedir(),
      "rename",
    );
    if (ffResult.created) {
      log.info(`[feature-flow] .ff junction ready at .ff → ${ffResult.externalDir} (root: ${ffResult.rootSource})`);
    }
  } catch (err) {
    if (testSandbox) {
      log.warn(`[feature-flow] .ff junction setup skipped in test sandbox: ${err}`);
    } else {
      log.error("[feature-flow] Failed to set up .ff junction", err);
      throw err;
    }
  }

  const handler = createFeatureSession({
    onPhaseChange: () => {
      const slug = handler.getActiveFeatureSlug();
      syncEnvVarsFromState(handler);
      if (handler.getWorkflowState()?.currentPhase === "verify") {
        orchestratorRefs.getGuardrailsRef()?.setVerifyTestsPassed(false);
      }
      // Capture base commit SHA when entering implement phase
      if (handler.getWorkflowState()?.currentPhase === "implement") {
        if (slug) {
          const featureState = handler.getActiveFeatureState();
          if (featureState && !featureState.git.baseCommitSha) {
            captureBaseCommitSha(featureState);
          }
        }
      }
    },
  });
  // Set handler ref on orchestrator-refs module for child module access
  orchestratorRefs.setHandlerRef(handler);

  // Shared getAutoAgentCallback — reads from globalThis.__piKanban bridge
  const getAutoAgentCallback = () => globalThis.__piKanban?.autoAgentCallback ?? null;
  orchestratorRefs.setAutoAgentCallbackRef(getAutoAgentCallback);
  autoAgentNotify.setAutoAgentCallbackGetter(getAutoAgentCallback);

  // Register on globalThis so other module instances (jiti moduleCache:false) can access it
  if (!globalThis.__piWorkflowMonitor) {
    globalThis.__piWorkflowMonitor = {
      handler,
      requestWidgetUpdate: () => {},
      performWorkflowReset: () => {},
      modelOverrideRefs: { pi },
      finishPhaseWhitelisted: false,
      workflowInitiatedNewSession: false,
      newSessionMessage: undefined,
      archiveTimer: undefined,
    };
  } else {
    globalThis.__piWorkflowMonitor.handler = handler;
    globalThis.__piWorkflowMonitor.modelOverrideRefs = { pi };
  }
  if (!globalThis.__piCtx) {
    globalThis.__piCtx = new PiCtx();
  }

  // --- background artifact-archive sweep ((c)/) ---------------------------
  // Relocates artifact groups whose newest file mtime is older than `autoArchiveArtifactsOlderThanDays`
  // into a sibling artifacts-archive/ dir. Main session only (subagents skip — durable state is
  // host-owned); non-blocking (dispatched as a fire-and-forget async sweep). Repeats every 24h; the interval handle
  // lives on the bridge so session_shutdown clears it (no leak across /reload re-evaluation).
  if (ffResult) {
    const archiveBase = resolveArchiveBase(ffResult);
    const designsDirs = resolveDesignsDirs(ffResult.externalDir, process.cwd());
    const sweepOpts = () => buildArchiveSweepOptions(ffResult.externalDir, archiveBase);
    const runSweep = async () => {
      try {
        await archiveStaleArtifacts(sweepOpts());
      } catch (e) {
        log.warn(`[feature-flow] background archive sweep failed: ${e instanceof Error ? e.message : e}`);
      }
      // Design-doc sweep: opt-in via autoArchiveDesignsOlderThanDays (null = disabled). Sweeps BOTH
      // .ff/designs (local) and docs/ff/designs (committed) so docs from either mode age out.
      const designsDays = getSettings().autoArchiveDesignsOlderThanDays;
      if (designsDays != null) {
        try {
          await archiveDesignsOlderThan({
            designsDirs,
            archiveBase,
            days: designsDays,
          });
        } catch (e) {
          log.warn(`[feature-flow] background design-doc archive sweep failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    };
    if (!isSubagentSession()) {
      // Fire once on start (non-blocking), then every 24h. Clear any prior handle first so a
      // /reload re-evaluation never stacks duplicate timers. The bridge is set just above
      // (both init branches assign it) — guard defensively regardless.
      const bridge = globalThis.__piWorkflowMonitor;
      if (bridge?.archiveTimer) {
        clearInterval(bridge.archiveTimer);
      }
      if (bridge) {
        // The on-start sweep dispatch is production-only: in the test sandbox (PI_FF_HOME set) the
        // async sweep's synchronous fs body would race with test setup under isolate:false. The
        // sweep itself is unit-tested in archive-feature.test.ts; the 24h timer (testable lifecycle)
        // still starts below so timer-wiring is covered by archive-sweep-timer.test.ts.
        if (!testSandbox) {
          runSweep();
        }
        bridge.archiveTimer = setInterval(runSweep, MS_PER_DAY);
      }
    }
  }

  // Clear the 24h sweep interval on shutdown so /reload (which re-evaluates this module and
  // starts a new interval) never leaks the old one. The clear is idempotent and the
  // session_shutdown router (events/session/session-shutdown.ts) handles teardown.

  function syncSourceExtensions(): void {
    // source-extensions lives in the avtc-pi-feature-flow section of ~/.pi/agent/settings.json
    // (NOT the settings-ui schema, which has no array editor). Read it from the feature-flow config.
    const entries = loadFeatureFlowConfig(DEFAULT_GLOBAL_DIR, process.cwd())["source-extensions"];
    if (entries) {
      const result = buildExtensionOverride(entries);
      if (result.kind === "custom") {
        applyExtensionOverride(result.extensions);
      } else {
        resetExtensionOverride(); // all-invalid or mixed mode — use defaults
      }
    } else {
      resetExtensionOverride();
    }
  }
  syncSourceExtensions();

  // Execution mode applier (createExecutionModeApplier)
  const applyExecutionMode = createExecutionModeApplier({
    pi,
    handler,
    expandSkillCommand,
    applyModelOverrideForPhase,
    resolveBaseBranch: _resolveBaseBranch,
    ensureWorktreeForExecution: _ensureWorktreeForExecution,
  });

  // --- Compaction module (DI) ---
  // NOTE: initTodoIntegration(pi) is called above in the default export.
  // getTodoCompletedItemId / getTodoInProgressItem delegate to the lazy proxy from subscribeToTodo.
  // Tests that need them to return data should emit pi-todo:ready
  // with { getCompletedItemId, getInProgressItem, disableBuiltInFollowUp } on the fake pi.events.
  const compaction = createCompaction(pi, {
    handler,
    expandSkillCommand,
    resolveReviewSkill,
    agentJustFinishedRef: orchestratorRefs.getAgentJustFinishedRef(),
    getCompletedItemId: getTodoCompletedItemId,
    getInProgressItem: getTodoInProgressItem,
  });

  // Wire module-level refs through compaction instance (stored in orchestrator-refs)
  orchestratorRefs.setEmptyLoopRefs({
    getEmptyLoopsForSlug: compaction.getEmptyLoopsForSlug.bind(compaction),
    incrementEmptyLoop: compaction.incrementEmptyLoop.bind(compaction),
    resetEmptyLoop: compaction.resetEmptyLoop.bind(compaction),
    resetAllEmptyLoops: compaction.resetAllEmptyLoops.bind(compaction),
    isReviewerSkipped: compaction.isReviewerSkipped.bind(compaction),
    getReviewerEmptyLoops: compaction.getReviewerEmptyLoops.bind(compaction),
  });
  orchestratorRefs.setSkillResolutionRef({
    getExpectedSkill: compaction.getExpectedSkill.bind(compaction),
  });

  // Helper to reset per-session tracking state (guardrails parts + compaction delegated)
  const resetSessionTracking = () => {
    guardrails.resetTracking();
    compaction.resetTracking();
  };

  // getExpectedSkill now delegates to compaction module
  function getExpectedSkill(): string | null {
    return compaction.getExpectedSkill();
  }

  // --- Review loop handlers (must be created before guardrails which uses handleReviewLoopEnd) ---
  const { handleReviewLoopEnd, handleReviewToUatTransition } = createReviewLoopHandlers({
    handler,
    expandSkillCommand,
    applyModelOverrideForPhase,
    getAutoAgentCallback,
    recoverCompactFailure: compaction.recoverCompactFailure,
    pi,
  });

  // --- Guardrails module (DI) ---
  const guardrails = createGuardrails({
    pi,
    handler,
    compaction,
    expandSkillCommand,
    applyModelOverrideForPhase,
    recoverArtifactsFromDisk,
    handleSubFeatureWrite,
    applyExecutionMode,
    createGitExec,
    handleReviewLoopEnd,
  });
  orchestratorRefs.setGuardrailsRef(guardrails);

  // --- Advance-to-Plan-Task Tool ---
  registerTaskReadyAdvance(pi, compaction.recoverCompactFailure);

  // --- Phase Ready Tool ---
  // Registered before session-lifecycle so the IPhaseReady interface is available for DI.
  const phaseReady = registerPhaseReady({
    pi,
    handler,
    guardrails,
    recoverCompactFailure: compaction.recoverCompactFailure,
    expandSkillCommand,
    applyModelOverrideForPhase,
    handleReviewToUatTransition,
    applyExecutionMode,
    cleanupWorktreeOnFinish: cleanupWorktreeOnFinishWrapper,
    getAutoAgentCallback,
  });
  orchestratorRefs.setPhaseReadyRef(phaseReady);

  // --- Session lifecycle domain object (session_start/session_tree bodies + workflow reset) ---
  const lifecycle = createSessionLifecycle({
    pi,
    handler,
    compaction,
    guardrails,
    phaseReady,
    expandSkillCommand,
    applyModelOverrideForPhase,
    resolveBaseBranch: _resolveBaseBranch,
    ensureWorktreeForExecution: _ensureWorktreeForExecution,
    resolveLoopIndex,
  });
  wireSessionLifecycleBridge(handler, lifecycle);

  // Agent-lifecycle domain object (agent_start/agent_end handler bodies).
  const agentLifecycle = createAgentLifecycle({
    handler,
    compaction,
    phaseReady,
    getAutoAgentCallback,
  });

  // Kanban turn-handler domain object (turn_start/turn_end handler bodies).
  const kanbanTurn = createKanbanTurnHandlers(() => globalThis.__piWorkflowMonitor?.requestWidgetUpdate?.());

  // Register all pi.on event handlers (events/)
  registerAllEvents({
    pi,
    handler,
    guardrails,
    compaction,
    lifecycle,
    agentLifecycle,
    kanbanTurn,
  });

  // --- Format violation warning based on type ---

  // --- TUI Widget ---
  // Workflow commands (registerWorkflowCommands)
  registerWorkflowCommands({
    pi,
    handler,
    expandSkillCommand,
    applyModelOverrideForPhase,
    handleReviewToUatTransition,
    resetSessionTracking,
    reconstructState,
    getAutoAgentCallback,
    performWorkflowReset: lifecycle.performWorkflowReset,
  });

  // UAT commands (registerUatCommands)
  registerUatCommands(pi, {
    handler,
    getExpectedSkill,
    getAutoAgentCallback,
  });

  // --- Kanban extension (absorbed from standalone) ---
  // Registers /ff:auto-agent, /ff:auto-worker, /ff:auto-designer, /ff:auto-pause,
  // /ff:kanban, /ff:kanban-release commands + add_to_backlog tool + event handlers
  await kanbanExtension(pi, {
    activateWorkflowForFeature,
    resumeWorkflowForFeature,
    setWorkflowInitiatedNewSession,
  });

  // Reload-safety: pi re-evaluates this module fresh on /reload (jiti moduleCache:false), but
  // globalThis persists across re-evaluation. The guard above short-circuits re-wiring, so an
  // un-reset flag would leave the extension dead after /reload. session_shutdown fires before
  // the reload re-evaluation — clear the flag here so the next entry call re-wires cleanly.
  pi.on("session_shutdown", () => {
    (globalThis as GlobalWithWired)[WIRED_KEY] = false;
  });
}

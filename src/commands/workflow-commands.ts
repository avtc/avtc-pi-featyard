// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Workflow commands — /ff:next and /ff:resume.
 *
 * Phase transition commands closely related to phase_ready.
 */

import * as fs from "node:fs";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyAutoAgentBlocked, notifyAutoAgentUnblocked } from "../kanban/auto-agent/auto-agent-notify.js";
import { log } from "../log.js";
import { setActiveFeatureEnv } from "../phases/env-sync.js";
import { isPhaseDone, PHASE_TO_SKILL, type Phase } from "../phases/phase-progression.js";
import { completeFeature, transitionToFinishPhase, transitionToUatPhase } from "../phases/phase-transitions.js";
import { type RouteResult, routeNext, toRouteConfig } from "../phases/workflow-router.js";
import { NO_REVIEW_CONTEXT } from "../review/review-loops.js";
import { getSettings, resolveReviewSkill } from "../settings/settings-ui.js";
import { NO_AGENT_NAME, NO_FEATURE_STATE_OVERRIDE } from "../shared/workflow-refs.js";
import type { WorkflowTransitionDeps } from "../shared/workflow-types.js";
import { withCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import {
  archiveArtifactsOlderThan,
  archiveDesignsOlderThan,
  enumerateArchiveSet,
  enumerateDesigns,
} from "../state/archive-artifacts.js";
import { ensureFfJunction, resolveArchiveBase, resolveDesignsDirs } from "../state/artifact-junction.js";
import type { FeatureSession } from "../state/feature-session.js";
import {
  DEFAULT_DIR,
  deleteStateFile,
  type ExpandSkillCommandFn,
  stateFilePath as featureStateFilePath,
  loadFeatureState,
  markFeatureDone,
  saveFeatureState,
  scanActiveFeatures,
  stateDir,
  syncAndSaveFeatureState,
} from "../state/feature-state.js";
import { persistState } from "../state/state-persistence.js";
import { worthNotesPointerFor } from "../state/worth-notes.js";
import { NO_FEATURE_STATE, updateWidget } from "../ui/feature-flow-widget.js";
import { formatFeatureInfo, openManageDialog } from "../ui/manage-features-dialog.js";

export interface WorkflowCommandDeps extends WorkflowTransitionDeps {
  expandSkillCommand: ExpandSkillCommandFn;
  resetSessionTracking: () => void;
  reconstructState: (ctx: ExtensionContext, handler: FeatureSession, stateFilePath: string | false | null) => void;
  getAutoAgentCallback: () => import("../kanban/auto-agent/auto-agent-state-machine.js").AutoAgentCallback | null;
  /** Reset the workflow tracker to fresh state (shared reset used by ff:reset). */
  performWorkflowReset: () => void;
}

/** Resolve the skill for the next phase (review uses resolveReviewSkill; others map via PHASE_TO_SKILL) and dispatch it as a followUp user message. Shared by all phase-advance sites. */
function dispatchPhaseSkill(pi: ExtensionAPI, nextPhase: string, expandSkillCommandFn: ExpandSkillCommandFn): void {
  const skill =
    nextPhase === "review"
      ? resolveReviewSkill(getSettings())
      : PHASE_TO_SKILL[nextPhase as keyof typeof PHASE_TO_SKILL];
  if (skill)
    pi.sendUserMessage(expandSkillCommandFn(`/skill:${skill}`, NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME), {
      deliverAs: "followUp",
    });
}

/** Advance the handler to nextPhase and apply the full post-transition side effects (model override + state persist + widget update + skill dispatch). Shared by the next-phase command handlers when there is no slug-bound stage transition. */
async function advanceToPhaseWithSideEffects(
  handler: FeatureSession,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  nextPhase: string,
  applyModelOverrideForPhase: (pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>,
  expandSkillCommandFn: ExpandSkillCommandFn,
): Promise<void> {
  handler.setCurrentPhase(nextPhase as Phase);
  await applyModelOverrideForPhase(pi, ctx, nextPhase);
  persistState(pi, handler);
  updateWidget(handler, NO_FEATURE_STATE);
  dispatchPhaseSkill(pi, nextPhase, expandSkillCommandFn);
}

/**
 * Dispatch a {@link RouteResult} for a slug-bound feature: completion → completeFeature;
 * phase → uat/finish-aware stage transition; null → no-op (caller notifies).
 */
async function executeStageTransition(
  ctx: ExtensionContext,
  route: RouteResult,
  slug: string,
  deps: WorkflowCommandDeps,
): Promise<void> {
  const { pi, handler, expandSkillCommand, applyModelOverrideForPhase, handleReviewToUatTransition } = deps;

  // Terminal: feature completes — clean up worktree, mark done, clear active, fire auto-agent.
  if (route && "completed" in route) {
    const featureState = handler.getActiveFeatureState();
    if (featureState) {
      await completeFeature(slug, featureState, {
        pi,
        ctx,
        handler,
        getAutoAgentCallback: deps.getAutoAgentCallback,
      });
    }
    return;
  }

  if (!route) return;

  const nextPhase = route.phase;
  const currentPhase = handler.getWorkflowState()?.currentPhase;
  if (currentPhase === "verify" && nextPhase !== "review") {
    handler.setCurrentPhase("review");
  }

  if (nextPhase === "uat") {
    const featureState = handler.getActiveFeatureState();
    // Append the worth-notes pointer (existence + path) to the UAT handoff notify so it never stands
    // alone (notifications are exclusive — manual /ff:next review→UAT site).
    const pointer = worthNotesPointerFor(slug);
    const notifyMessage = pointer
      ? `Feature "${slug}" moved to UAT. Use /ff:next to advance.\n${pointer}`
      : `Feature "${slug}" moved to UAT. Use /ff:next to advance.`;
    await transitionToUatPhase(
      ctx,
      slug,
      featureState,
      {
        pi,
        handler,
        applyModelOverrideForPhase,
        getAutoAgentCallback: deps.getAutoAgentCallback,
      },
      {
        kanbanNote: "review complete — UAT handoff",
        notifyMessage,
      },
    );
    return;
  }

  if (nextPhase === "finish") {
    if (currentPhase === "verify") {
      await handleReviewToUatTransition(ctx, slug, getSettings(), NO_REVIEW_CONTEXT);
      return;
    }
    await transitionToFinishPhase(handler.getActiveFeatureState(), {
      pi,
      ctx,
      handler,
      applyModelOverrideForPhase,
      expandSkillCommand,
    });
    return;
  }

  handler.setCurrentPhase(nextPhase);
  const featureState = handler.getActiveFeatureState();
  if (featureState) {
    syncAndSaveFeatureState(featureState, handler);
  }
  persistState(pi, handler);
  updateWidget(handler, NO_FEATURE_STATE);
  await applyModelOverrideForPhase(pi, ctx, nextPhase);
  dispatchPhaseSkill(pi, nextPhase, expandSkillCommand);
}

// ── Archive-command shared helpers ───────────────────────────────────────────
// ff:archive-artifacts and ff:archive-designs share a parse → resolve → gate skeleton.
// Extracted to keep jscpd clean (the two commands differ only in enumerate/archive fn + messages).

type ArchiveCommandCtx = { ui: { notify(message: string, level: "info" | "warning" | "error"): void } };

/** Parse the `<days>` arg shared by both archive commands. Returns null (after notifying) on invalid input. */
function parseArchiveDays(args: string | undefined, ctx: ArchiveCommandCtx, commandLabel: string): number | null {
  const days = Number.parseInt((args ?? "").trim(), 10);
  if (Number.isNaN(days) || days < 0) {
    ctx.ui.notify(`Usage: /${commandLabel} <days> (archive older than N days)`, "error");
    return null;
  }
  return days;
}

/** Resolve the junction + archive base shared by both archive commands. */
function resolveArchiveContext(): { jr: ReturnType<typeof ensureFfJunction>; archiveBase: string } {
  const jr = ensureFfJunction(
    process.cwd(),
    getSettings().branchPolicy ?? "current-branch",
    process.env.PI_FF_HOME ?? os.homedir(),
    "rename",
  );
  return { jr, archiveBase: resolveArchiveBase(jr) };
}

export function registerWorkflowCommands(deps: WorkflowCommandDeps): void {
  const {
    pi,
    handler,
    expandSkillCommand,
    applyModelOverrideForPhase,
    resetSessionTracking,
    reconstructState,
    performWorkflowReset,
  } = deps;

  pi.registerCommand("ff:next", {
    description: "Complete current workflow stage and advance to next (skips if preconditions not met)",
    async handler(_args, ctx) {
      const ws = handler.getWorkflowState();
      if (!ws?.currentPhase) {
        if (ctx.hasUI) ctx.ui.notify("No active workflow. Start with /skill:ff-design or /ff:resume.", "warning");
        return;
      }
      const currentPhase = ws.currentPhase;
      const slug = handler.getActiveFeatureSlug();
      const settings = getSettings();
      const featureState = handler.getActiveFeatureState();
      // In the pointer model the current phase is the active pointer; it is "done"
      // only when the feature is completed. Derive from the feature state if present.
      const phaseDone = featureState
        ? isPhaseDone(
            { currentPhase: featureState.workflow.currentPhase, completedAt: featureState.completedAt },
            currentPhase,
          )
        : false;

      // Resolve the next route. When the current phase is not yet done, let the
      // machine route one step (uat-aware); when already done, route from the
      // pointer directly. Both paths yield a RouteResult that may be terminal.
      const routeConfig = toRouteConfig(settings);
      const route: RouteResult = phaseDone
        ? routeNext(currentPhase, routeConfig)
        : handler.completeCurrentWorkflowPhase(routeConfig);

      if (!route) {
        if (ctx.hasUI) ctx.ui.notify(`Workflow ended at ${currentPhase}. No more phases.`, "info");
        return;
      }

      if ("completed" in route) {
        // Terminal — feature completes (e.g. ff:next from uat in after-finish mode,
        // or from finish in after-review/off mode). Replicates the former uat-accept
        // completion path exactly so uat-accept could be dropped.
        if (ctx.hasUI) ctx.ui.notify(`✓ ${currentPhase} completed. Feature done.`, "info");
        if (slug && featureState) {
          await completeFeature(slug, featureState, {
            pi,
            ctx,
            handler,
            getAutoAgentCallback: deps.getAutoAgentCallback,
          });
        } else {
          persistState(pi, handler);
          updateWidget(handler, NO_FEATURE_STATE);
        }
        return;
      }

      // Non-terminal phase advance.
      if (ctx.hasUI) ctx.ui.notify(`✓ ${currentPhase} completed. Advancing to ${route.phase}...`, "info");
      if (slug) {
        await executeStageTransition(ctx, route, slug, deps);
      } else {
        await advanceToPhaseWithSideEffects(
          handler,
          ctx,
          pi,
          route.phase,
          applyModelOverrideForPhase,
          expandSkillCommand,
        );
      }
    },
  });

  pi.registerCommand("ff:resume", {
    description: "List active workflows and load the selected one into the current session",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("/ff:resume requires interactive mode.", "error");
        return;
      }

      while (true) {
        const currentFeatures = scanActiveFeatures(DEFAULT_DIR);
        if (currentFeatures.length === 0) {
          ctx.ui.notify("No active workflows found.", "info");
          return;
        }

        const featureOptions = currentFeatures.map((f) => `Continue: ${f.featureSlug} — ${formatFeatureInfo(f)}`);
        const allOptions = [...featureOptions, "Skip", "Manage state files"];
        const count = currentFeatures.length;
        const activeSlug = handler.getActiveFeatureSlug();
        if (activeSlug) notifyAutoAgentBlocked(activeSlug);
        const choice = await withCoordinator(() =>
          ctx.ui.select(`Found ${count} active feature${count > 1 ? "s" : ""}:`, allOptions),
        );
        if (activeSlug) notifyAutoAgentUnblocked(activeSlug);

        if (!choice) return;

        const featureIdx = featureOptions.indexOf(choice);
        if (featureIdx >= 0) {
          const selectedFeature = currentFeatures[featureIdx];
          if (selectedFeature) {
            const featureState = loadFeatureState(selectedFeature.featureSlug, DEFAULT_DIR);
            const lastSession = featureState?.sessionFiles?.at(-1);
            if (lastSession && fs.existsSync(lastSession)) {
              setActiveFeatureEnv(selectedFeature.featureSlug);
              await ctx.switchSession(lastSession, {
                withSession: async (newCtx) => {
                  newCtx.ui.notify(`Resumed session for: ${selectedFeature.featureSlug}`, "info");
                },
              });
              return;
            }
          }
          if (selectedFeature) {
            setActiveFeatureEnv(selectedFeature.featureSlug);
          }
          reconstructState(
            ctx,
            handler,
            selectedFeature ? featureStateFilePath(selectedFeature.featureSlug, DEFAULT_DIR) : null,
          );
          resetSessionTracking();
          persistState(pi, handler);
          updateWidget(handler, NO_FEATURE_STATE);

          const phase = handler.getWorkflowState()?.currentPhase ?? "unknown";
          ctx.ui.notify(`Loaded workflow: ${selectedFeature?.featureSlug ?? "unknown"} (${phase})`, "info");
          return;
        }

        if (choice === "Skip") return;

        if (choice === "Manage state files") {
          const manageResult = await openManageDialog(currentFeatures, ctx);
          if (manageResult) {
            for (const slug of manageResult.slugs) {
              if (manageResult.action === "mark_completed") {
                const state = loadFeatureState(slug, DEFAULT_DIR);
                if (state) saveFeatureState(markFeatureDone(state), DEFAULT_DIR);
              } else {
                deleteStateFile(slug, DEFAULT_DIR);
              }
            }
          }
          continue;
        }
        ctx.ui.notify("Unrecognized selection.", "warning");
        break;
      }
    },
  });

  pi.registerCommand("ff:archive-artifacts", {
    description: "Archive artifacts older than <days> days (manual sweep). Usage: /ff:archive-artifacts <days>",
    async handler(args, ctx) {
      // 1. Parse <days> (required, non-negative integer).
      const days = parseArchiveDays(args, ctx, "ff:archive-artifacts");
      if (days === null) return;

      // 2. Resolve the live store + archive base; enumerate what's stale at this threshold.
      const { jr, archiveBase } = resolveArchiveContext();
      const excludeSlug = handler.getActiveFeatureSlug();
      const { stale } = enumerateArchiveSet({
        externalDir: jr.externalDir,
        archiveBase,
        maxAgeDays: days,
        excludeSlug,
      });

      // 3. Empty short-circuit: nothing stale → notify, NO confirm gate (#5).
      if (stale.length === 0) {
        ctx.ui.notify("Nothing to archive.", "info");
        return;
      }

      // 4. Confirm gate — headless-safe (#11).
      if (!ctx.hasUI) {
        ctx.ui.notify("/ff:archive-artifacts requires interactive mode to confirm.", "info");
        return;
      }
      // Detect in-flight (active, non-completed) features among the stale set.
      const inFlight = scanActiveFeatures(stateDir())
        .map((s) => s.featureSlug)
        .filter((slug) => stale.some((g) => g.key === slug));
      const inFlightNote =
        inFlight.length > 0
          ? `\n\n⚠️ In-flight features that would be affected: ${inFlight.join(", ")}. Archiving hides their artifacts from .ff — resume would be artifact-degraded.`
          : "";
      // Count members + groups for the confirm message (what the user is about to archive).
      const memberCount = stale.reduce((n, g) => n + g.members.length, 0);
      const ok = await withCoordinator(() =>
        ctx.ui.confirm(
          `Archive artifacts older than ${days} day${days === 1 ? "" : "s"}?`,
          `This relocates ${memberCount} artifact${memberCount === 1 ? "" : "s"} across ${stale.length} group${stale.length === 1 ? "" : "s"} out of .ff into the archive. Reversible by moving them back.${inFlightNote}`,
        ),
      );
      if (!ok) {
        ctx.ui.notify("Archive cancelled — no changes made.", "info");
        return;
      }

      // 5. Archive. archiveArtifactsOlderThan re-enumerates internally (idempotent + skip-if-missing
      //    move primitive → worst case a tiny TOCTOU no-op; never corrupts).
      const result = await archiveArtifactsOlderThan({
        externalDir: jr.externalDir,
        archiveBase,
        days,
        excludeSlug,
      });
      // Report at the group level, broken down by type (slug groups vs date-fallback groups). A
      // group counts only when ALL its members moved (all-or-nothing unit) — so a fully-failed
      // group is NOT reported as archived. The feature-state file is a member of its slug's group
      // (co-archived when the group's newest mtime — across ALL members including the state file
      // is stale; skipped if missing), so it needs no separate count. Errors are separate (logged).
      const slugGroups = result.archivedSlugGroups;
      const dateFallbackGroups = result.archivedDateFallbackGroups;
      const errMsg =
        result.errors.length > 0
          ? ` (${result.errors.length} error${result.errors.length === 1 ? "" : "s"} — see log)`
          : "";
      ctx.ui.notify(
        `Archived ${slugGroups} slug${slugGroups === 1 ? "" : "s"} + ${dateFallbackGroups} date-fallback${dateFallbackGroups === 1 ? "" : "s"}.${errMsg}`,
        "info",
      );
      for (const err of result.errors) {
        log.warn(`[ff:archive-artifacts] ${err}`);
      }
    },
  });

  // --- ff:archive-designs command ---
  // Sweeps BOTH design-doc roots: the out-of-repo `.ff/designs` (local mode, via the junction) and
  // the in-repo `docs/ff/designs` (committed mode). Mirrors /ff:archive-artifacts (parse → enumerate
  // → empty short-circuit → confirm gate → archive → report).
  pi.registerCommand("ff:archive-designs", {
    description:
      "Archive design docs older than <days> days (sweeps .ff/designs and docs/ff/designs). Usage: /ff:archive-designs <days>",
    async handler(args, ctx) {
      // 1. Parse <days> (required, non-negative integer).
      const days = parseArchiveDays(args, ctx, "ff:archive-designs");
      if (days === null) return;

      // 2. Resolve BOTH roots + the archive base; enumerate what's stale at this threshold.
      const { jr, archiveBase } = resolveArchiveContext();
      const designsDirs = resolveDesignsDirs(jr.externalDir, process.cwd());
      const excludeSlug = handler.getActiveFeatureSlug();
      const { stale } = enumerateDesigns({
        designsDirs,
        archiveBase,
        maxAgeDays: days,
        excludeSlug,
      });

      // 3. Empty short-circuit: nothing stale → notify, NO confirm gate.
      if (stale.length === 0) {
        ctx.ui.notify("Nothing to archive.", "info");
        return;
      }

      // 4. Confirm gate — headless-safe.
      if (!ctx.hasUI) {
        ctx.ui.notify("/ff:archive-designs requires interactive mode to confirm.", "info");
        return;
      }
      // Detect in-flight (active, non-completed) features among the stale set.
      const inFlightSlugs = new Set(
        scanActiveFeatures(stateDir())
          .map((s) => s.featureSlug)
          .filter((slug): slug is string => Boolean(slug)),
      );
      const inFlight = stale.map((m) => m.slug).filter((slug) => inFlightSlugs.has(slug));
      const inFlightNote =
        inFlight.length > 0
          ? `\n\n⚠️ In-flight features that would be affected: ${[...new Set(inFlight)].join(", ")}. Archiving hides their design doc — resume would be degraded.`
          : "";
      const count = stale.length;
      const ok = await withCoordinator(() =>
        ctx.ui.confirm(
          `Archive design docs older than ${days} day${days === 1 ? "" : "s"}?`,
          `This relocates ${count} design doc${count === 1 ? "" : "s"} from .ff/designs and docs/ff/designs into the archive. Reversible by moving them back.${inFlightNote}`,
        ),
      );
      if (!ok) {
        ctx.ui.notify("Archive cancelled — no changes made.", "info");
        return;
      }

      // 5. Archive. archiveDesignsOlderThan re-enumerates internally (idempotent + skip-if-missing
      //    move primitive → worst case a tiny TOCTOU no-op; never corrupts).
      const result = await archiveDesignsOlderThan({
        designsDirs,
        archiveBase,
        days,
        excludeSlug,
      });
      const errMsg =
        result.errors.length > 0
          ? ` (${result.errors.length} error${result.errors.length === 1 ? "" : "s"} — see log)`
          : "";
      ctx.ui.notify(
        `Archived ${result.archivedCount} design doc${result.archivedCount === 1 ? "" : "s"}.${errMsg}`,
        "info",
      );
      for (const err of result.errors) {
        log.warn(`[ff:archive-designs] ${err}`);
      }
    },
  });

  // --- ff:reset command ---
  pi.registerCommand("ff:reset", {
    description: "Reset workflow tracker to fresh state for a new task",
    async handler(_args, ctx) {
      globalThis.__piCtx?.refresh(ctx);
      performWorkflowReset();
      const guard = globalThis.__piCtx;
      if (guard?.hasUI && guard?.ui?.notify) {
        guard.ui.notify("Workflow reset. Ready for a new task.", "info");
      }
    },
  });
}

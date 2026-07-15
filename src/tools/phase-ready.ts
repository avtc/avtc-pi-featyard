// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Phase-ready module — phase_ready tool handler.
 *
 * Handles design → plan, plan → implement, verify → review, and finish → done transitions.
 * Also handles the code-review loop (fy-review calls phase_ready with issuesFound).
 * During the implement phase, phase_ready is blocked by the guardrails interceptor
 * (the implement→verify transition is owned by task_ready_advance).
 * Includes design/plan review loop logic, compact-triggered review iteration compacts,
 * auto-agent integration, and kanban lane moves.
 *
 * All factory-coupled dependencies are injected via PhaseReadyDeps.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { NO_COMPACT_CALLBACK, triggerContextCompact } from "../compaction/compact-trigger.js";
import { syncWorktreeStatus } from "../git/worktrees/worktree-helpers.js";
import { areAllTodosDone } from "../integrations/todo-integration.js";
import { log, NO_ERROR } from "../log.js";
import { syncEnvVarsFromState } from "../phases/env-sync.js";
import { isPhaseDone } from "../phases/phase-progression.js";
import { getLoopCountForPhase, transitionToUatPhase } from "../phases/phase-transitions.js";
import { toRouteConfig } from "../phases/workflow-router.js";
import { reviewSkillName, toDisplayLoopNumber } from "../review/review-context.js";
import { reviewLoopStateField, startReviewIteration } from "../review/review-counter.js";
import { NO_REVIEW_CONTEXT, resolveReviewLoopDecision } from "../review/review-loops.js";
import { generateReviewReport, getReportableReviewHistory } from "../review/review-report.js";
import { getSettings, resolveReviewSkill } from "../settings/settings-ui.js";
import { NO_AGENT_NAME, NO_FEATURE_STATE_OVERRIDE } from "../shared/workflow-refs.js";
import type { IGuardrails, IPhaseReady, WorkflowTransitionDeps } from "../shared/workflow-types.js";
import { withCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import { recoverArtifactsFromDisk } from "../state/feature-management.js";
import type { FeatureSession } from "../state/feature-session.js";
import {
  DEFAULT_DIR,
  type ExpandSkillCommandFn,
  type FeatureState,
  markFeatureDone,
  recordReviewHistory,
  saveFeatureState,
} from "../state/feature-state.js";
import { schedulePostTurnFollowUp } from "../state/post-turn-dispatch.js";
import { isSubagentSession, persistState } from "../state/state-persistence.js";
import { notifyFeatureCompleted, worthNotesPointerFor } from "../state/worth-notes.js";
import { NO_FEATURE_STATE, updateWidget } from "../ui/featyard-widget.js";
import { textResult } from "./text-result.js";

const MSG_NO_SLUG = "phase_ready failed — no active feature slug.";
const MSG_NO_STATE = "phase_ready failed — no feature state found.";
const MSG_NO_CALLBACK = "phase_ready failed — auto-agent callback lost.";

// Unified guard against multiple phase_ready calls within a single AGENT run
// (one user prompt → agent_start … agent_settled). A "turn" in pi is one LLM
// response; the agent frequently re-calls phase_ready across several turns within
// one agent run (Thinking between calls). turn_end fires between those calls and
// would reset a turn-scoped guard — so this guard is reset on agent_end instead
// (the per-cycle boundary: every low-level run, including retry/compact/followUp
// continuations, ends with its own agent_end).
//
// IMPORTANT: phase-transition followUps are NOT dispatched inline. An inline
// followUp would drain inside the same agent loop with NO agent_end between the
// dispatching turn and the followUp-driven turn (pi: "the agent loop drains both
// queues before emitting agent_end"), so this run's phase_ready would still hold
// the guard and the followUp skill's own phase_ready would be deduped. Such
// followUps are staged via schedulePostTurnFollowUp and drained (deferred) by
// the agent_settled handler. agent_settled fires only when pi has no pending
// continuation, and at that point session.isStreaming is false, so the drained
// followUp starts a FRESH agent run. agent_end therefore fires between every
// iteration and the guard resets correctly.
//
// Set ONLY when phase_ready is honored — gates passed AND a real action occurred
// (phase transition OR followUp staged). NOT on gate failures / no-ops / UI
// "Discuss". This lets the agent legitimately retry (e.g. verify after running
// tests) while collapsing any confused repeated call into a single transition.
let phaseReadyPassed = false;

/** @internal Reset the phase_ready dedup flag (test isolation under isolate:false). */
export function _resetPhaseReadyPassed(): void {
  phaseReadyPassed = false;
}

export interface PhaseReadyDeps extends WorkflowTransitionDeps {
  guardrails: IGuardrails;
  /** Recover a failed `ctx.compact` — resumes the agent turn with the follow-up (mirrors the
   *  narrow `recoverCompactFailure` param the sibling tools inject, rather than the whole
   *  compaction module). */
  recoverCompactFailure: () => void;
  expandSkillCommand: ExpandSkillCommandFn;
  applyExecutionMode: (ctx: ExtensionContext) => Promise<void>;
  cleanupWorktreeOnFinish: (featureState: FeatureState, ctx: ExtensionContext) => Promise<void>;
  getAutoAgentCallback: () => ReturnType<
    typeof import("../kanban/auto-agent/auto-agent-state-machine.js").getAutoAgentCallback
  >;
}

/**
 * Build and return the full review follow-up message for a review iteration.
 *
 * Expands the review skill via `expandSkillCommand`. All PI_FY_* placeholders
 * (REVIEW_LOOP_CONTEXT, REVIEW_METHOD, report file, etc) are
 * resolved by the main substitution pipeline inside `expandSkillCommand` — this
 * function does not perform any substitution or read feature state itself.
 *
 * @param opts.loopNumber - Review iteration number for the followUp message
 *  text. **0** for the first pass, **rawLoopCount + 1** for subsequent
 *  iterations (the post-increment counter value, computed by the caller).
 */
function buildReviewFollowUp(
  deps: PhaseReadyDeps,
  opts: {
    /** e.g. "fy-plan-review" or "fy-design-review" */
    skillName: string;
    /** e.g. "plan review" or "design review" — human-readable label for the followUp message */
    label: string;
    /** Loop number for the followUp message text — 0 for first iteration */
    loopNumber: number;
  },
): string {
  // Placeholders (REVIEW_LOOP_CONTEXT, REVIEW_METHOD, report file)
  // are resolved by the main substitution pipeline inside expandSkillCommand.
  return deps.expandSkillCommand(
    `/skill:${opts.skillName} Run ${opts.label} iteration #${opts.loopNumber || 1}`,
    NO_FEATURE_STATE_OVERRIDE,
    NO_AGENT_NAME,
  );
}

/**
 * Apply review-iteration-reset compact logic.
 * @returns true if compact was triggered (caller should early-return), false if caller should proceed normally.
 */

/** Empty compact note — no extra preface before the skill expansion. */
const NO_COMPACT_MESSAGE = "";

/** Options that differ between plan and design review loops. */
interface ReviewLoopOpts {
  /** Phase name for getLoopCountForPhase */
  phaseName: "plan" | "design";
  /** Skill name, e.g. "fy-plan-review" or "fy-design-review" */
  skillName: string;
  /** Human-readable label for messages, e.g. "plan review" or "design review" */
  label: string;
  /** Log label for triggerContextCompact */
  logLabel: string;
}

type ReviewLoopResult = { kind: "first-iteration" } | { kind: "should-loop" } | { kind: "loops-done" };

/**
 * Shared review loop logic for plan and design phases.
 * Handles: first-iteration detection, loop counting, review history recording,
 * and loop decision. Does NOT handle post-loop continuation (different per phase).
 *
 * @returns the loop result indicating what the caller should do next.
 */
async function handleReviewLoop(
  deps: PhaseReadyDeps,
  ctx: ExtensionContext,
  handler: FeatureSession,
  slug: string,
  issuesFound: number,
  cannotFix: number,
  falsePositives: number,
  opts: ReviewLoopOpts,
): Promise<ReviewLoopResult> {
  const settings = getSettings();
  const state = handler.getActiveFeatureState();
  if (!state) return { kind: "loops-done" };

  const loopCount = state[reviewLoopStateField(opts.phaseName)].reviewLoopCount ?? 0;

  // First iteration — send initial review follow-up.
  // Always sync env + widget: startReviewIteration just changed reviewLoopCount
  // (0→1) and reviewActive. syncEnvVarsFromState re-syncs PI_FY_STAGE (fork-mode
  // derivation). The shouldLoop branch below always syncs too; this keeps both
  // branches consistent.
  if (loopCount === 0) {
    startReviewIteration(handler, slug, opts.phaseName, state);
    syncEnvVarsFromState(handler);
    updateWidget(handler, NO_FEATURE_STATE);
    // Stage the review-skill followUp for delivery after agent_settled (not
    // inline): an inline followUp would drain inside the same agent loop with no
    // agent_end between runs, so this run's phase_ready would still hold the
    // guard and the next run's phase_ready would be deduped. Staging defers
    // delivery to the agent_settled handler (deferred), which starts a fresh run.
    schedulePostTurnFollowUp(
      buildReviewFollowUp(deps, {
        skillName: opts.skillName,
        label: opts.label,
        loopNumber: 0,
      }),
    );
    return { kind: "first-iteration" };
  }

  // Subsequent iterations — resolve loop decision
  const rawLoopCount = getLoopCountForPhase(state, opts.phaseName);
  const adjustedLoopCount = toDisplayLoopNumber(rawLoopCount);
  const resolvedIssues = Math.max(0, issuesFound);
  const resolvedFalsePositives = Math.max(0, falsePositives);
  const resolvedCannotFix = Math.max(0, cannotFix);

  const { shouldLoop } = resolveReviewLoopDecision(
    { reviewLoops: settings.maxPlanReviewRounds, minReviewLoops: settings.minReviewLoops },
    adjustedLoopCount,
    resolvedIssues,
  );

  recordReviewHistory(state, {
    phase: opts.phaseName,
    loopNumber: adjustedLoopCount,
    issuesFound: resolvedIssues,
    falsePositives: resolvedFalsePositives,
    cannotFixIssues: resolvedCannotFix,
  });

  startReviewIteration(handler, slug, opts.phaseName, state);

  if (shouldLoop) {
    syncEnvVarsFromState(handler);
    updateWidget(handler, NO_FEATURE_STATE);
    // Next iteration number = the post-increment counter (rawLoopCount + 1).
    // adjustedLoopCount is 0-indexed "iterations completed" and is off by one
    // for the message — using it would label iteration #2 as "#1".
    const loopNumber = rawLoopCount + 1;
    const substituted = buildReviewFollowUp(deps, {
      skillName: opts.skillName,
      label: opts.label,
      loopNumber,
    });
    // Compact-handler owns skill + framing; pass skillName + the specific note only.
    const reviewNote = `Run ${opts.label} iteration #${loopNumber || 1}`;

    if (
      await triggerContextCompact(
        ctx,
        {
          settingValue: settings.reviewIterationCompact,
          skillName: opts.skillName,
          message: reviewNote,
          logLabel: `${opts.logLabel} shouldLoop=true`,
        },
        NO_COMPACT_CALLBACK,
        deps.recoverCompactFailure,
      )
    ) {
      return { kind: "should-loop" };
    }

    schedulePostTurnFollowUp(substituted);
    return { kind: "should-loop" };
  }

  return { kind: "loops-done" };
}

function completeDesignPhase(handler: FeatureSession, slug: string): void {
  const featureState = handler.getActiveFeatureState();
  if (featureState) {
    handler.setActiveFeatureState(featureState);
    recoverArtifactsFromDisk(handler);
  } else {
    log.warn(`phase_ready: no feature state found for '${slug}' — skipping artifact recovery`);
  }
  handler.completeCurrentWorkflowPhase(toRouteConfig(getSettings()));
}

export function registerPhaseReady(deps: PhaseReadyDeps): IPhaseReady {
  const {
    pi,
    handler,
    guardrails,
    recoverCompactFailure,
    expandSkillCommand,
    applyModelOverrideForPhase,
    handleReviewToUatTransition,
    cleanupWorktreeOnFinish,
    applyExecutionMode,
  } = deps;

  pi.registerTool({
    name: "phase_ready",
    label: "Phase Ready",
    description:
      "Workflow-stage tool for signaling phase completion. Only use when a skill prompt explicitly instructs it.",
    parameters: Type.Object({
      issuesFound: Type.Optional(
        Type.Number({
          description:
            "Number of real issues found in this review iteration (fixed + cannot-fix, excluding false positives)",
        }),
      ),
      cannotFix: Type.Optional(
        Type.Number({
          description:
            "Number of issues marked cannot-fix in this review iteration (subset of issuesFound; sets the report warning level)",
        }),
      ),
      falsePositives: Type.Optional(
        Type.Number({
          description:
            "Number of findings dismissed as false-positive in this review iteration (excluded from issuesFound; surfaces in the review report)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ws = handler.getWorkflowState();
      if (!ws?.currentPhase) {
        return textResult("phase_ready is not supported — no active workflow.");
      }

      const isDesign = ws.currentPhase === "design";
      const isPlan = ws.currentPhase === "plan";
      const isImplement = ws.currentPhase === "implement";
      const isVerify = ws.currentPhase === "verify";
      const isReview = ws.currentPhase === "review";
      if (!isDesign && !isPlan && !isImplement && !isVerify && !isReview && ws.currentPhase !== "finish") {
        return textResult(`phase_ready is not supported for ${ws.currentPhase}.`);
      }

      // phase_ready is blocked by the guardrails tool_call interceptor during the
      // implement phase (it redirects to task_ready_advance). Defensive no-op if
      // execute() is reached directly — never runs the implement→verify machinery
      // (that transition is owned by task_ready_advance's last-task branch).
      if (isImplement) {
        return textResult("");
      }

      // Unified once-per-agent-turn guard: if phase_ready was already honored this
      // agent turn (transition or follow-up dispatched), every subsequent call is a
      // silent no-op. Prevents the agent from double-transitioning / dispatching N
      // follow-ups when it re-calls phase_ready after seeing the `✓ done` result
      // (which spans multiple LLM turns within one agent turn). Reset on agent_end.
      if (phaseReadyPassed) {
        return textResult("");
      }

      // --- Code review phase: drive the review loop from issuesFound/cannotFix ---
      // The fy-review skill calls phase_ready({issuesFound, cannotFix}) at the
      // end of each iteration; guardrails records history, tracks empty loops, and
      // decides whether to loop again or transition to UAT/finish.
      if (isReview) {
        // Reaching here means first phase_ready this agent turn. The review loop
        // always acts (records history + dispatches/transitions) — mark honored.
        phaseReadyPassed = true;
        await guardrails.completeCodeReviewLoop(
          ctx,
          params.issuesFound ?? 0,
          params.cannotFix ?? 0,
          params.falsePositives ?? 0,
        );
        return textResult("");
      }

      // --- Plan phase: review loop or execution handoff ---
      if (isPlan) {
        const settings = getSettings();
        if (settings.maxPlanReviewRounds !== 0) {
          const planSlug = handler.getActiveFeatureSlug();
          if (!planSlug) {
            return textResult(MSG_NO_SLUG);
          }
          const planState = handler.getActiveFeatureState();
          if (!planState) {
            return textResult(MSG_NO_STATE);
          }
          const loopResult = await handleReviewLoop(
            deps,
            ctx,
            handler,
            planSlug,
            params.issuesFound ?? 0,
            params.cannotFix ?? 0,
            params.falsePositives ?? 0,
            {
              phaseName: "plan",
              skillName: reviewSkillName("plan"),
              label: "plan review",
              logLabel: "plan",
            },
          );
          if (loopResult.kind === "first-iteration" || loopResult.kind === "should-loop") {
            // A review-loop iteration follow-up was dispatched — phase_ready honored.
            phaseReadyPassed = true;
            return textResult("");
          }
          // loops-done: apply execution mode (advance plan → implement + dispatch fy-implement).
          // fy-implement seeds its todo list from the plan doc on start, so no separate
          // handoff/coverage-verification message is needed here.
          if (
            await triggerContextCompact(
              ctx,
              {
                settingValue: settings.reviewIterationCompact,
                skillName: "fy-implement",
                message: "Plan review complete. Continuing to implementation.",
                logLabel: "plan shouldLoop=false",
              },
              NO_COMPACT_CALLBACK,
              recoverCompactFailure,
            )
          ) {
            // Compact initiated (re-injects fy-implement) — phase_ready honored.
            phaseReadyPassed = true;
            return textResult("");
          }
          await applyExecutionMode(ctx);
          phaseReadyPassed = true;
          return textResult("");
        }
        // plan review off: apply execution mode directly (advance plan → implement + dispatch fy-implement).
        await applyExecutionMode(ctx);
        phaseReadyPassed = true;
        return textResult("");
      }

      // --- Verify phase ---
      if (isVerify) {
        const verifySlug = handler.getActiveFeatureSlug();
        if (!verifySlug) {
          return textResult(MSG_NO_SLUG);
        }

        if (!guardrails.isVerifyTestsPassed()) {
          log.info("[workflow] phase_ready (verify): tests have not passed, staying in verify");
          return textResult(
            "Tests have not passed yet. Run the test suite and ensure it passes before calling phase_ready.",
          );
        }

        if (!areAllTodosDone()) {
          log.info("[workflow] phase_ready (verify): todos not all done, staying in verify");
          return textResult("Not all todos are complete. Finish or cancel remaining items before calling phase_ready.");
        }

        const settings = getSettings();
        const reviewSkill = resolveReviewSkill(settings);
        // Gates passed (tests + todos) — phase_ready will be honored this call.
        phaseReadyPassed = true;
        if (reviewSkill) {
          handler.completeCurrentWorkflowPhase(toRouteConfig(settings)); // verify → review
          await applyModelOverrideForPhase(pi, ctx, "review");
          persistState(pi, handler);
          updateWidget(handler, NO_FEATURE_STATE);

          schedulePostTurnFollowUp(
            expandSkillCommand(`/skill:${reviewSkill}`, NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME),
          );
        } else {
          // No review skill — skip to review, then transition through it to UAT/finish
          handler.setCurrentPhase("review");
          await handleReviewToUatTransition(ctx, verifySlug, settings, NO_REVIEW_CONTEXT);
          return textResult("");
        }
        return textResult("");
      }

      // --- Finish phase ---
      if (ws.currentPhase === "finish") {
        const finishSlug = handler.getActiveFeatureSlug();
        if (!finishSlug) {
          return textResult(MSG_NO_SLUG);
        }

        const featureState = handler.getActiveFeatureState();
        const settings = getSettings();

        if (
          featureState &&
          settings.uatMode === "after-finish" &&
          !isPhaseDone(
            { currentPhase: featureState.workflow.currentPhase, completedAt: featureState.completedAt },
            "uat",
          )
        ) {
          handler.completeCurrentWorkflowPhase(toRouteConfig(settings));
          // finish → UAT transition — phase_ready honored.
          phaseReadyPassed = true;
          // Notify on the Finish→UAT transition: the review summary (regenerated from
          // persisted reviewHistory) + worth-notes pointer, mirroring after-review so worth-notes
          // are visible at UAT in every uatMode. Level mirrors the report: warning if any
          // cannot-fix in history, else info.
          const report = generateReviewReport(featureState);
          const cannotFix = getReportableReviewHistory(featureState).some((e) => e.cannotFixIssues > 0);
          const pointer = worthNotesPointerFor(finishSlug);
          const notifyMessage = pointer ? `${report}\n\n${pointer}` : report;
          await transitionToUatPhase(
            ctx,
            finishSlug,
            featureState,
            {
              pi,
              handler,
              applyModelOverrideForPhase: deps.applyModelOverrideForPhase,
              getAutoAgentCallback: deps.getAutoAgentCallback,
            },
            {
              kanbanNote: "finish complete — after-finish UAT",
              notifyMessage,
              notifyLevel: cannotFix ? "warning" : "info",
            },
          );
          return textResult("");
        }

        if (
          featureState &&
          !isPhaseDone(
            { currentPhase: featureState.workflow.currentPhase, completedAt: featureState.completedAt },
            "uat",
          )
        ) {
          log.info("[workflow] phase_ready (finish): UAT not yet resolved, skipping markFeatureDone");
          return textResult("UAT not yet resolved. Complete UAT first.");
        }

        handler.completeCurrentWorkflowPhase(toRouteConfig(settings));
        // finish → done completion — phase_ready honored.
        phaseReadyPassed = true;
        if (featureState) {
          await cleanupWorktreeOnFinish(featureState, ctx);
          // Mark done (completedAt) and keep the slot active with the done state, so the
          // widget renders a terminal DONE line until the next feature displaces it.
          // (done = visible: do NOT clear the active feature / env on completion)
          const doneState = markFeatureDone(featureState);
          saveFeatureState(doneState, DEFAULT_DIR);
          handler.setActiveFeatureState(doneState);
          // Sync the worktree status icon for the done state (completion is the
          // off-signal — clears the icon regardless of whether removal succeeded).
          syncWorktreeStatus(doneState);
        }
        // Emit the completion notify with the worth-notes pointer merged in.
        notifyFeatureCompleted(finishSlug);
        updateWidget(handler, NO_FEATURE_STATE);

        if (featureState?.featureId != null) {
          try {
            const { moveFeatureToLane } = await import("../kanban/data/kanban-move-feature.js");
            await moveFeatureToLane({
              featureId: featureState.featureId,
              toLane: "done",
              fromLane: undefined,
              note: "feature complete",
            });
          } catch (err) {
            log.warn(`phase_ready (finish): kanban lane move to done failed: ${err}`);
          }
        }

        try {
          const autoAgentCb = deps.getAutoAgentCallback();
          if (autoAgentCb && finishSlug) {
            log.info(`[workflow] auto-agent callback found, notifying feature completion for ${finishSlug}`);
            autoAgentCb.onFeatureComplete(finishSlug);
          }
        } catch (err) {
          log.error(`[workflow] auto-agent callback error: ${err}`, NO_ERROR);
        }

        return textResult("");
      }

      // --- Brainstorm phase ---
      const autoAgentCb = deps.getAutoAgentCallback();
      const isAutoMode = autoAgentCb?.isActive?.() === true;

      const slug = handler.getActiveFeatureSlug();
      if (!slug) {
        return textResult(MSG_NO_SLUG);
      }

      const settings = getSettings();
      if (settings.maxPlanReviewRounds !== 0) {
        const designState = handler.getActiveFeatureState();
        if (!designState) {
          return textResult(MSG_NO_STATE);
        }
        const loopResult = await handleReviewLoop(
          deps,
          ctx,
          handler,
          slug,
          params.issuesFound ?? 0,
          params.cannotFix ?? 0,
          params.falsePositives ?? 0,
          {
            phaseName: "design",
            skillName: reviewSkillName("design"),
            label: "design review",
            logLabel: "design",
          },
        );
        if (loopResult.kind === "first-iteration" || loopResult.kind === "should-loop") {
          // A design review-loop iteration follow-up was dispatched — phase_ready honored.
          phaseReadyPassed = true;
          return textResult("");
        }
        // loops-done: fall through to design completion
      }
      // maxPlanReviewRounds is off OR review loops finished
      if (!isAutoMode) {
        const guard = globalThis.__piCtx;
        const ui = guard?.ui;
        if (isSubagentSession() || !ui?.select) {
          return textResult("");
        }
        const { withAttention, getLastMessage } = await import("../snippets/vendored/subscribe-to-notifications.js");
        const detail = ["design review", slug, getLastMessage()].filter(Boolean).join(" • ");
        const choice = await withAttention("workflow", detail, () =>
          withCoordinator(() =>
            ui.select("Design phase complete. What would you like to do?", ["Proceed with implementation", "Discuss"]),
          ),
        );
        if (choice === undefined || choice === "Discuss") {
          return textResult("");
        }
      }

      try {
        // Design will advance (design → plan, or auto-agent handoff) — phase_ready honored.
        // Set after the UI "Discuss" gate so a Discuss no-op does not consume the guard.
        phaseReadyPassed = true;
        completeDesignPhase(handler, slug);

        const featureState = handler.getActiveFeatureState();
        if (featureState?.featureId !== null && featureState) {
          try {
            const { getDatabaseInstance } = await import("../kanban/kanban-bridge.js");
            const kanbanDb = getDatabaseInstance();
            if (kanbanDb && featureState.featureId !== null) {
              const kanbanSettings = getSettings();
              const targetLane = kanbanSettings.designApprovalEnabled ? "design-approval" : "ready";
              kanbanDb.moveFeature({
                featureId: featureState.featureId,
                toLane: targetLane,
                changedBy: "system",
                note: "design complete",
              });
              kanbanDb.unlockFeature(featureState.featureId);
              log.info(`phase_ready: moved feature ${featureState.featureId} to ${targetLane}`);
            }
          } catch (err) {
            log.warn(`phase_ready: kanban lane move failed: ${err}`);
          }
        }

        if (isAutoMode) {
          persistState(pi, handler);
          updateWidget(handler, NO_FEATURE_STATE);
          if (!autoAgentCb) {
            return textResult(MSG_NO_CALLBACK);
          }
          if (settings.maxPlanReviewRounds !== 0) {
            if (
              await triggerContextCompact(
                ctx,
                {
                  settingValue: settings.reviewIterationCompact,
                  message: NO_COMPACT_MESSAGE,
                  logLabel: "design shouldLoop=false auto",
                },
                () => autoAgentCb.onFeatureComplete(slug),
                recoverCompactFailure,
              )
            ) {
              return textResult("");
            }
          }
          autoAgentCb.onFeatureComplete(slug);
        } else {
          handler.setCurrentPhase("plan");
          await applyModelOverrideForPhase(pi, ctx, "plan");
          persistState(pi, handler);
          updateWidget(handler, NO_FEATURE_STATE);
          if (settings.maxPlanReviewRounds !== 0) {
            if (
              await triggerContextCompact(
                ctx,
                {
                  settingValue: settings.reviewIterationCompact,
                  skillName: "fy-plan",
                  message: NO_COMPACT_MESSAGE,
                  logLabel: "design shouldLoop=false non-auto",
                },
                NO_COMPACT_CALLBACK,
                recoverCompactFailure,
              )
            ) {
              return textResult("");
            }
          }
          schedulePostTurnFollowUp(expandSkillCommand("/skill:fy-plan", NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME));
        }

        return textResult("");
      } catch (err) {
        log.error(`phase_ready failed: ${err instanceof Error ? err.message : err}`, NO_ERROR);
        return textResult(`phase_ready failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("phase_ready"));
      if (args.issuesFound !== undefined) text += ` ${theme.fg("accent", `${args.issuesFound} issues`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      let text = "";
      for (let i = result.content.length - 1; i >= 0; i--) {
        const c = result.content[i];
        if (c?.type === "text") {
          text = c.text;
          break;
        }
      }
      const isError = text !== "";
      const indicator = isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      const truncated = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      return new Text(indicator + theme.fg("muted", truncated || "done"), 0, 0);
    },
  });

  // The once-per-agent-run guard (phaseReadyPassed) is reset from the
  // agent_end handler (auto-agent-events.ts) — the per-cycle boundary. The staged
  // phase-transition followUp is drained (deferred) by the agent_settled handler
  // (post-turn-dispatch.ts), which starts a fresh agent run. So agent_end fires
  // between every run, the guard is cleared, and the next run's phase_ready (e.g.
  // the fy-review skill ending its iteration) processes instead of being deduped.
  // NOTE: intentionally NOT reset on turn_end — a pi "turn" is one LLM response,
  // and a confused model's repeated phase_ready calls span multiple turns within
  // one agent turn (those repeats must stay collapsed until the turn truly ends).

  return {
    resetTracking() {
      phaseReadyPassed = false;
    },
  };
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * `task_ready_advance` — native pi tool invoked by the implementer at each
 * plan-task boundary during the implement phase of an active featyard workflow.
 *
 * One tool owns all implement-phase task transitions:
 *   - START a task           (currentTask == null, nextTask set)
 *   - ADVANCE to the next    (currentTask set, gates clean/cap/gates-off, nextTask set)
 *   - last task → verify      (currentTask set, nextTask omitted, todos done)
 *
 * Between START and advance, the tool drives a per-task gate cycle: after a task
 * is implemented, the model calls this tool, and the extension either dispatches
 * a fresh `fy-task-gate` round (verify/review subagents run, model triages,
 * recalls the tool with fixable counts) or advances. The gate cycle is bound by
 * `maxTaskReviewRounds` (stops when clean; no escalation at cap). The cycle is
 * dispatch-driven (mirrors `phase_ready`): the model calls the tool and waits for
 * the result, which tells it to continue working (advance) or end its turn (gate).
 *
 * `state.implement.taskReviewRounds[taskKey]` is the 0-indexed rounds-dispatched
 * counter (sole incrementer = this tool; `resolveReviewLoopIndex` is a pure read
 * that numbers both per-task agents' report files).
 *
 * Gated: blocked outside an active featyard workflow and outside the implement
 * phase (returns a reason instead of executing).
 */

import { Type } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NO_COMPACT_CALLBACK, triggerContextCompact } from "../compaction/compact-trigger.js";
import { areAllTodosDone } from "../integrations/todo-integration.js";
import { log } from "../log.js";
import { advanceImplementToVerify } from "../phases/implement-to-verify.js";
import { toRouteConfig } from "../phases/workflow-router.js";
import { buildTaskGateSkill, sanitizeSkillText } from "../prompts/task-gate-skill.js";
import { getSettings } from "../settings/settings-ui.js";
import {
  expandSkillCommand,
  getGuardrailsRef,
  NO_AGENT_NAME,
  NO_FEATURE_STATE_OVERRIDE,
  substituteTemplates,
} from "../shared/workflow-refs.js";
import { slugifyTaskDesignation } from "../state/artifact-paths.js";
import { schedulePostTurnFollowUp } from "../state/post-turn-dispatch.js";
import { persistState } from "../state/state-persistence.js";
import { textResult } from "./text-result.js";

// --- Schema ---

const Schema = Type.Object({
  verifierIssuesFixed: Type.Optional(
    Type.Number({
      description:
        "Fixable issues you fixed this pass from the fy-task-verifier report (exclude false-positives and cannot-fix). Omit on START/entry.",
    }),
  ),
  reviewerIssuesFixed: Type.Optional(
    Type.Number({
      description:
        "Fixable issues you fixed this pass from the fy-general-reviewer report, plus issues you self-found and fixed (exclude false-positives and cannot-fix). Omit on START/entry.",
    }),
  ),
  nextTask: Type.Optional(
    Type.String({
      description:
        "The plan-task to advance to next (<task number + name>), or omit on the last task to finish implementation.",
    }),
  ),
});

// --- Registration ---

export function registerTaskReadyAdvance(pi: ExtensionAPI, recoverCompactFailure: () => void): void {
  pi.registerTool({
    name: "task_ready_advance",
    label: "",
    description:
      "Use this tool ONLY when instructed by fy-implement skill. Start a task, advance to the next, or — on the last task, with nextTask omitted — finish implementation. After implementing a task, call it to enter the per-task gate cycle (the extension dispatches the gates or advances). Pass the fixable issues you fixed this pass per gate (verifierIssuesFixed, reviewerIssuesFixed; omit if no gates ran). Track active task from existing task-plan document. Not related to todo tools or items.",
    parameters: Schema,

    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      // Entry guard: only meaningful inside an active featyard workflow, implement phase.
      const handler = globalThis.__piWorkflowMonitor?.handler ?? null;
      if (!handler) {
        return textResult("Not available outside featyard implement phase.");
      }
      const ws = handler.getWorkflowState();
      if (ws?.currentPhase !== "implement") {
        return textResult("Not available outside featyard implement phase.");
      }
      const featureState = handler.getActiveFeatureState() ?? null;
      if (!featureState) {
        return textResult("Not available outside featyard implement phase.");
      }

      const settings = getSettings();

      // Shared task-entry side-effects (START and task→task advance both enter a new task).
      const enterTask = async (nextTask: string): Promise<void> => {
        featureState.implement.currentTask = nextTask;
        featureState.implement.taskReviewRounds[slugifyTaskDesignation(nextTask)] = 0;
        persistState(pi, handler);
        await triggerContextCompact(
          ctx,
          {
            settingValue: settings.interTaskCompact,
            message: `Next: "${sanitizeSkillText(nextTask)}".`,
            logLabel: "inter-task compact",
          },
          NO_COMPACT_CALLBACK,
          recoverCompactFailure,
        );
        globalThis.__piWorkflowMonitor?.requestWidgetUpdate?.();
      };

      const fixedV = params.verifierIssuesFixed ?? 0;
      const fixedR = params.reviewerIssuesFixed ?? 0;
      const cur = featureState.implement.currentTask ?? null;

      // --- START (no task in progress) ---
      if (cur === null) {
        const nextTask = String(params.nextTask ?? "").trim();
        if (!nextTask) {
          return textResult("Provide nextTask to start a task.");
        }
        log.info(`task_ready_advance: START → ${nextTask}`);
        await enterTask(nextTask);
        return textResult(`Current task: "${sanitizeSkillText(nextTask)}".`);
      }

      // --- gate cycle (current task in progress) ---
      const key = slugifyTaskDesignation(cur);
      const round = featureState.implement.taskReviewRounds[key] ?? 0; // 0-indexed; resume-safe (coerce missing entry on resumed tasks)
      const verifyActive = settings.verifyPhases.includes("implement");
      const reviewActive = settings.perTaskReviewMode === "general";
      const max = settings.maxTaskReviewRounds;

      // Dispatch decision (initialize before either branch — the dispatch block below reads the gate flags).
      let dispatch = false;
      let runVerifier = false;
      let runReviewer = false;
      let nextRound = round;

      if (round === 0 && (verifyActive || reviewActive)) {
        // ENTRY — gates spawn-active: dispatch round 1 with all active gates.
        dispatch = true;
        nextRound = 1;
        runVerifier = verifyActive;
        runReviewer = reviewActive;
      } else if (
        round >= 1 &&
        ((verifyActive && fixedV > 0) || (reviewActive && fixedR > 0)) &&
        round < max // activeness-gated: an inactive gate's count can't drive a round
      ) {
        // RELOOP (asymmetric respawn).
        dispatch = true;
        nextRound = round + 1;
        runVerifier = verifyActive && fixedV > 0; // verifier re-runs only after verifier fixes (rigorous/costly)
        runReviewer = reviewActive && (fixedV > 0 || fixedR > 0); // reviewer re-runs after any fix (covers the full diff)
      }

      if (dispatch) {
        featureState.implement.taskReviewRounds[key] = nextRound;
        persistState(pi, handler);
        log.info(
          `task_ready_advance: dispatch round ${nextRound}/${max} (verify=${runVerifier} review=${runReviewer}) for ${cur}`,
        );
        const skill = buildTaskGateSkill(
          {
            round: nextRound,
            task: cur,
            next: params.nextTask,
            runVerifier,
            runReviewer,
          },
          // Resolve ALL {{PI_FY_*}} markers at dispatch time so the block reaches
          // conversation history fully resolved (history is immutable — there is no
          // per-call re-substitution). Resolving against current state here is correct:
          // the gate gates `cur`, which is still the active task at dispatch.
          (t) => substituteTemplates(t, NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME).text,
        );
        pi.sendUserMessage(skill, { deliverAs: "steer" });
        return textResult("End your turn, wait for instructions."); // NO compact (the gate skill must reach the agent)
      }

      // --- ADVANCE (clean / cap reached / gates-off) ---
      // nextTask must be a real task name to advance; an empty value is neither a valid
      // advance nor an explicit omission (to finish, omit nextTask entirely).
      const nextTaskRaw = params.nextTask;
      if (nextTaskRaw !== undefined && nextTaskRaw !== null) {
        const nextTask = String(nextTaskRaw).trim();
        if (!nextTask) {
          return textResult("Provide a non-empty nextTask to advance, or omit nextTask to finish the last task.");
        }
        log.info(`task_ready_advance: ADVANCE ${cur} → ${nextTask}`);
        await enterTask(nextTask);
        return textResult(`Current task: "${sanitizeSkillText(nextTask)}", do not end your turn, work on it.`);
      }

      // --- LAST → VERIFY (nextTask omitted) ---
      if (!areAllTodosDone()) {
        log.info("[workflow] task_ready_advance (last→verify): todos not all done, staying in implement");
        return textResult("Not all TODO items are complete. Finish every item, then call task_ready_advance again.");
      }

      // The tool is deps-less (a plain registerTool), so reach the guardrails instance
      // via the module ref. It is wired unconditionally at extension init (same synchronous
      // init that registers this tool) — null here is an init invariant violation, so throw
      // (loud + visible) rather than return a silent model-only message.
      const guardrails = getGuardrailsRef();
      if (!guardrails) {
        throw new Error(
          "task_ready_advance (last→verify): guardrails ref not wired — extension initialization incomplete",
        );
      }

      // Reset the implement-scoped task pointer, then run the implement→verify transition
      // machinery (which persists state in one write — nothing in the transition reads currentTask).
      featureState.implement.currentTask = null;
      await advanceImplementToVerify(pi, ctx, handler, guardrails, toRouteConfig(settings));

      const fired = await triggerContextCompact(
        ctx,
        {
          settingValue: settings.interTaskCompact,
          // skillName omitted → the compact handler auto-derives fy-verify (the phase has advanced to verify).
          message: "Implementation complete — advancing to the verify phase.",
          logLabel: "implement→verify compact",
        },
        NO_COMPACT_CALLBACK,
        recoverCompactFailure,
      );
      if (!fired) {
        // Fallback: fire on ANY !fired (busy / mode≠compact / below-threshold) so the verify skill still dispatches.
        // Staged for agent_end delivery (see post-turn-dispatch) so it starts a fresh agent cycle.
        schedulePostTurnFollowUp(expandSkillCommand("/skill:fy-verify", NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME));
      }
      return textResult("End your turn, wait for instructions for advancing to the next phase.");
    },
  });
}

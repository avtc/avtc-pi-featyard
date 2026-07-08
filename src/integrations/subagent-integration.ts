// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Subagent integration layer — connects feature-flow-specific
 * dependencies to the generic pi-subagent extension.
 *
 * This is the ONLY file that imports from both pi-subagent (via vendored drop-in)
 * and feature-flow internals (settings, template-substitution, logging).
 *
 * Exports initSubagentIntegration(pi) which calls subscribeToSubagent
 * with feature-flow-specific hooks (transformPrompt, etc.).
 */

import * as path from "node:path";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { _kanbanModelRef } from "../kanban/kanban-bridge.js";
import { generateTopic } from "../kanban/kanban-generate-topic.js";
import { log } from "../log.js";
import { getLoopCountForPhase } from "../phases/phase-transitions.js";
import { substitutePlaceholders } from "../prompts/template-engine.js";
import { DEFAULT_GLOBAL_DIR, loadFeatureFlowConfig, resolveStageModelOnly } from "../settings/settings-ui.js";
import { getActiveFeatureSlug, getHandlerRef } from "../shared/workflow-refs.js";
import { subscribeToSubagent } from "../snippets/vendored/subscribe-to-subagent.js";
import { slugifyTaskDesignation } from "../state/artifact-paths.js";

/** The extension name feature-flow reports when registering agents via the pi-subagent
 *  addAgentsPaths API. Lets extension-provided name-collision messages (in avtc-pi-subagent)
 *  identify feature-flow as the contributor. */
const SUBAGENT_EXTENSION_NAME = "avtc-pi-feature-flow";

/** Fork context injected into an agent's system prompt when it runs in a forked
 * (branched-session) subagent. Agent-specific entries take precedence over the
 * generic fallback. Only the placeholder agent files reference this; resolution
 * lives here because the `isFork` signal is only available on the subagent path. */
const FORK_CONTEXT_BY_AGENT: Record<string, string> = {
  "ff-design-reviewer":
    "Pay special attention to:\n" +
    "- Decisions discussed but not captured in the final document\n" +
    "- Implicit assumptions that are clear from conversation but missing from the doc\n" +
    "- Changes in direction that weren't fully reflected",
  "ff-plan-reviewer":
    "Also check for:\n" + "- **Context gaps:** Discussed constraints or decisions not reflected in the plan",
};

/** Generic fork-context fallback for agents that have the
 * `{{PI_FF_FORK_CONTEXT_INJECTION}}` placeholder but no dedicated entry above. */
const FORK_CONTEXT_FALLBACK =
  "Pay special attention to:\n" +
  "- Decisions discussed but not captured in the written documents\n" +
  "- Implicit assumptions clear from conversation but missing from formal output";

/** Resolve the `{{PI_FF_FORK_CONTEXT_INJECTION}}` placeholder in an agent system prompt.
 * Injects agent-specific (or fallback) bullets when forking; empty string otherwise. */
function resolveForkContextInjection(systemPrompt: string, agentName: string, isFork: boolean): string {
  if (!systemPrompt.includes("{{PI_FF_FORK_CONTEXT_INJECTION}}")) return systemPrompt;
  if (!isFork) {
    return systemPrompt.replaceAll("{{PI_FF_FORK_CONTEXT_INJECTION}}", "");
  }
  const baseName = agentName.replace(/-fork$/, "");
  const injection = FORK_CONTEXT_BY_AGENT[baseName] ?? FORK_CONTEXT_FALLBACK;
  return systemPrompt.replaceAll("{{PI_FF_FORK_CONTEXT_INJECTION}}", injection);
}

/**
 * Resolve the current plan-task designation (set by task_ready_advance) from the
 * in-memory handler feature-state (the durable source of truth). Returns the raw task
 * string (e.g. '3. Wire the login form'), or undefined when no task has been advanced to
 * yet. Path builders slugify this value.
 */
function resolveCurrentTaskName(): string | undefined {
  return getHandlerRef()?.getActiveFeatureState()?.implement.currentTask ?? undefined;
}

/**
 * Resolve the loop index for a subagent invocation.
 *
 * Three cases:
 * 1. Per-task verify/review (ff-task-verifier or ff-general-reviewer during implement
 *    phase) — PURE READ of the task's taskReviewRounds on the active feature record.
 *    (task_ready_advance's gate is the sole incrementer; this only reads the current round
 *    to give each round a unique report file path.)
 * 2. Review agents (name contains "review") — reads the phase-aware loop count from
 *    feature state (the durable source of truth).
 * 3. All other agents — no loop index.
 */
export function _resolveReviewLoopIndex(
  agentName: string,
  _slug: string | undefined,
  taskName: string | undefined,
): number | undefined {
  const handler = getHandlerRef();
  const featureState = handler?.getActiveFeatureState() ?? null;
  const stage = handler?.getWorkflowState()?.currentPhase ?? null;

  // Case 1: Per-task verify/review during implement phase — PURE READ.
  // task_ready_advance's gate is the sole incrementer of taskReviewRounds; this function
  // only reads the current round so per-task reports render numbered paths. Covers both
  // ff-general-reviewer and ff-task-verifier.
  if ((agentName === "ff-general-reviewer" || agentName === "ff-task-verifier") && taskName) {
    if (stage === "implement" && featureState) {
      const key = slugifyTaskDesignation(taskName);
      return featureState.implement.taskReviewRounds[key] ?? 0;
    }
  }

  // Case 2: Review agents — read phase-aware loop count from feature state
  if (agentName.includes("review") && stage) {
    return getLoopCountForPhase(featureState, stage);
  }
  return undefined;
}

export function initSubagentIntegration(pi: ExtensionAPI): void {
  subscribeToSubagent(
    pi,
    async (systemPrompt, context) => {
      // Resolve slug, current plan-task designation, loopIndex from feature-flow context.
      // All read from the in-memory handler feature-state (the durable source of truth);
      // the only env var consulted here is PI_FF_FEATURE as a slug fallback when no
      // handler is wired (the child loads its feature-state file from that slug on start).
      const slug = getActiveFeatureSlug() ?? process.env.PI_FF_FEATURE;
      const taskName = resolveCurrentTaskName();
      const loopIndex = _resolveReviewLoopIndex(context.agentName, slug, taskName);

      // Generate topic from task when no slug/feature is active
      let topic: string | undefined;
      if (!slug && context.task) {
        try {
          topic = await generateTopic(context.task, { agentLoop, modelRef: _kanbanModelRef });
        } catch (err) {
          log.warn(`generateTopic failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Resolve FORK_CONTEXT_INJECTION first — needs context.isFork, only
      // available on this subagent path (not in substitutePlaceholders).
      systemPrompt = resolveForkContextInjection(systemPrompt, context.agentName, context.isFork);

      return substitutePlaceholders(systemPrompt, {
        agentName: context.agentName,
        slug,
        loopIndex,
        taskName,
        topic,
      });
    },
    () => {
      // explicitModel is NOT consulted here: pi-subagent's Phase 0 short-circuits an
      // explicit --model param before any Phase 2 hook runs, so this hook is only
      // reached when explicitModel === undefined. This hook yields a stage-model
      // (rotating by review-loop index) for the workflow's current stage, else
      // undefined so pi-subagent's Phase 3 default-model applies.
      const config = loadFeatureFlowConfig(DEFAULT_GLOBAL_DIR, process.cwd());
      const handler = getHandlerRef();
      const featureState = handler?.getActiveFeatureState() ?? null;
      const stage = handler?.getWorkflowState()?.currentPhase ?? null;
      const loopIdx = stage ? getLoopCountForPhase(featureState, stage) : 0;
      return resolveStageModelOnly(stage, loopIdx, config) ?? undefined;
    },
    [path.resolve(__dirname, "..", "..", "skills")],
    [path.resolve(__dirname, "..", "..", "agents")],
    SUBAGENT_EXTENSION_NAME,
  );
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Compaction module — session_compact handler + empty loop tracking + skill resolution.
 *
 * Implements the ICompaction interface for cross-module communication.
 * Tracks agent-finished state, reviewer empty loops, and resolves the expected
 * skill for the current workflow phase.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
import { PHASE_TO_SKILL } from "../phases/phase-progression.js";
import { NO_FEATURE_STATE_OVERRIDE } from "../prompts/skill-expansion.js";
import { EmptyLoopTracker } from "../review/review-empty-loop-tracking.js";
import { getSettings } from "../settings/settings-ui.js";
import type { ICompaction } from "../shared/workflow-types.js";
import type { FeatureSession } from "../state/feature-session.js";
import type { ExpandSkillCommandFn } from "../state/feature-state.js";
import { buildCompactFraming, buildCompactSkillBlock } from "./compact-message.js";
import { safeSetEditorText } from "./safe-editor-write.js";

// phase→skill map to phase-progression.ts — review/uat phases handled dynamically in getExpectedSkill()
export interface CompactionDeps {
  handler: FeatureSession;
  expandSkillCommand: ExpandSkillCommandFn;
  resolveReviewSkill: (settings: { maxFeatureReviewRounds: number }) => string | null;
  agentJustFinishedRef: { value: boolean };
  /** Id of the item just completed by the todo_complete that triggered this compaction (consume-on-read),
   *  or null when this compaction was not triggered by item completion. Injected to decouple from pi-todo. */
  getCompletedItemId: () => string | null;
  /** The current in-progress todo item formatted for followUp (`In progress: ▶ id: name\ndetails`),
   *  or null. Injected to decouple from pi-todo. */
  getInProgressItem: () => string | null;
}

/**
 * Create the compaction module.
 *
 * Owns:
 * - EmptyLoopTracker instance
 * - agentJustFinished flag
 * - getExpectedSkill() resolution
 * - session_compact handler registration
 */

/**
 * How long the mid-turn compaction follow-up is deferred before inject (ms).
 *
 * The follow-up is injected on a timer (not inline in the session_compact handler) so that a user
 * steer typed DURING compaction is delivered first: compaction_end fires flushCompactionQueue
 * (which sends the buffered steer as a prompt) right after session_compact; by this delay the
 * steer's turn is streaming, so the deferred sendUserMessage enqueues as a followUp (drained after
 * the steer) instead of racing the steer prompt and hanging it. In the no-steer case the agent is
 * idle at fire time, so sendUserMessage sends it as a prompt and starts the follow-up turn itself.
 * sendUserMessage self-adapts — no detection of whether the user steered is needed.
 *
 * Must exceed the steer prompt's prep window (compaction_end → isStreaming=true); that window is
 * sub-ms for sync handlers, so 500ms is ample margin. Exported so tests advance fake timers by the
 * real value rather than a magic number.
 */
export const DEFERRED_COMPACT_FOLLOWUP_MS = 500;

export function createCompaction(pi: ExtensionAPI, deps: CompactionDeps): ICompaction {
  const {
    handler,
    expandSkillCommand,
    resolveReviewSkill,
    agentJustFinishedRef,
    getCompletedItemId,
    getInProgressItem,
  } = deps;
  const emptyLoopTracker = new EmptyLoopTracker();
  const DEFERRED_FOLLOWUP_MS = DEFERRED_COMPACT_FOLLOWUP_MS;
  let pendingFollowUpTimer: ReturnType<typeof setTimeout> | undefined;

  function clearPendingFollowUp(): void {
    if (pendingFollowUpTimer !== undefined) {
      clearTimeout(pendingFollowUpTimer);
      pendingFollowUpTimer = undefined;
    }
  }

  /**
   * Defer a compaction follow-up inject by DEFERRED_FOLLOWUP_MS so a user steer typed DURING
   * compaction is delivered first (compaction_end → flushCompactionQueue sends it as a prompt;
   * by fire time the steer's turn is streaming, so this enqueues as a followUp instead of racing
   * it). In the no-steer case the agent is idle at fire time, so sendUserMessage sends it as a
   * prompt and starts the turn itself — self-adapts, no detection needed. Shared by the main
   * inject branch and the subagent path (subagents are non-interactive today, but a future
   * steer-capable subagent would hit the same race, so both defer). Replaces any prior pending
   * follow-up (a newer compaction supersedes).
   */
  function scheduleDeferredFollowUp(message: string): void {
    clearPendingFollowUp();
    pendingFollowUpTimer = setTimeout(() => {
      pendingFollowUpTimer = undefined;
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    }, DEFERRED_FOLLOWUP_MS);
  }

  // --- ICompaction interface ---

  function setAgentFinished(value: boolean): void {
    agentJustFinishedRef.value = value;
  }

  function incrementEmptyLoop(slug: string, reviewer: string): void {
    emptyLoopTracker.incrementEmptyLoop(slug, reviewer);
  }

  function resetEmptyLoop(slug: string, reviewer: string): void {
    emptyLoopTracker.resetEmptyLoop(slug, reviewer);
  }

  function isReviewerSkipped(slug: string, reviewer: string, threshold: number): boolean {
    return emptyLoopTracker.isReviewerSkipped(slug, reviewer, threshold);
  }

  function resetTracking(): void {
    clearPendingFollowUp();
    agentJustFinishedRef.value = false;
    emptyLoopTracker.resetAllEmptyLoops();
  }

  // --- Skill resolution ---

  /**
   * Determine which skill the LLM should be following based on current workflow phase.
   * Returns null if no phase is active or no skill is expected.
   */
  function getExpectedSkill(): string | null {
    const state = handler.getWorkflowState();
    if (!state?.currentPhase) return null;
    const { currentPhase } = state;
    // In the pointer model the current phase is always in-progress; bail out
    // only when the feature is already completed.
    const slug = process.env.PI_FF_FEATURE;
    const featureState = handler.getActiveFeatureState();
    if (featureState?.completedAt) return null;

    // Review iteration sub-states
    if (slug) {
      if (
        currentPhase === "design" &&
        (featureState?.design.reviewLoopCount ?? 0) > 0 &&
        featureState?.design.reviewActive
      ) {
        return "ff-design-review";
      }
      if (currentPhase === "plan" && (featureState?.plan.reviewLoopCount ?? 0) > 0 && featureState?.plan.reviewActive) {
        return "ff-plan-review";
      }
    }

    if (currentPhase === "implement") {
      return "ff-implement";
    }
    if (currentPhase === "review") {
      return resolveReviewSkill(getSettings());
    }
    return PHASE_TO_SKILL[currentPhase] ?? null;
  }

  // --- Subagent skill injection helper ---

  /**
   * Read skills from a local agent definition file.
   * Agents are defined in the feature-flow `agents/` directory — no external dependency needed.
   */
  function getAgentSkills(agentName: string): string[] {
    // Resolve agents/ relative to the feature-flow package root
    // (this file is at src/compaction/compact-handler.ts)
    const thisFile = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(thisFile), "../..");
    const agentFile = path.join(packageRoot, "agents", `${agentName}.md`);

    try {
      if (!fs.existsSync(agentFile)) return [];
      const content = fs.readFileSync(agentFile, "utf-8");
      const { frontmatter } = parseFrontmatter<Record<string, string>>(content);
      const skillStr = frontmatter.skill || frontmatter.skills;
      return (
        skillStr
          ?.split(",")
          .map((s: string) => s.trim())
          .filter(Boolean) ?? []
      );
    } catch (err) {
      log.warn(`Failed to read agent file ${agentFile}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /**
   * Handle compaction for subagent sessions — inject the subagent's declared skill(s).
   * Returns true if this was a subagent session (caller should return early).
   */
  async function handleSubagentCompact(): Promise<boolean> {
    const subagentAgentName = process.env.PI_SUBAGENT_CHILD_AGENT;
    if (!subagentAgentName) return false;

    const compactedMsg = `Context was compacted. You are subagent "${subagentAgentName}". Continue your task.`;
    let message: string;
    try {
      const skills = getAgentSkills(subagentAgentName);
      if (skills.length) {
        const skillNames = skills.join(", ");
        log.info(`Injecting subagent skills after compaction: ${skillNames} (agent: ${subagentAgentName})`);
        const skillParts = skills
          .map((s) => expandSkillCommand(`/skill:${s}`, NO_FEATURE_STATE_OVERRIDE, subagentAgentName))
          .join("\n\n");
        message = `${skillParts}\n${compactedMsg}`;
      } else {
        log.info(`Subagent ${subagentAgentName} has no declared skills — injecting role reminder`);
        message = compactedMsg;
      }
    } catch (err) {
      log.warn(`Subagent skill injection failed: ${err instanceof Error ? err.message : err}`);
      message = compactedMsg;
    }
    // Deferred (not inline): subagents are non-interactive today, but a future steer-capable
    // subagent would hit the same user-steer race, so this path defers like the main inject branch.
    scheduleDeferredFollowUp(message);
    return true;
  }

  // --- Pending dialog restoration helper ---

  // --- session_compact handler ---

  /**
   * Deliver the stored feature-flow follow-up — shared by session_compact (compact
   * succeeded) and the failed-compact recovery (onError). A failed compact still
   * interrupted the agent's turn (ctx.compact aborts it up front), so the agent must
   * be resumed with the SAME full follow-up as a success: a phase-transition compact
   * must inject the new phase's skill; an inter-task compact confirms the new current
   * task; a todo-triggered compact reveals the next item. session_compact is the
   * success path; on failure the follow-up is still in __piCompactFollowUp (session_
   * compact never fired), so this reads + deletes it, resolves the skill, assembles the
   * message, routes editor-vs-inject, and runs onAfterFollowUp (which clears the guard).
   */
  async function deliverStoredFollowUp(reason: "manual" | "threshold" | "overflow" | undefined): Promise<void> {
    // --- Stored pending-follow-up from a feature-flow caller (inter-task compact, review loop). ---
    // Caller provides { skillName?, message, onAfterFollowUp? } — message is the specific note only
    // (no /skill: prefix, no generic framing); this handler owns the skill + framing line.
    const storedFollowUp = globalThis.__piCompactFollowUp;
    delete globalThis.__piCompactFollowUp;

    // --- Todo parts: completedId only when item-completion triggered this compaction; the in-progress item always. ---
    const completedItemId = getCompletedItemId();
    const inProgressItem = getInProgressItem();

    const state = handler.getWorkflowState();
    const phase = state?.currentPhase ?? undefined;

    // Resolve skill: caller's explicit skillName wins, else the phase's expected skill.
    const skillName = storedFollowUp?.skillName ?? getExpectedSkill();

    // Nothing to inject (no skill, no caller note, no completed item, no in-progress item) — run the callback and stop.
    if (!skillName && !storedFollowUp?.message && !completedItemId && !inProgressItem) {
      storedFollowUp?.onAfterFollowUp?.();
      return;
    }

    // --- Is this a user-initiated manual compact? ---
    // `reason: "manual"` covers /compact, the UI button, AND extension ctx.compact() — all route through
    // session.compact(). To single out the *user*-initiated case, require NO extension/todo trigger:
    // extension-triggered compaction sets __piCompactFollowUp first; todo-triggered (hosted pi-todo)
    // sets the completed item id. With neither, a "manual" reason means the user compacted themselves.
    // Such compactions must NEVER auto-inject (sendUserMessage) — the user is in control and may steer next;
    // auto-injecting would start a blocking agent turn that hangs the user's steer. (regression fix)
    const isUserInitiatedManual = reason === "manual" && !storedFollowUp && !completedItemId;

    // --- Assemble ONE message: [skill block] + [framing] + [caller note] + [✅] + [In progress] ---
    const parts: string[] = [];
    const skillBlock = buildCompactSkillBlock(skillName, expandSkillCommand);
    if (skillBlock) parts.push(skillBlock);
    // Framing is always emitted (single source of truth here) — even with no skill (e.g. UAT).
    parts.push(buildCompactFraming(skillName, phase));
    if (storedFollowUp?.message) parts.push(storedFollowUp.message);
    if (completedItemId) parts.push(`✅ ${completedItemId}`);
    if (inProgressItem) parts.push(inProgressItem);
    const message = parts.join("\n\n");

    // --- Route to editor (no auto-inject) vs. inject followUp (auto-resume). ---
    // Editor when the user is in control: a user-initiated manual compact, OR the agent just finished
    // its turn (human's turn). Inject otherwise (auto/extension compaction while the agent is mid-turn).
    // No fallback skill: when there's no mapped skill (workflow inactive / no caller skillName),
    // nothing skill-related is injected, and no editor hint is shown (the notify IS the hint —
    // if there's no skill, there's nothing valuable to surface).
    const notifyMsg = skillName
      ? `Editor has content — compaction follow-up not injected. Run /skill:${skillName} to continue.`
      : null;
    if (isUserInitiatedManual || agentJustFinishedRef.value) {
      const route = isUserInitiatedManual ? "user-initiated manual" : "turn-end";
      log.info(`Routing compaction followUp to editor (${route}) — skill: ${skillName ?? "none"}, phase: ${phase}`);
      safeSetEditorText(message, notifyMsg);
    } else {
      log.info(
        `Injecting compaction followUp (mid-turn, deferred ${DEFERRED_FOLLOWUP_MS}ms) — skill: ${skillName ?? "none"}, phase: ${phase}`,
      );
      scheduleDeferredFollowUp(message);
    }

    storedFollowUp?.onAfterFollowUp?.();
  }

  /**
   * Failed-compact recovery: ctx.compact({onError}) routes EVERY failure (nothing-to-
   * compact, no-model, mid-summarization API error) here. The turn was already aborted by
   * compact(), so resume the agent — with the same full follow-up as a successful compact
   * (deliverStoredFollowUp). Mirrors session_compact: a subagent session injects the
   * subagent's declared skills. reason is unknown on the failure path; treat as manual, but
   * isUserInitiatedManual is false (there IS a stored follow-up). Exposed on ICompaction and
   * injected into triggerContextCompact callers as the onError handler (clean DI — no
   * service-locator ref).
   */
  function recoverCompactFailure(): void {
    log.info("compaction recovery — delivering the stored follow-up after a failed compact");
    clearPendingFollowUp();
    void handleSubagentCompact()
      .then((handled) => {
        if (handled) return;
        return deliverStoredFollowUp("manual");
      })
      .catch((err) => {
        // Never let the recovery path itself fail silently — that would orphan the agent mid-turn.
        log.error("compaction recovery failed — agent may not be resumed", err);
      });
  }

  async function onSessionCompact(event: { reason: "manual" | "threshold" | "overflow" }): Promise<void> {
    // A newer compaction supersedes any still-pending deferred follow-up from a prior compaction.
    clearPendingFollowUp();
    log.info(
      `session_compact fired — reason=${event.reason ?? "unknown"}, agentJustFinished=${agentJustFinishedRef.value}`,
    );

    if (await handleSubagentCompact()) return;

    await deliverStoredFollowUp(event.reason);
  }

  // Clear any pending deferred follow-up when the session tears down (quit/new/resume/fork/reload
  // route through resetTracking above; this covers the raw shutdown path so a deferred inject never
  // fires into a dead session).
  function onSessionShutdown(): void {
    clearPendingFollowUp();
  }

  return {
    setAgentFinished,
    incrementEmptyLoop,
    resetEmptyLoop,
    isReviewerSkipped,
    resetTracking,
    getEmptyLoopsForSlug: (slug: string) => emptyLoopTracker.getEmptyLoopsForSlug(slug),
    resetAllEmptyLoops: () => emptyLoopTracker.resetAllEmptyLoops(),
    getReviewerEmptyLoops: () => emptyLoopTracker.getReviewerEmptyLoops(),
    getExpectedSkill,
    recoverCompactFailure,
    onSessionCompact,
    onSessionShutdown,
  };
}

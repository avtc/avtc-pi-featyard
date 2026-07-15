// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Orchestrator refs and closure-wrapping functions.
 *
 * Module-level refs that child modules need to access without creating
 * circular imports back to the parent orchestrator.
 *
 * The parent orchestrator sets these refs during initialization.
 * Child modules read them to access handler state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearActiveFeatureEnv } from "../phases/env-sync.js";
import { applyModelOverride, getLoopCountForPhase } from "../phases/phase-transitions.js";
import type { SubstitutionResult } from "../prompts/skill-expansion.js";
import * as skillExpansion from "../prompts/skill-expansion.js";
import type { MutableRef } from "../shared/types.js";
import type { IGuardrails } from "../shared/workflow-types.js";
import { type FeatureSession, NO_ACTIVE_FEATURE_STATE } from "../state/feature-session.js";
import {
  clearFeatureStateCache,
  DEFAULT_DIR,
  type FeatureState,
  stateFilePath as featureStateFilePath,
} from "../state/feature-state.js";

// Re-export SubstitutionResult for consumers
export type { SubstitutionResult };

/** Pass as `featureStateOverride` when no override is needed. */
export const NO_FEATURE_STATE_OVERRIDE: FeatureState | null = null;
/** Pass as `agentName` when no specific agent name is known. */
export const NO_AGENT_NAME: string | null = null;

/** Grouped refs for empty-loop tracking — all set together from compaction instance. */
export interface EmptyLoopRefs {
  getEmptyLoopsForSlug: (slug: string) => Record<string, number>;
  incrementEmptyLoop: (slug: string, reviewerName: string) => void;
  resetEmptyLoop: (slug: string, reviewerName: string) => void;
  resetAllEmptyLoops: () => void;
  isReviewerSkipped: (slug: string, reviewerName: string, threshold: number) => boolean;
  getReviewerEmptyLoops: () => Record<string, Record<string, number>>;
}

/** Skill resolution ref — set from compaction instance. */
export interface SkillResolutionRef {
  getExpectedSkill: () => string | null;
}

// --- Module-level refs ---

/** Handler reference — set by parent orchestrator during init */
let _handlerRef: FeatureSession | null = null;

/** Empty loop tracking refs — set as a group from compaction instance */
let _emptyLoops: EmptyLoopRefs | null = null;

/** Skill resolution ref — set from compaction instance */
let _skillResolution: SkillResolutionRef | null = null;

/** Agent state tracking ref */
const _agentJustFinishedRef: MutableRef<boolean> = { value: false };

/** Guardrails instance ref */
let _guardrailsRef: IGuardrails | null = null;
/** PhaseReady instance ref — for resetTracking access (test cleanup / fy:reset) */
let _phaseReadyRef: import("../shared/workflow-types.js").IPhaseReady | null = null;
let _getAutoAgentCallbackRef:
  | (() => import("../kanban/auto-agent/auto-agent-state-machine.js").AutoAgentCallback | null)
  | null = null;

// --- Ref setters (called by parent orchestrator) ---

export function setHandlerRef(handler: FeatureSession | null): void {
  _handlerRef = handler;
}

/** Set empty-loop tracking refs from the compaction instance. */
export function setEmptyLoopRefs(refs: EmptyLoopRefs | null): void {
  _emptyLoops = refs;
}

/** Set skill resolution ref from the compaction instance. */
export function setSkillResolutionRef(refs: SkillResolutionRef | null): void {
  _skillResolution = refs;
}

export function setGuardrailsRef(ref: IGuardrails | null): void {
  _guardrailsRef = ref;
}

export function setPhaseReadyRef(ref: import("../shared/workflow-types.js").IPhaseReady | null): void {
  _phaseReadyRef = ref;
}

export function getPhaseReadyRef(): import("../shared/workflow-types.js").IPhaseReady | null {
  return _phaseReadyRef;
}

export function setAutoAgentCallbackRef(
  ref: (() => import("../kanban/auto-agent/auto-agent-state-machine.js").AutoAgentCallback | null) | null,
): void {
  _getAutoAgentCallbackRef = ref;
}

// --- Ref getters ---

export function getHandlerRef(): FeatureSession | null {
  return _handlerRef;
}

export function getActiveFeatureSlug(): string | null {
  return _handlerRef?.getActiveFeatureSlug() ?? null;
}

export function getAgentJustFinishedRef(): MutableRef<boolean> {
  return _agentJustFinishedRef;
}

export function getGuardrailsRef(): IGuardrails | null {
  return _guardrailsRef;
}

// --- Test-only accessors ---

/** @internal Returns the expected skill based on current workflow state */
export function _getExpectedSkill(): string | null {
  return _skillResolution?.getExpectedSkill() ?? null;
}

/** @internal Increment empty loop count for a reviewer */
export function _incrementEmptyLoop(slug: string, reviewerName: string): void {
  _emptyLoops?.incrementEmptyLoop(slug, reviewerName);
}

/** @internal Reset empty loop count for a specific reviewer */
export function _resetEmptyLoop(slug: string, reviewerName: string): void {
  _emptyLoops?.resetEmptyLoop(slug, reviewerName);
}

/** @internal Get empty loop counts for a feature slug */
export function _getEmptyLoopsForSlug(slug: string): Record<string, number> {
  return _emptyLoops?.getEmptyLoopsForSlug(slug) ?? {};
}

/** @internal Reset all empty loop tracking */
export function _resetAllEmptyLoops(): void {
  _emptyLoops?.resetAllEmptyLoops();
}

/** @internal Check if a reviewer should be skipped based on threshold */
export function _isReviewerSkipped(slug: string, reviewerName: string, threshold: number): boolean {
  return _emptyLoops?.isReviewerSkipped(slug, reviewerName, threshold) ?? false;
}

/** @internal Get all empty loop counts (for template substitution) */
export function _getReviewerEmptyLoops(): Record<string, Record<string, number>> {
  return _emptyLoops?.getReviewerEmptyLoops() ?? {};
}

/** @internal Get state file path for current active feature */
export function getStateFilePath(): string | null {
  const slug = getActiveFeatureSlug();
  if (slug) {
    return featureStateFilePath(slug, DEFAULT_DIR);
  }
  return null;
}

/** @internal Reset module-level state for testing */
export function _resetFeatureState(): void {
  _handlerRef?.setActiveFeatureState(NO_ACTIVE_FEATURE_STATE);
  if (globalThis.__piWorkflowMonitor) {
    globalThis.__piWorkflowMonitor.workflowInitiatedNewSession = undefined;
    globalThis.__piWorkflowMonitor.newSessionMessage = undefined;
    globalThis.__piWorkflowMonitor.modelOverrideRefs = { pi: undefined };
    // Clear the background-archive sweep interval. _resetFeatureState is the per-test cleanup
    // most test files invoke in afterEach; with isolate:false a 24h setInterval left on the bridge
    // by one activation keeps the event loop alive and shifts timing for later tests (exposing
    // pre-existing ordering races). Clearing it here ensures no activation leaks a timer across
    // tests. (This function is test-only — no production caller)
    if (globalThis.__piWorkflowMonitor.archiveTimer) {
      clearInterval(globalThis.__piWorkflowMonitor.archiveTimer);
      globalThis.__piWorkflowMonitor.archiveTimer = undefined;
    }
  }
  resetRefs();
  _guardrailsRef?.resetTracking();
  _phaseReadyRef?.resetTracking();
  clearActiveFeatureEnv();
  clearFeatureStateCache();
}

// --- Closure-wrapping functions ---

/** Substitute template variables in text using handler and empty-loops state */
export function substituteTemplates(
  text: string,
  featureStateOverride: FeatureState | null,
  agentName: string | null,
): SubstitutionResult {
  return skillExpansion.substituteTemplates(
    text,
    _handlerRef,
    _emptyLoops?.getEmptyLoopsForSlug ?? null,
    featureStateOverride,
    _getAutoAgentCallbackRef ?? null,
    agentName,
  );
}

/** Expand skill command in text using handler and empty-loops state */
export function expandSkillCommand(
  text: string,
  featureStateOverride: FeatureState | null,
  agentName: string | null,
): string {
  return skillExpansion.expandSkillCommand(
    text,
    _handlerRef,
    _emptyLoops?.getEmptyLoopsForSlug ?? null,
    featureStateOverride,
    _getAutoAgentCallbackRef ?? null,
    agentName,
  );
}

/** Get the review loop count for a given phase from feature state */
export function resolveLoopIndex(stage: string): number {
  return getLoopCountForPhase(_handlerRef?.getActiveFeatureState() ?? null, stage);
}

/** Apply model override for a given phase, resolving review loop index automatically */
export async function applyModelOverrideForPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stage: string,
): Promise<void> {
  await applyModelOverride(pi, ctx, stage, resolveLoopIndex(stage));
}

/** Reset module-level refs (called by _resetFeatureState and tests) */
export function resetRefs(): void {
  _handlerRef = null;
  _emptyLoops = null;
  _skillResolution = null;
  _guardrailsRef = null;
  _phaseReadyRef = null;
  _getAutoAgentCallbackRef = null;
  _agentJustFinishedRef.value = false;
}

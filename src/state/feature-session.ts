// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getHeadSha, getWorkingTreeFiles } from "../git/git-queries.js";
import { createSessionGuardrails } from "../guardrails/session-guardrails.js";
import { TddEnforcement, type TddGitDeps, type TddViolation } from "../guardrails/tdd-enforcement.js";
import { type Phase, PhaseProgression, type PhaseProgressionState } from "../phases/phase-progression.js";
import { type RouteConfig, type RouteResult, WorkflowRouter } from "../phases/workflow-router.js";
import { createFeatureRecordStore } from "./feature-record-store.js";

export type Violation = TddViolation;

/** Outcome of inspecting a tool call for discipline violations — bare nullable (a violation, or null). */
export type ToolCallInspection = Violation | null;

// Verification gate + GuardrailsState shapes + createGuardrailsState factory live in
// the SessionGuardrails holder (guardrails/session-guardrails.ts) — ownership aligns
// with responsibility. Re-exported here for the FeatyardState composition below.
export type { GuardrailsState, VerificationGate } from "../guardrails/session-guardrails.js";
export { createGuardrailsState } from "../guardrails/session-guardrails.js";

import type { GuardrailsState, VerificationGate } from "../guardrails/session-guardrails.js";

/**
 * The session-resident wrapper: the ACTIVE feature record held in memory as the
 * single source of truth, composed with the session-only guardrails tier.
 * featureState === null means no feature is active.
 */
export interface FeatyardState {
  featureState: import("../state/feature-state.js").FeatureState | null;
  guardrailsState: import("../guardrails/session-guardrails.js").GuardrailsState;
}

/** Sparse update applied to a featyard session (only set sections change). */
export type FeatyardStatePatch = {
  featureState?: import("../state/feature-state.js").FeatureState | null;
  guardrailsState?: Partial<import("../guardrails/session-guardrails.js").GuardrailsState>;
};

/** Sentinel for "no feature is active" — pass to setActiveFeatureState to clear it. */
export const NO_ACTIVE_FEATURE_STATE: import("../state/feature-state.js").FeatureState | null = null;

/** Real git-queries-backed TDD deps (the default for non-test handler construction). */
const defaultTddGitDeps: TddGitDeps = {
  workingTreeFiles: getWorkingTreeFiles,
  isGitRepo: (cwd: string) => getHeadSha(cwd) !== null,
};

export interface FeatureSession {
  /**
   * TDD write-order check for a source-file write/edit. Stateless git query
   * (tests-written-before-source); returns the violation or null. The caller has
   * already classified the tool call as a write/edit with a path.
   */
  checkSourceWriteOrder(path: string): ToolCallInspection;
  /**
   * A source file was written/edited — clear the "tests passed since last edit"
   * credit so the pre-commit gate requires a fresh test run before committing.
   */
  recordSourceWrite(): void;
  /**
   * Record the outcome of a test run. Passing satisfies the pre-commit gate;
   * failing drops it to not-run (don't commit red). The caller has already
   * classified the command as a test run and detected the outcome.
   */
  recordTestOutcome(passed: boolean): void;
  handleReadOrInvestigation(toolName: string, path: string): void;
  getVerificationState(): VerificationGate;
  recordVerificationWaiver(): void;
  /** Process a skill invocation input (e.g. /skill:fy-plan); returns whether the phase changed. */
  processSkillInput(text: string): boolean;
  /** Record a doc write into the phase progression; returns whether state changed. */
  recordDoc(path: string): boolean;
  getWorkflowState(): PhaseProgressionState | null;
  getFullState(): FeatyardState;
  setFullState(snapshot: FeatyardStatePatch): void;
  restoreWorkflowStateFromBranch(branch: SessionEntry[]): void;
  /** Extension-initiated: current phase verified done → route one step (review/uat-aware). Returns the routing decision; callers persist + handle `{completed}` (markFeatureDone). */
  completeCurrentWorkflowPhase(config: RouteConfig): RouteResult;
  /** User/explicit move to any phase (no guards). */
  setCurrentPhase(phase: Phase): boolean;
  /** Set the design/plan review-active flag (recorded into the live progression state). */
  setReviewActiveFlag(phase: "design" | "plan", value: boolean): void;
  /** The active feature record held in memory as single source of truth; null when no feature is active. */
  getActiveFeatureState(): import("../state/feature-state.js").FeatureState | null;
  /** Load/swap/clear the active feature record. Seeds the workflow tracker + resets session guardrails. */
  setActiveFeatureState(state: import("../state/feature-state.js").FeatureState | null): void;
  /** Update guardrails (verification) in place. */
  setGuardrailsState(patch: Partial<GuardrailsState>): void;
  getGuardrailsState(): GuardrailsState;
  getActiveFeatureSlug(): string | null;
  resetState(): void;
}

export interface FeatureSessionOptions {
  /** Called whenever a phase-changing operation succeeds (advanceTo, completeCurrent, skipPhases, onInputText, setCurrentPhaseDirect, transitionToUat). */
  onPhaseChange?: () => void;
  /** TDD git deps (test seam); defaults to the real git-queries-backed functions. */
  tddGitDeps?: TddGitDeps;
}

export function createFeatureSession(options: FeatureSessionOptions | null): FeatureSession {
  const enforcement = new TddEnforcement(options?.tddGitDeps ?? defaultTddGitDeps);
  const tracker = new PhaseProgression();
  const router = new WorkflowRouter(tracker);
  // Persistent tier: the active feature record held in memory as single source of
  // truth (write-through to its file by persistState). Disk serialization goes
  // through this holder ONLY — the SessionGuardrails holder is unreachable.
  const recordStore = createFeatureRecordStore();
  // Transient tier: session-only guardrail state (pre-commit verification gate).
  // Never persisted; structurally unreachable from serialization.
  const guardrails = createSessionGuardrails();

  /** Push the workflow engine state into the active feature record (source of truth). */
  const syncTrackerToFeature = (): void => {
    const activeFeatureState = recordStore.get();
    if (!activeFeatureState) return;
    const ws = tracker.getState();
    activeFeatureState.workflow = ws;
    // mirror doc slots into the phase-data objects
    activeFeatureState.design.doc = ws.designDoc;
    activeFeatureState.plan.doc = ws.planDoc;
  };

  return {
    checkSourceWriteOrder(path: string): ToolCallInspection {
      return enforcement.checkSourceWrite(path);
    },

    recordSourceWrite(): void {
      // Editing source clears the "tests passed since last edit" credit.
      guardrails.resetOnSourceWrite();
    },

    handleReadOrInvestigation(_toolName: string, _path: string): void {
      // No-op: debug-investigation tracking removed.
    },

    recordTestOutcome(passed: boolean): void {
      // A passing test run satisfies the pre-commit verification gate; a failing
      // run drops it back to "not-run" (don't commit red).
      guardrails.markPassed(passed);
    },

    getVerificationState() {
      return guardrails.getVerification();
    },

    recordVerificationWaiver() {
      guardrails.waive();
    },

    processSkillInput(text: string) {
      const changed = tracker.onInputText(text);
      if (changed) {
        syncTrackerToFeature();
        options?.onPhaseChange?.();
      }
      return changed;
    },

    recordDoc(path: string) {
      const changed = tracker.onFileWritten(path);
      if (changed) {
        syncTrackerToFeature();
        options?.onPhaseChange?.();
      }
      return changed;
    },

    getWorkflowState() {
      return tracker.getState();
    },

    getFullState(): FeatyardState {
      return {
        featureState: recordStore.get(),
        guardrailsState: guardrails.getSnapshot(),
      };
    },

    setFullState(snapshot: FeatyardStatePatch) {
      if (snapshot.featureState !== undefined) {
        // Load/swap the active feature record and seed the workflow engine from it.
        recordStore.set(snapshot.featureState);
        const activeFeatureState = recordStore.get();
        if (activeFeatureState) {
          tracker.setState(activeFeatureState.workflow);
        }
      }
      // Backward-tolerant: older snapshots carried a `tdd` slice (now removed);
      // only the `verification` field is read, and absent → keep current.
      if (snapshot.guardrailsState?.verification !== undefined) {
        guardrails.setSnapshot({ verification: snapshot.guardrailsState.verification });
      }
    },

    restoreWorkflowStateFromBranch(branch: SessionEntry[]) {
      const state = PhaseProgression.reconstructFromBranch(branch);
      if (state) {
        tracker.setState(state);
        syncTrackerToFeature();
      }
    },

    completeCurrentWorkflowPhase(config) {
      const result = router.completeCurrent(config);
      if (result) {
        syncTrackerToFeature();
        options?.onPhaseChange?.();
      }
      return result;
    },

    setCurrentPhase(phase) {
      const changed = tracker.setCurrentPhase(phase);
      if (changed) {
        syncTrackerToFeature();
        options?.onPhaseChange?.();
      }
      return changed;
    },

    setReviewActiveFlag(phase: "design" | "plan", value: boolean): void {
      // review-active flags are durable phase data on the feature record; mirror
      // into the active record so the in-memory copy stays authoritative.
      const activeFeatureState = recordStore.get();
      if (activeFeatureState) activeFeatureState[phase].reviewActive = value;
    },

    getActiveFeatureState() {
      return recordStore.get();
    },

    setActiveFeatureState(state) {
      recordStore.set(state);
      if (state) {
        tracker.setState(state.workflow);
      }
      // Guardrails are session-only: reset when the active feature changes.
      guardrails.reset();
    },

    getGuardrailsState() {
      return guardrails.getSnapshot();
    },

    setGuardrailsState(patch) {
      if (patch.verification !== undefined) guardrails.setSnapshot({ verification: patch.verification });
    },

    getActiveFeatureSlug(): string | null {
      return recordStore.get()?.featureSlug ?? null;
    },

    resetState() {
      recordStore.clear();
      tracker.setState(new PhaseProgression().getState());
      guardrails.reset();
    },
  };
}

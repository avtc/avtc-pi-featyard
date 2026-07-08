// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * SessionGuardrails — the transient tier holder.
 *
 * Wraps session-only guardrail state (the pre-commit verification gate) in an
 * explicit holder class so the persistence-fate boundary is structural. This
 * holder is NEVER written to the feature-state FILE — disk-file serialization
 * (saveFeatureState) reads only from FeatureRecordStore, so this state is
 * unreachable from the durable record by construction. It IS captured in the
 * session log (appendEntry, via getFullState) and restored on tree-resume, but
 * a fresh session reads the file — so guardrails reset when the file is the
 * sole source. The structural guarantee is: no code path can persist this state
 * into the FeatureState record.
 *
 * The verification gate is a 3-state flag: "not-run" (neutral / reset on source
 * write), "passed" (an observed passing test run), "waived" (an explicit user
 * waiver). Read by the pre-commit discipline gate at commit time.
 */

/** Pre-commit verification gate (3-state; resets on source write). */
export type VerificationGate = "not-run" | "passed" | "waived";

/** Session-only guardrails tier — transient discipline state, never in the feature file. */
export interface GuardrailsState {
  verification: VerificationGate;
}

/** Neutral guardrails — verification not-yet-run. */
export function createGuardrailsState(): GuardrailsState {
  return { verification: "not-run" };
}

export interface SessionGuardrails {
  /** Current verification-gate state. */
  getVerification(): VerificationGate;
  /** Record a test-run outcome: passed sets the gate; failed resets to not-run. */
  markPassed(passed?: boolean): void;
  /** Reset to not-run on a source write (the gate must be re-satisfied). */
  resetOnSourceWrite(): void;
  /** Explicit user waiver. Does NOT override an already-passed gate. */
  waive(): void;
  /** Reset to the neutral not-run state. */
  reset(): void;
  /** Snapshot the current state (for getFullState). */
  getSnapshot(): GuardrailsState;
  /** Restore from a snapshot (for setFullState). */
  setSnapshot(state: GuardrailsState): void;
}

/** Construct the transient-tier holder. Starts at not-run. */
export function createSessionGuardrails(): SessionGuardrails {
  let verification: VerificationGate = "not-run";
  return {
    getVerification: () => verification,
    markPassed: (passed = true) => {
      verification = passed ? "passed" : "not-run";
    },
    resetOnSourceWrite: () => {
      verification = "not-run";
    },
    waive: () => {
      // An explicit waiver does not override a gate already satisfied by a passing run.
      if (verification !== "passed") verification = "waived";
    },
    reset: () => {
      verification = "not-run";
    },
    getSnapshot: () => ({ verification }),
    setSnapshot: (state) => {
      verification = state.verification;
    },
  };
}

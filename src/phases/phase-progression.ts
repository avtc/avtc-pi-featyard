// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Phase progression — pure pointer math over the ordered feature-flow phases.
 *
 * Models the agent's position in a fixed phase sequence
 * (design → plan → implement → verify → review → uat → finish) as a single
 * pointer: {@link PhaseProgressionState.currentPhase}. Phase status is NEVER
 * stored — it is DERIVED from the pointer plus the feature's `completedAt`
 * (see {@link isPhaseDone} / {@link isPhaseActive}):
 *   - every phase before the pointer is `done` (moved through or skipped),
 *   - the pointer phase is `in-progress`,
 *   - every phase after the pointer is `pending`.
 *
 * This module owns ONLY pointer movement (setCurrentPhase, onInputText,
 * recordDoc) + status derivation. Sub-loop-aware routing policy (which phase
 * comes next per settings, review/UAT skipping) lives in
 * {@link WorkflowRouter} (workflow-router.ts), which advances via
 * {@link setCurrentPhase} on this progression.
 *
 * Moving forward implicitly completes every jumped-over phase (derived).
 * Moving backward implicitly resets the target-onward phases (derived). No status
 * map is kept, so it can never drift from the pointer.
 */

import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
import { DESIGN_DOC_DIRS, FF_TASK_PLANS_DIR } from "../state/artifact-paths.js";

/** The ordered feature-flow phases. */
export const WORKFLOW_PHASES = ["design", "plan", "implement", "verify", "review", "uat", "finish"] as const;

/** A single phase in the sequence. */
export type Phase = (typeof WORKFLOW_PHASES)[number];

/** Lifecycle status of one phase (derived, never stored on disk). */
export type PhaseStatus = "pending" | "in-progress" | "done";

/** Phases that may NOT bootstrap a brand-new workflow from idle. */
export const FRESH_START_BLOCKED: ReadonlySet<Phase> = new Set(["verify", "review", "finish"]);

/** Skill name → phase. A skill invocation drives progression to its phase. */
export const SKILL_TO_PHASE: Record<string, Phase> = {
  "ff-design": "design",
  "ff-plan": "plan",
  "ff-implement": "implement",
  "ff-verify": "verify",
  "ff-review": "review",
  "ff-design-review": "design",
  "ff-plan-review": "plan",
  "ff-finish": "finish",
};

/** Phase → canonical skill name (inverse of the driver subset). */
export const PHASE_TO_SKILL: Record<Phase, string> = {
  design: "ff-design",
  plan: "ff-plan",
  implement: "ff-implement",
  verify: "ff-verify",
  review: "ff-review",
  uat: "ff-review",
  finish: "ff-finish",
};

/** Resolve a skill name for a phase, falling back to the phase name. */
export function resolveSkillForPhase(phase: string): string {
  return PHASE_TO_SKILL[phase as Phase] ?? phase;
}

/** Extract a skill name from a `/skill:name` or `<skill name="…">` line; null otherwise. */
export function parseSkillName(line: string): string | null {
  const slash = line.match(/^\s*\/skill:([^\s]+)/);
  if (slash) return slash[1];
  const xml = line.match(/^\s*<skill\s+name="([^"]+)"/);
  if (xml) return xml[1];
  return null;
}

/** Persisted entry customType for a phase-progression snapshot. */
export const PHASE_PROGRESSION_ENTRY_TYPE = "phase_progression_state";

/**
 * Persisted phase-progression state: the pointer + the two doc artifacts the
 * machine tracks (design / task-plan paths). Status is derived; loop counts,
 * review history, review-active flags and tasks live in the feature file.
 */
export interface PhaseProgressionState {
  currentPhase: Phase | null;
  designDoc: string | null;
  planDoc: string | null;
}

/**
 * Structural view any state object with a phase pointer + completion flag
 * satisfies. Used by the derived-status helpers so they accept a {@link
 * PhaseProgressionState} (no completedAt) OR a full feature record, without a
 * circular import on FeatureState.
 */
export interface PhaseProgressionView {
  currentPhase: Phase | null;
  completedAt: string | null;
}

/** Ordinal position of a phase in the sequence. */
export function indexOfPhase(phase: Phase): number {
  return WORKFLOW_PHASES.indexOf(phase);
}

/** A phase is done once the feature is completed OR the pointer has moved past it. */
export function isPhaseDone(view: PhaseProgressionView, phase: Phase): boolean {
  if (view.completedAt !== null) return true;
  return view.currentPhase !== null && indexOfPhase(phase) < indexOfPhase(view.currentPhase);
}

/** A phase is in-progress iff it is the pointer AND the feature is not completed. */
export function isPhaseActive(view: PhaseProgressionView, phase: Phase): boolean {
  return view.completedAt === null && phase === view.currentPhase;
}

/** A phase is pending iff it is neither done nor in-progress. */
export function isPhasePending(view: PhaseProgressionView, phase: Phase): boolean {
  return !isPhaseDone(view, phase) && !isPhaseActive(view, phase);
}

/** Normalize to forward slashes, then prefix-compare (Windows-backslash safe). */
function isInsideDir(filePath: string, dir: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  const prefix = dir.replace(/\\/g, "/");
  return norm === prefix || norm.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/** Artifact filename suffixes + their required directories. */
const DESIGN_DOC = /-design\.md$/;
const TASK_PLAN_DOC = /-task-plan\.md$/;

/**
 * Phase progression state machine — owns the pointer + the two doc artifacts.
 */
export class PhaseProgression {
  private state: PhaseProgressionState = { currentPhase: null, designDoc: null, planDoc: null };

  /** Read-only snapshot (defensively cloned). */
  getState(): PhaseProgressionState {
    return structuredClone(this.state);
  }

  /** Replace internal state from a snapshot (defensively cloned). */
  setState(state: PhaseProgressionState): void {
    this.state = structuredClone(state);
  }

  /** Clear the pointer + artifacts back to idle. */
  reset(): void {
    log.info("[phase] reset()");
    this.state = { currentPhase: null, designDoc: null, planDoc: null };
  }

  /** The current phase pointer. */
  get currentPhase(): Phase | null {
    return this.state.currentPhase;
  }

  /** Recorded design doc path (null if none). */
  get designDoc(): string | null {
    return this.state.designDoc;
  }

  /** Recorded task-plan doc path (null if none). */
  get planDoc(): string | null {
    return this.state.planDoc;
  }

  /** Record a doc artifact path; returns whether it differed from the prior value. */
  recordDoc(phase: "design" | "plan", path: string): boolean {
    const key = phase === "design" ? "designDoc" : "planDoc";
    if (this.state[key] === path) return false;
    this.state[key] = path;
    return true;
  }

  /**
   * Atomically move the pointer to a target. NO guards — used by user moves
   * (skill / ff:next) and by WorkflowRouter.completeCurrent. Forward jumps
   * implicitly complete the jumped phases (derived); backward moves implicitly
   * reset the target-onward phases (derived). Same-phase re-entry is a no-op.
   * Returns true when the pointer changed.
   */
  setCurrentPhase(target: Phase): boolean {
    const prev = this.state.currentPhase;
    log.info(`[phase] setCurrentPhase(${target}) prev=${prev}`);
    if (target === prev) {
      log.info(`[phase] same-phase re-entry (${target}) — no change`);
      return false;
    }
    this.state.currentPhase = target;
    return true;
  }

  /**
   * Progression driver: scan text for skill invocations and move to each invoked
   * phase in turn. verify/review/finish cannot start a fresh workflow from idle;
   * design/plan/implement can.
   */
  onInputText(text: string): boolean {
    let changed = false;
    for (const line of text.split(/\r?\n/)) {
      const skill = parseSkillName(line);
      if (!skill) continue;
      const phase = SKILL_TO_PHASE[skill] ?? null;
      log.info(`[phase] onInputText skill=${skill} phase=${phase}`);
      if (phase === null) continue;

      if (this.state.currentPhase === null && FRESH_START_BLOCKED.has(phase)) {
        log.info(`[phase] onInputText skipping ${phase} — no active workflow`);
        continue;
      }
      if (this.setCurrentPhase(phase)) changed = true;
    }
    return changed;
  }

  /**
   * Detect artifact writes. A design doc (`-design.md` under the design-doc dir — docs/ff/designs/
   * when committed, .ff/designs/ when local) or a task-plan (`-task-plan.md` under .ff/task-plans/)
   * is recorded into the machine's doc slots. Never moves the pointer. Returns true if recorded.
   */
  onFileWritten(filePath: string): boolean {
    if (DESIGN_DOC.test(filePath) && DESIGN_DOC_DIRS.some((d) => isInsideDir(filePath, d))) {
      return this.recordDoc("design", filePath);
    }
    if (TASK_PLAN_DOC.test(filePath) && isInsideDir(filePath, FF_TASK_PLANS_DIR)) {
      return this.recordDoc("plan", filePath);
    }
    return false;
  }

  /** Restore the most recent phase-progression snapshot from a session branch. */
  static reconstructFromBranch(branch: SessionEntry[]): PhaseProgressionState | null {
    let latest: PhaseProgressionState | null = null;
    for (const entry of branch) {
      if (entry.type !== "custom") continue;
      if ((entry as CustomEntry).customType !== PHASE_PROGRESSION_ENTRY_TYPE) continue;
      const data = (entry as CustomEntry<PhaseProgressionState>).data;
      if (data && typeof data === "object") latest = structuredClone(data);
    }
    return latest;
  }
}

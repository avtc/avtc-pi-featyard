// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Per-Feature State Management
 *
 * Manages individual state files for each feature, stored at
 * `.ff/feature-state/{slug}.json` (co-located with artifacts under the single `.ff` junction to
 * `~/.pi/feature-flow/artifacts/<key>/`). A one-time migration (workflow-monitor activation)
 * relocates legacy `.pi/feature-flow-state-{slug}.json` files to this location.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Pass as `dir` when using the default state directory. */
export const DEFAULT_DIR: string | null = null;

/** Signature of the skill-command expander injected into workflow-monitor DI interfaces. */
export type ExpandSkillCommandFn = (
  text: string,
  featureStateOverride: FeatureState | null,
  agentName: string | null,
) => string;

import { log } from "../log.js";
import { type Phase, type PhaseProgressionState, WORKFLOW_PHASES } from "../phases/phase-progression.js";
import type { FeatureSession } from "../state/feature-session.js";

// --- Artifact directory constants (single source of truth) ---
// Design docs live either in-repo (docs/ff/designs/, committed) or out-of-repo under .ff/designs/
// (the gitignored .ff/ junction), per the designDocStorage setting. Task-plans, research, and
// reviews always live under .ff/.
export {
  DESIGN_DOC_DIRS,
  type DesignDocStorageMode,
  FF_RESEARCH_DIR,
  FF_REVIEWS_DIR,
  FF_TASK_PLANS_DIR,
  resolveDesignRelativeDir,
} from "./artifact-paths.js";

// --- Slug extraction ---

const DESIGN_DOC_RE = /(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)-design\.md$/;
const PLAN_DOC_RE = /(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)-task-plan\.md$/;

/**
 * Extract a feature slug from a design doc file path.
 * Returns null if the path doesn't match the design doc pattern.
 */
export function featureSlugFromDesignDoc(filePath: string): string | null {
  const match = filePath.match(DESIGN_DOC_RE);
  return match?.[1] ?? null;
}

/**
 * Extract a feature slug from a task-plan doc file path.
 * Returns null if the path doesn't match the task-plan pattern.
 */
export function featureSlugFromPlanDoc(filePath: string): string | null {
  const match = filePath.match(PLAN_DOC_RE);
  return match?.[1] ?? null;
}

// --- Feature state type ---

export type ExecutionMode = "checkpoint" | "subagent" | "subagent-fork";

/** Map a settings.implementMode value to an ExecutionMode. */
export function flowToExecutionMode(flow: string | undefined): ExecutionMode {
  if (flow === "subagent-driven") return "subagent";
  if (flow === "subagent-driven-fork") return "subagent-fork";
  return "checkpoint";
}

/** Check if the given mode is any subagent variant (subagent or subagent-fork). */
export function isSubagentMode(mode: string | undefined): mode is "subagent" | "subagent-fork" {
  return mode === "subagent" || mode === "subagent-fork";
}

/** The review phase this entry belongs to. Entries predating phase tagging lack this
 *  field and are excluded from reports (see getReportableReviewHistory). */
export type ReviewPhase = "design" | "plan" | "review";

export interface ReviewHistoryEntry {
  phase: ReviewPhase;
  loopNumber: number;
  issuesFound: number;
  falsePositives: number;
  cannotFixIssues: number;
  timestamp: string;
}

export interface FeatureState {
  featureSlug: string;
  /** The phase pointer (currentPhase + design/plan doc paths). Status is derived from currentPhase + completedAt. */
  workflow: PhaseProgressionState;
  /** Git context for the feature: the working branch, the base branch merged at finish, the commit SHA captured when execution began, and the worktree path (null outside worktree policy). */
  git: {
    branch: string | null;
    /** The git commit SHA captured at the moment execution begins. Stays fixed for the feature's lifetime. */
    baseCommitSha: string | null;
    worktreePath: string | null;
    baseBranch: string | null;
  };
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  sessionFiles: string[];
  featureId: number | null;

  // --- per-phase DATA (status is derived from workflow.currentPhase + completedAt) ---
  design: {
    /** Design document path (recorded on write, recovered from disk on resume); null until created. */
    doc: string | null;
    /** ff-design-review sub-loop currently active. */
    reviewActive: boolean;
    /** ff-design-review iteration count. */
    reviewLoopCount: number;
  };
  plan: {
    /** Task-plan document path; null until created. */
    doc: string | null;
    /** ff-plan-verifier iteration count. */
    verifyLoopCount: number;
    /** ff-plan-review sub-loop currently active. */
    reviewActive: boolean;
    /** ff-plan-review iteration count. */
    reviewLoopCount: number;
  };
  implement: {
    /** Per-plan-task gate-round counts dispatched by task_ready_advance (key = plan-task designation string). */
    taskReviewRounds: Record<string, number>;
    /**
     * The plan-task the implementer is currently on (set by task_ready_advance), or null.
     * Durable source of truth — drives the widget task segment, {{PI_FF_CURRENT_TASK}},
     * per-task report/known-issues paths, and the per-task review-loop key. Survives resume.
     */
    currentTask: string | null;
  };
  verify: {
    /** ff-feature-verifier iteration count. */
    verifyLoopCount: number;
  };
  review: {
    /** review-phase iteration count. */
    reviewLoopCount: number;
    /** Per-round review outcomes (drives the end-of-loop report). */
    reviewHistory: ReviewHistoryEntry[];
  };
}

// --- Path helpers ---

/**
 * Returns the feature-state directory: `<cwd>/.ff/feature-state` (a real path through the
 * `.ff` junction into the external artifact store). The directory is created lazily by callers
 * that write (`saveFeatureState`); activation also pre-creates it via `ensureFfJunction`.
 */
export function stateDir(): string {
  return path.join(process.cwd(), ".ff", "feature-state");
}

/**
 * Returns the full path to the state file for a given feature slug: `<dir>/<slug>.json`.
 */
export function stateFilePath(slug: string, dir: string | null): string {
  const base = dir ?? stateDir();
  return path.join(base, `${slug}.json`);
}

// --- Artifact accessors ---

/** Get the design doc path from a FeatureState. */
export function getDesignDoc(state: FeatureState): string | null {
  return state.design.doc ?? null;
}

// --- State creation ---

function emptyWorkflowPhases(): Record<Phase, "pending"> {
  return Object.fromEntries(WORKFLOW_PHASES.map((p) => [p, "pending"])) as Record<Phase, "pending">;
}
void emptyWorkflowPhases;

/**
 * Build a fresh idle progression state (pointer null). Factory functions spread
 * the base feature state and override only what differs.
 */
function freshWorkflowState(): PhaseProgressionState {
  return { currentPhase: null, designDoc: null, planDoc: null };
}

/** Fresh per-phase data objects (all zeroed / empty). */
function freshPhaseData(): Pick<FeatureState, "design" | "plan" | "implement" | "verify" | "review"> {
  return {
    design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
    plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
    implement: { taskReviewRounds: {}, currentTask: null },
    verify: { verifyLoopCount: 0 },
    review: { reviewLoopCount: 0, reviewHistory: [] },
  };
}

/**
 * Create the base feature state with common default fields.
 * Factory functions spread this and override only the fields that differ.
 */
function createBaseFeatureState(slug: string): FeatureState {
  const now = new Date().toISOString();
  return {
    featureSlug: slug,
    git: {
      branch: null,
      baseCommitSha: null,
      worktreePath: null,
      baseBranch: null,
    },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    workflow: freshWorkflowState(),
    sessionFiles: [],
    featureId: null,
    ...freshPhaseData(),
  };
}

export function createFeatureState(slug: string, designDoc: string): FeatureState {
  return {
    ...createBaseFeatureState(slug),
    workflow: { currentPhase: "design", designDoc, planDoc: null },
    design: { doc: designDoc, reviewActive: false, reviewLoopCount: 0 },
  };
}

/**
 * Create a new feature state from a plan doc (user started from plan phase,
 * skipping design). Design is marked complete (bypassed), plan is complete.
 */
export function createFeatureStateFromPlan(slug: string, planDoc: string): FeatureState {
  return {
    ...createBaseFeatureState(slug),
    workflow: { currentPhase: "plan", designDoc: null, planDoc },
    plan: { doc: planDoc, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
  };
}

/**
 * Create a feature state for a kanban-picked feature.
 * Advances phases based on the kanban lane the feature was in.
 */
export function createFeatureStateFromKanban(
  slug: string,
  opts: { lane: string; branch: string | null; worktreePath: string | null },
): FeatureState {
  // currentPhase + completedAt fully determine phase status (derived):
  //   ready/in-progress lane → pointer at implement (design+plan done, derived)
  //   uat lane               → pointer at uat (design..review done, derived)
  //   done lane              → completedAt set (everything done, derived)
  let currentPhase: Phase | null = null;
  let completedAt: string | null = null;
  if (opts.lane === "ready" || opts.lane === "in-progress") {
    currentPhase = "implement";
  } else if (opts.lane === "uat") {
    currentPhase = "uat";
  } else if (opts.lane === "done") {
    completedAt = new Date().toISOString();
  }

  return {
    ...createBaseFeatureState(slug),
    git: {
      branch: opts.branch ?? null,
      baseCommitSha: null,
      worktreePath: opts.worktreePath ?? null,
      baseBranch: null,
    },
    completedAt,
    workflow: { currentPhase, designDoc: null, planDoc: null },
  };
}

/**
 * Create a feature state for a sub-feature registered via add_to_backlog.
 * Brainstorm stays pending so the auto-designer runs a full design session.
 * The design doc is stored as an artifact reference only if provided (non-empty).
 */
export function createFeatureStateForSubFeature(slug: string, designDoc: string): FeatureState {
  return {
    ...createBaseFeatureState(slug),
    workflow: { currentPhase: null, designDoc: designDoc || null, planDoc: null }, // all pending
    design: { doc: designDoc || null, reviewActive: false, reviewLoopCount: 0 },
  };
}

/**
 * Mark a feature state as done. Returns a new object (does not mutate).
 */
export function markFeatureDone(state: FeatureState): FeatureState {
  return {
    ...state,
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// --- In-memory cache ---

/** Cache key: `${slug}::${dir ?? ''}` */
const _stateCache = new Map<string, FeatureState | null>();

function cacheKey(slug: string, dir: string | null): string {
  return `${slug}::${dir ?? stateDir()}`;
}

/** Invalidate cached state for a slug (call after save or delete). */
export function invalidateFeatureStateCache(slug: string, dir: string | null): void {
  _stateCache.delete(cacheKey(slug, dir));
}

/** Clear the entire feature state cache. */
export function clearFeatureStateCache(): void {
  _stateCache.clear();
}

// --- File I/O ---

/**
 * Save feature state to disk.
 */
export function saveFeatureState(state: FeatureState, dir: string | null): void {
  const filePath = stateFilePath(state.featureSlug, dir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  _stateCache.delete(cacheKey(state.featureSlug, dir));
}

export function loadFeatureState(slug: string, dir: string | null): FeatureState | null {
  const key = cacheKey(slug, dir);
  const cached = _stateCache.get(key);
  if (cached !== undefined) return cached;

  const filePath = stateFilePath(slug, dir);
  if (!fs.existsSync(filePath)) {
    // Cache null — saveFeatureState invalidates the cache when it creates the file
    _stateCache.set(key, null);
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as FeatureState;
    _stateCache.set(key, parsed);
    return parsed;
  } catch (err) {
    log.warn(`Corrupted feature state file for "${slug}": ${filePath} — ${err instanceof Error ? err.message : err}`);
    // Don't cache null for corrupted files — they may be fixed between calls
    return null;
  }
}

/**
 * Delete a feature state file. Does not throw if the file doesn't exist.
 */
export function deleteStateFile(slug: string, dir: string | null): void {
  const filePath = stateFilePath(slug, dir);
  _stateCache.delete(cacheKey(slug, dir));
  try {
    fs.unlinkSync(filePath);
  } catch {
    // File doesn't exist — that's fine
  }
}

/**
 * Scan for all active feature state files. Returns them sorted by `updatedAt`
 * descending (most recently updated first).
 */
export function scanActiveFeatures(dir: string | null): FeatureState[] {
  const base = dir ?? stateDir();
  if (!fs.existsSync(base)) return [];

  const files = fs.readdirSync(base);
  // Each feature's state is one `<slug>.json` file in the state dir.
  const stateFiles = files.filter((f) => f.endsWith(".json"));

  const features: FeatureState[] = [];
  for (const file of stateFiles) {
    try {
      const raw = fs.readFileSync(path.join(base, file), "utf-8");
      const state = JSON.parse(raw) as FeatureState;
      // Structural guard: a stray valid-JSON .json file (not a feature state) is skipped — only
      // files carrying a featureSlug are features. Guards the relaxed `.endsWith(".json")` filter.
      if (!state.featureSlug) continue;
      if (state.completedAt == null) {
        features.push(state);
      }
    } catch {
      // Skip invalid files
    }
  }

  // Sort by updatedAt descending
  features.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return features;
}

/** Sync workflow state from handler into feature state (eliminates repeated `as any` casts). */
export function syncWorkflowToFeatureState(featureState: FeatureState, handler: FeatureSession): void {
  const ws = handler.getWorkflowState();
  if (!ws) return;
  featureState.workflow = ws;
  // mirror the doc artifacts the machine tracks into the phase-data objects
  featureState.design.doc = ws.designDoc;
  featureState.plan.doc = ws.planDoc;
}

/** Sync workflow state from handler into feature state and persist to disk. */
export function syncAndSaveFeatureState(featureState: FeatureState, handler: FeatureSession): void {
  syncWorkflowToFeatureState(featureState, handler);
  saveFeatureState(featureState, DEFAULT_DIR);
}

/** Maximum number of review history entries retained. Older entries are pruned. */
const MAX_REVIEW_HISTORY = 100;

/** Record a review loop entry into feature state's review.reviewHistory array. */
export function recordReviewHistory(featureState: FeatureState, entry: Omit<ReviewHistoryEntry, "timestamp">): void {
  featureState.review.reviewHistory = featureState.review.reviewHistory ?? [];
  featureState.review.reviewHistory.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  // Prune oldest entries to prevent unbounded growth
  if (featureState.review.reviewHistory.length > MAX_REVIEW_HISTORY) {
    featureState.review.reviewHistory = featureState.review.reviewHistory.slice(-MAX_REVIEW_HISTORY);
  }
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Feature activation — bring a feature into the active handler session from a
 * design-doc write, plan-doc write, or skill invocation.
 *
 * Three entry points share a common bootstrap skeleton (load-or-create +
 * optional kanban-link + activate + track + setPhase):
 *  - {@link activateFromDocWrite}   — design/plan doc WRITE (tool_call path)
 *  - {@link activateFromPlanSkill}  — ff-implement skill invocation (plan-doc source)
 *  - {@link activateFromDesignSkill} — ff-plan / ff-design skill invocation (design-doc source)
 *
 * The guardrails engine and the events/input router call these; the activation
 * logic itself has no knowledge of pi.on events.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExecFn, resolveMainRepoPath, resolveMainRepoPathSync } from "../git/worktrees/worktree-lifecycle.js";
import { interactiveSessionIdFor } from "../kanban/data/kanban-database.js";
import type { Lane } from "../kanban/data/kanban-types.js";
import { ensureKanbanFeature } from "../kanban/ensure-feature.js";
import { log } from "../log.js";
import { setActiveFeatureEnv } from "../phases/env-sync.js";
import type { Phase } from "../phases/phase-progression.js";
import type { FeatureSession } from "../state/feature-session.js";
import { trackSessionFileInState } from "./feature-management.js";
import {
  createFeatureState,
  createFeatureStateFromPlan,
  DEFAULT_DIR,
  type FeatureState,
  loadFeatureState,
  saveFeatureState,
} from "./feature-state.js";

/** Callbacks the doc-write activator needs from the composition root (git exec + sub-feature writer). */
export interface ActivationDeps {
  /** Build a git exec helper from the extension context (for main-repo resolution). */
  createGitExec: (ctx: ExtensionContext) => ExecFn;
  /** Handle a write to a doc belonging to a non-active (sub) feature. */
  handleSubFeatureWrite: (
    ctx: ExtensionContext,
    slug: string,
    filePath: string,
    artifactType: "design" | "plan",
    activeSlugForLog: string | null,
  ) => Promise<void>;
}

/** Doc-slot accessors — how to read/write the design or plan doc path on a FeatureState. */
export interface DocSlotAccess {
  getDoc: (s: FeatureState) => string | null;
  setDoc: (s: FeatureState, value: string) => void;
}

/** Common bootstrap: link a freshly-created feature to the kanban board (best-effort). */
async function linkToKanbanAsync(
  ctx: ExtensionContext,
  deps: ActivationDeps,
  featureState: FeatureState,
  slug: string,
  lane: Lane,
): Promise<void> {
  try {
    const { ensureDatabase } = await import("../kanban/kanban-bridge.js");
    const kanbanDb = await ensureDatabase();
    let mainRepoPath: string | null = null;
    try {
      const gitExec = deps.createGitExec(ctx);
      mainRepoPath = await resolveMainRepoPath(gitExec);
    } catch {
      // Not in a git repo or worktree
    }
    // Mutates featureState in place (sets featureId) + persists it; featureState
    // is our sole-owner record, adopted via setActiveFeatureState by the caller.
    await ensureKanbanFeature(kanbanDb, featureState, mainRepoPath, interactiveSessionIdFor(slug), lane);
  } catch {
    // Kanban not available — feature state is still created + activated
  }
}

/** Best-effort kanban link using the SYNC main-repo resolver (no git exec needed). */
async function linkToKanbanSync(featureState: FeatureState, slug: string, lane: Lane): Promise<void> {
  try {
    const { ensureDatabase } = await import("../kanban/kanban-bridge.js");
    const kanbanDb = await ensureDatabase();
    let mainRepoPath: string | null = null;
    try {
      mainRepoPath = resolveMainRepoPathSync();
    } catch {
      // Not in a git repo — kanban linking proceeds with a null path
    }
    await ensureKanbanFeature(kanbanDb, featureState, mainRepoPath, interactiveSessionIdFor(slug), lane);
  } catch {
    // Kanban not available — feature state is still created + activated
  }
}

/** Common tail: activate the feature in the handler + track its session file. */
function activateInHandler(
  ctx: ExtensionContext,
  handler: FeatureSession,
  featureState: FeatureState,
  slug: string,
): void {
  // Activate FIRST so the handler holds the authoritative record; then tracking
  // mutates that live ref directly (single source of truth) instead of loading a
  // separate cached object that a later write-through would stomp.
  setActiveFeatureEnv(slug);
  handler.setActiveFeatureState(featureState);
  trackSessionFileInState(ctx, slug);
}

/**
 * Activate a feature from a design-doc or plan-doc WRITE.
 *
 * Returns true if the activation (re-activation or new creation) mutated state;
 * false for a sub-feature write (delegated to handleSubFeatureWrite) or a no-op
 * (the doc's feature is already active — recordDoc already recorded it).
 */
export async function activateFromDocWrite(
  ctx: ExtensionContext,
  handler: FeatureSession,
  deps: ActivationDeps,
  opts: {
    slug: string;
    filePath: string;
    artifactType: "design" | "plan";
    kanbanLane: Lane;
    docSlot: DocSlotAccess;
    create: (slug: string, filePath: string) => FeatureState;
    postCreate: (() => Promise<void>) | null;
  },
): Promise<boolean> {
  const { slug, filePath, artifactType, kanbanLane, docSlot, create, postCreate } = opts;
  const activeSlug = handler.getActiveFeatureSlug();
  const isAlreadyActive = activeSlug && activeSlug !== slug;

  if (isAlreadyActive) {
    await deps.handleSubFeatureWrite(ctx, slug, filePath, artifactType, activeSlug ?? null);
    return false;
  }

  // Active feature === slug: doc already recorded by recordDoc — no-op.
  if (activeSlug) return false;

  // No active feature — bootstrap from the file.
  const existing = loadFeatureState(slug, DEFAULT_DIR);
  if (existing) {
    if (!docSlot.getDoc(existing)) {
      docSlot.setDoc(existing, filePath);
      saveFeatureState(existing, DEFAULT_DIR);
    }
    // Re-activate an existing feature whose handler state was lost (e.g. after
    // a reload that failed to bind). ensureKanbanFeature no-ops when featureId
    // is set, so re-linking is idempotent and skipped here.
    setActiveFeatureEnv(slug);
    handler.setActiveFeatureState(existing);
    return true;
  }

  // No state file — create a new feature, register it in the kanban, activate.
  const featureState = create(slug, filePath);
  saveFeatureState(featureState, DEFAULT_DIR);
  await linkToKanbanAsync(ctx, deps, featureState, slug, kanbanLane);
  activateInHandler(ctx, handler, featureState, slug);
  if (postCreate) await postCreate();

  // If still nothing is active (e.g. activation deferred), load + activate.
  if (!handler.getActiveFeatureSlug()) {
    const loaded = loadFeatureState(slug, DEFAULT_DIR);
    if (loaded) handler.setActiveFeatureState(loaded);
    setActiveFeatureEnv(slug);
  }
  return true;
}

/**
 * Activate a feature from an ff-implement skill invocation (plan-doc source).
 * Creates from the plan-doc path if no state exists; sets phase to "plan".
 * No kanban linking (the plan-doc write path or a later ff-plan handles that).
 */
export function activateFromPlanSkill(
  ctx: ExtensionContext,
  handler: FeatureSession,
  slug: string,
  planDocPath: string,
): void {
  const existing = loadFeatureState(slug, DEFAULT_DIR);
  if (existing) {
    handler.setActiveFeatureState(existing);
    setActiveFeatureEnv(slug);
    return;
  }
  const featureState = createFeatureStateFromPlan(slug, planDocPath);
  saveFeatureState(featureState, DEFAULT_DIR);
  handler.setActiveFeatureState(featureState);
  trackSessionFileInState(ctx, slug);
  setActiveFeatureEnv(slug);
  handler.setCurrentPhase("plan");
}

/**
 * Activate a feature from an ff-plan / ff-design skill invocation (design-doc
 * source). Activates an existing feature or creates + kanban-links a new one,
 * then advances to the target phase (plan for ff-plan, design for ff-design).
 * Uses the SYNC main-repo resolver (no git exec / ActivationDeps needed).
 */
export async function activateFromDesignSkill(
  ctx: ExtensionContext,
  handler: FeatureSession,
  slug: string,
  designDocPath: string,
  targetPhase: Phase,
): Promise<void> {
  // A feature is already active — never displace it.
  if (handler.getActiveFeatureSlug()) return;

  const existing = loadFeatureState(slug, DEFAULT_DIR);
  if (existing) {
    setActiveFeatureEnv(slug);
    handler.setActiveFeatureState(existing);
    log.info(`[workflow] activateFromDesignSkill: re-activated existing feature ${slug}`);
    return;
  }

  const featureState = createFeatureState(slug, designDocPath);
  saveFeatureState(featureState, DEFAULT_DIR);
  const lane: Lane = targetPhase === "plan" ? "in-progress" : "design";
  await linkToKanbanSync(featureState, slug, lane);
  activateInHandler(ctx, handler, featureState, slug);
  // createFeatureState starts at "design"; advance to plan when invoked via
  // ff-plan (the design doc already exists → design effectively complete).
  if (targetPhase === "plan") {
    handler.setCurrentPhase("plan");
  }
  log.info(`[workflow] activateFromDesignSkill: created + activated feature ${slug} (targetPhase=${targetPhase})`);
}

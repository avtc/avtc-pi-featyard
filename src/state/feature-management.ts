// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Feature management functions — activating, resuming, tracking, and recovering
 * feature state for workflow features.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBranchOrShortSha, getHeadSha, PROCESS_CWD } from "../git/git-queries.js";
import { log } from "../log.js";
import { setActiveFeatureEnv, syncEnvVarsFromState } from "../phases/env-sync.js";
import { isPhaseActive, isPhaseDone, type Phase } from "../phases/phase-progression.js";
import { getSettings } from "../settings/settings-ui.js";
import type { FeatureSession } from "../state/feature-session.js";
import {
  createFeatureStateForSubFeature,
  DEFAULT_DIR,
  DESIGN_DOC_DIRS,
  type FeatureState,
  FY_TASK_PLANS_DIR,
  stateFilePath as featureStateFilePath,
  loadFeatureState,
  saveFeatureState,
} from "./feature-state.js";
import { isSubagentSession } from "./state-persistence.js";

/** Pass as `applyModelOverrideForPhase` when no model override is needed. */
export const NO_MODEL_OVERRIDE: ((pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>) | null =
  null;

/**
 * Cross-extension bridge for kanban auto-designer: activates a feature slug
 * and advances the workflow to the specified phase.
 */
export async function activateWorkflowForFeature(
  slug: string,
  phase: Phase,
  ctx: ExtensionContext | null,
  applyModelOverrideForPhase: ((pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>) | null,
): Promise<void> {
  const handler = globalThis.__piWorkflowMonitor?.handler ?? null;
  if (!handler) {
    log.warn(
      `[workflow] activateWorkflowForFeature: handler not registered on globalThis, skipping (slug=${slug}, phase=${phase})`,
    );
    return;
  }
  // Set the active feature env so subagent tool resolves the right slug.
  setActiveFeatureEnv(slug);

  // Load the durable record into the handler (seeds the workflow tracker);
  // guardrails reset since they are session-only.
  try {
    const state = loadFeatureState(slug, DEFAULT_DIR);
    if (state) {
      handler.setActiveFeatureState(state);
      log.info(
        `[workflow] activateWorkflowForFeature: reconstructed state from ${featureStateFilePath(slug, DEFAULT_DIR)}`,
      );
    }
  } catch (err) {
    log.warn(`[workflow] activateWorkflowForFeature: failed to reconstruct state: ${err}`);
  }

  // Now advance to the target phase
  handler.setCurrentPhase(phase);
  log.info(`[workflow] activateWorkflowForFeature: slug=${slug}, phase=${phase}`);

  // Apply model override for the new phase
  const refs = globalThis.__piWorkflowMonitor?.modelOverrideRefs;
  if (refs?.pi && ctx && applyModelOverrideForPhase) {
    await applyModelOverrideForPhase(refs.pi, ctx, phase);
  }
}

/**
 * Cross-extension bridge for kanban auto-agent: resumes a feature that has
 * prior session history. Reconstructs workflow state from the feature state
 * file WITHOUT advancing to a new phase.
 */
export async function resumeWorkflowForFeature(
  slug: string,
  ctx: ExtensionContext | null,
  applyModelOverrideForPhase: ((pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>) | null,
): Promise<FeatureState | null> {
  const handler = globalThis.__piWorkflowMonitor?.handler ?? null;
  if (!handler) {
    log.warn(`[workflow] resumeWorkflowForFeature: handler not registered on globalThis, skipping (slug=${slug})`);
    return null;
  }

  // Set the active feature env so subagent tool resolves the right slug.
  setActiveFeatureEnv(slug);

  // Reconstruct handler state from feature state file
  let featureState: FeatureState | null = null;
  try {
    featureState = loadFeatureState(slug, DEFAULT_DIR);
    if (featureState) {
      handler.setActiveFeatureState(featureState);
      log.info(
        `[workflow] resumeWorkflowForFeature: reconstructed state from ${featureStateFilePath(slug, DEFAULT_DIR)}`,
      );
    }
  } catch (err) {
    log.warn(`[workflow] resumeWorkflowForFeature: failed to reconstruct state: ${err}`);
  }

  // Sync env vars from restored state
  syncEnvVarsFromState(handler);

  // Capture base commit SHA if in implement phase and not yet captured (path 10 — setFullState bypasses onPhaseChange)
  if (featureState && handler.getWorkflowState()?.currentPhase === "implement" && !featureState.git.baseCommitSha) {
    captureBaseCommitSha(featureState);
  }

  // Apply model override for the restored phase
  const refs = globalThis.__piWorkflowMonitor?.modelOverrideRefs;
  if (refs?.pi && ctx && applyModelOverrideForPhase) {
    const currentPhase = handler.getWorkflowState()?.currentPhase;
    if (currentPhase) {
      await applyModelOverrideForPhase(refs.pi, ctx, currentPhase);
    }
  }

  log.info(
    `[workflow] resumeWorkflowForFeature: slug=${slug}, currentPhase=${handler.getWorkflowState()?.currentPhase ?? "null"}`,
  );
  return featureState;
}

/**
 * Capture the base commit SHA and branch name for a feature at execution start.
 * Called from onPhaseChange (when entering implement phase) and resumeWorkflowForFeature.
 * Guarded by !baseCommitSha — only captures once per feature.
 */
export function captureBaseCommitSha(featureState: FeatureState): void {
  if (featureState.git.baseCommitSha) return;

  const sha = getHeadSha(PROCESS_CWD);
  if (sha) {
    featureState.git.baseCommitSha = sha;
  } else {
    log.warn(
      `[workflow] captureBaseCommitSha: git rev-parse HEAD failed for ${featureState.featureSlug}, baseCommitSha remains null`,
    );
    // Git unavailable — skip saving unchanged state
    return;
  }

  if (!featureState.git.branch) {
    const settings = getSettings();
    // worktree policy uses conventional "feature/{slug}" branch name
    featureState.git.branch =
      settings.branchPolicy === "worktree" ? `feature/${featureState.featureSlug}` : getBranchOrShortSha(PROCESS_CWD);
  }

  saveFeatureState(featureState, DEFAULT_DIR);
}

/**
 * Track the current session file in the feature state for context recovery.
 * Skips subagent sessions. Idempotent — won't duplicate.
 */
export function trackSessionFileInState(ctx: ExtensionContext, slug: string): void {
  // Skip subagent sessions — only track root sessions for context recovery
  if (isSubagentSession()) {
    log.info(`[trackSessionFile] skipped: subagent session (slug=${slug})`);
    return;
  }
  if (ctx.sessionManager?.getSessionFile) {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      // Active feature: mutate the handler's authoritative record (single source of
      // truth) and write it through. Non-active feature (e.g. a registered
      // sub-feature): the handler holds no record, so load/mutate/save the file.
      const handler = globalThis.__piWorkflowMonitor?.handler ?? null;
      const active = handler?.getActiveFeatureState();
      const featureState = active?.featureSlug === slug ? active : loadFeatureState(slug, DEFAULT_DIR);
      if (featureState && !featureState.sessionFiles.includes(sessionFile)) {
        featureState.sessionFiles.push(sessionFile);
        saveFeatureState(featureState, DEFAULT_DIR);
        log.info(
          `[trackSessionFile] tracked: sessionFile=${sessionFile} (slug=${slug}, total=${featureState.sessionFiles.length})`,
        );
      } else if (!featureState) {
        log.warn(`[trackSessionFile] no feature state found for slug=${slug}`);
      } else {
        log.info(`[trackSessionFile] already tracked: sessionFile=${sessionFile} (slug=${slug})`);
      }
    } else {
      log.warn(`[trackSessionFile] sessionFile is null/empty (slug=${slug}, hasUI=${ctx.hasUI})`);
    }
  } else {
    log.warn(`[trackSessionFile] no sessionManager or getSessionFile (slug=${slug}, hasUI=${ctx.hasUI})`);
  }
}

/**
 * Recover missing workflow artifacts from disk by checking for expected files.
 */
export function recoverArtifactsFromDisk(handler: FeatureSession): void {
  const active = handler.getActiveFeatureState();
  if (!active) return;
  const slug = active.featureSlug;
  const ws = active.workflow;

  // Design docs may live in either recognized dir (committed or local); recovery scans BOTH
  // so a doc written under either mode is found regardless of the current designDocStorage mode.
  const designDirs = DESIGN_DOC_DIRS.map((d) => path.join(process.cwd(), d));
  const taskPlansDir = path.join(process.cwd(), FY_TASK_PLANS_DIR);
  const view = { currentPhase: ws.currentPhase, completedAt: active.completedAt };
  const workflowPatch: { designDoc?: string; planDoc?: string } = {};

  // Check for design doc if design artifact is missing
  if (!ws.designDoc && (isPhaseActive(view, "design") || isPhaseDone(view, "design"))) {
    const designFile = `${slug}-design.md`;
    for (const dir of designDirs) {
      const designPath = path.join(dir, designFile);
      if (fs.existsSync(designPath)) {
        log.info(`[workflow] Recovered missing design artifact from disk: ${designPath}`);
        workflowPatch.designDoc = designPath;
        break;
      }
    }
  }

  // Check for task-plan doc if plan artifact is missing
  if (!ws.planDoc && (isPhaseActive(view, "plan") || isPhaseDone(view, "plan"))) {
    const planFile = `${slug}-task-plan.md`;
    const planPath = path.join(taskPlansDir, planFile);
    if (fs.existsSync(planPath)) {
      log.info(`[workflow] Recovered missing plan artifact from disk: ${planPath}`);
      workflowPatch.planDoc = planPath;
    }
  }

  if (Object.keys(workflowPatch).length > 0) {
    // Apply the recovered docs to the in-memory record (re-seeds the workflow
    // engine) and mirror into the phase-data objects, then write-through.
    const patched: FeatureState = {
      ...active,
      workflow: { ...ws, ...workflowPatch },
      design: { ...active.design, doc: workflowPatch.designDoc ?? active.design.doc },
      plan: { ...active.plan, doc: workflowPatch.planDoc ?? active.plan.doc },
    };
    handler.setFullState({ featureState: patched });
    saveFeatureState(patched, DEFAULT_DIR);
  }
}

/**
 * Handle a sub-feature write when a different feature is already active.
 * Checks the kanban DB for a registered sub-feature card. If found, creates/updates
 * sub-feature state. If not found (hallucinated filename), silently skips.
 */
export async function handleSubFeatureWrite(
  ctx: ExtensionContext,
  subSlug: string,
  subFilePath: string,
  artifactType: "design" | "plan",
  activeSlugForLog: string | null,
): Promise<void> {
  try {
    const { getDatabaseInstance } = await import("../kanban/kanban-bridge.js");
    const kanbanDb = getDatabaseInstance();
    if (kanbanDb) {
      const { detectProject } = await import("../kanban/data/kanban-detect-project.js");
      const projectId = await detectProject(kanbanDb, process.cwd());
      const kanbanFeature = projectId ? kanbanDb.findFeatureBySlug(subSlug, projectId) : null;
      if (kanbanFeature) {
        // Registered sub-feature
        const existingSubState = loadFeatureState(subSlug, DEFAULT_DIR);
        if (existingSubState) {
          // State already exists — just update the doc artifact
          const hasDoc = artifactType === "design" ? !!existingSubState.design.doc : !!existingSubState.plan.doc;
          if (!hasDoc) {
            if (artifactType === "design") existingSubState.design.doc = subFilePath;
            else existingSubState.plan.doc = subFilePath;
            saveFeatureState(existingSubState, DEFAULT_DIR);
          }
        } else {
          // No state yet — create new sub-feature state
          const designDoc = artifactType === "design" ? subFilePath : "";
          const subState = createFeatureStateForSubFeature(subSlug, designDoc);
          subState.featureId = kanbanFeature.id;
          if (artifactType === "plan") {
            subState.plan.doc = subFilePath;
          }
          saveFeatureState(subState, DEFAULT_DIR);
          trackSessionFileInState(ctx, subSlug);
          // Update kanban feature columns
          try {
            const kanbanUpdate: {
              featureId: number;
              stateFile: string;
              designDoc?: string;
              planDoc?: string;
            } = {
              featureId: kanbanFeature.id,
              stateFile: featureStateFilePath(subSlug, DEFAULT_DIR),
            };
            if (artifactType === "design") {
              kanbanUpdate.designDoc = subFilePath;
            } else {
              kanbanUpdate.planDoc = subFilePath;
            }
            kanbanDb.updateFeature(kanbanUpdate);
          } catch (e) {
            log.error(`[workflow] Failed to update kanban feature columns for sub-feature ${subSlug}:`, e);
          }
        }
        log.info(
          `[workflow] Registered sub-feature ${subSlug} ${artifactType} doc written while ${activeSlugForLog} is active`,
        );
      }
      // No kanban card — silently skip (hallucinated filename)
    }
  } catch (e) {
    log.error(`[workflow] handleSubFeatureWrite failed for ${subSlug}:`, e);
  }
}

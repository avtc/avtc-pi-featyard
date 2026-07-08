// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Kanban ↔ Feature State linking hooks.
 *
 * Provides helpers that bridge the kanban database and per-feature state files,
 * used when design docs are written or features are picked by auto-agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "../log.js";
import type { FeatureState } from "../state/feature-state.js";
import { DEFAULT_DIR, getDesignDoc, saveFeatureState, stateDir, stateFilePath } from "../state/feature-state.js";
import type { KanbanDatabase } from "./data/kanban-database.js";
import type { Lane } from "./data/kanban-types.js";
import { generateFeatureMeta } from "./kanban-generate-title.js";

/**
 * Extract a human-readable title from a slug by removing the date prefix and capitalizing words.
 * Used as fallback when LLM title generation is not available.
 *
 * "2026-05-22-auto-agent-notifications-and-widget-improvement" → "Auto Agent Notifications And Widget Improvement"
 */
function titleFromSlug(slug: string): string {
  // Remove date prefix (YYYY-MM-DD-)
  const withoutDate = slug.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  // Capitalize words, replace hyphens with spaces
  return withoutDate
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Extract the first heading and paragraph from a markdown design doc.
 * Returns { title, description } or null if the file can't be read.
 */
function extractMetaFromDesignDoc(designDocPath: string | null): { title: string; description: string } | null {
  if (!designDocPath || !fs.existsSync(designDocPath)) return null;
  try {
    const content = fs.readFileSync(designDocPath, "utf-8");
    // Extract first heading (# Title)
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim();
    // Extract first non-heading, non-empty paragraph
    const lines = content.split("\n");
    let description = "";
    let pastFrontmatter = false;
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip frontmatter
      if (!pastFrontmatter && trimmed === "---") {
        pastFrontmatter = true;
        continue;
      }
      if (pastFrontmatter && trimmed === "---") {
        pastFrontmatter = false;
        continue;
      }
      if (pastFrontmatter) continue;
      // Skip headings and empty lines
      if (trimmed.startsWith("#") || trimmed === "") continue;
      // Skip metadata lines (Date:, Status:, Branch:, **Date**, etc.)
      if (/^\*?\*?(Date|Status|Branch|Author)/i.test(trimmed)) continue;
      if (/^---/.test(trimmed)) continue;
      description = trimmed;
      break;
    }
    if (title || description) {
      return { title: title ?? "", description: description ?? "" };
    }
  } catch {
    // Can't read file — that's fine
  }
  return null;
}

/**
 * Ensure a kanban feature exists for the given feature state.
 *
 * If the state already has kanbanFeatureId, no-ops.
 * If a kanban feature with matching slug exists, links it.
 * Otherwise, finds or auto-creates a project for cwd and adds the feature
 * to the backlog lane with a proper title and description.
 *
 * When auto-creating a feature (user started working in TUI without adding to kanban):
 * - Uses LLM to generate title + description from design doc content
 * - Falls back to extracting title/description from markdown headings/paragraphs
 * - Final fallback: derive title from slug
 *
 * Mutates `state` in place (sets `state.featureId`) and persists it to disk.
 * The caller passes its sole-owner record and adopts it directly — consistent
 * with the handler's single-source-of-truth model.
 */
export async function ensureKanbanFeature(
  db: KanbanDatabase,
  state: FeatureState,
  resolvedCwd: string | null,
  sessionId: string | null,
  targetLane: Lane,
): Promise<void> {
  // Already linked — no-op
  if (state.featureId !== null) {
    return;
  }

  // Find or create project for current cwd (or resolved main repo path if in worktree)
  const cwd = resolvedCwd ?? process.cwd();
  let project = db.findProjectByRepoPath(cwd);
  if (!project) {
    const projectId = db.createProject({
      name: path.basename(cwd),
      repoPath: cwd,
    });
    project = {
      id: projectId,
      name: path.basename(cwd),
      repo_path: cwd,
      base_branch: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  // Try to find existing kanban feature by slug scoped to this project
  const existing = db.findFeatureBySlug(state.featureSlug, project.id);
  if (existing) {
    state.featureId = existing.id;
    // Update state_file if not already set
    if (!existing.state_file) {
      const sf = stateFilePath(state.featureSlug, stateDir());
      db.updateFeature({ featureId: existing.id, stateFile: sf });
    }
    // Lock FIRST if sessionId provided — prevents race where another agent picks up
    // the feature between the move-to-target-lane and the lock attempt
    if (sessionId) {
      const locked = db.lockFeature(existing.id, sessionId);
      if (!locked) {
        log.warn(`[kanban-hooks] failed to lock feature ${existing.id} — already locked`);
      } else {
        db.updateFeature({ featureId: existing.id, assignedSession: sessionId });
      }
    }
    // Move to the target lane if the feature is still in backlog (design doc ->
    // "design", task-plan -> "in-progress"). Called from a doc-write handler, so the
    // triggering doc always exists.
    if (existing.lane === "backlog") {
      db.moveFeature({
        featureId: existing.id,
        toLane: targetLane,
        changedBy: "workflow-monitor",
        note: `Doc written — moving from backlog to ${targetLane}`,
      });
    }
    saveFeatureState(state, DEFAULT_DIR);
    return;
  }

  // Auto-create feature with proper title and description
  const designDocPath = getDesignDoc(state);
  let title = titleFromSlug(state.featureSlug);
  let description: string | null = null;

  // Try to extract meta from design doc content
  const docMeta = extractMetaFromDesignDoc(designDocPath);
  if (docMeta?.title) {
    title = docMeta.title;
  }
  if (docMeta?.description) {
    description = docMeta.description;
  }

  // Try LLM-powered title + description generation
  try {
    const llmMeta = await generateFeatureMeta(designDocPath, title);
    if (llmMeta.title) title = llmMeta.title;
    if (llmMeta.description) description = llmMeta.description;
  } catch (err) {
    log.info(
      `[kanban-hooks] LLM title/description generation failed, using fallback: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  // Auto-create feature in backlog first, then lock + move to the target lane if
  // the triggering artifact exists. This avoids a race where the feature sits in
  // the target lane unlocked between creation and lock acquisition — no agent picks
  // from backlog, so it's safe there.
  const featureId = db.createFeature({
    projectId: project.id,
    slug: state.featureSlug,
    title,
    description,
    lane: "backlog",
    designDoc: designDocPath ?? null,
  });

  // Set state_file path
  const sf = stateFilePath(state.featureSlug, stateDir());
  db.updateFeature({ featureId, stateFile: sf });

  // Lock first (safe — still in backlog, no agent picks from there)
  if (sessionId) {
    const locked = db.lockFeature(featureId, sessionId);
    if (!locked) {
      log.warn(`[kanban-hooks] failed to lock feature ${featureId} — already locked`);
    } else {
      db.updateFeature({ featureId, assignedSession: sessionId });
    }
  }

  // Now move to the target lane — feature is locked, safe to move
  // (design doc -> "design", task-plan -> "in-progress").
  db.moveFeature({
    featureId,
    toLane: targetLane,
    changedBy: "workflow-monitor",
    note: `Doc written — moving from backlog to ${targetLane}`,
  });

  state.featureId = featureId;
  saveFeatureState(state, DEFAULT_DIR);
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../log.js";
import type { KanbanDatabase } from "./data/kanban-database.js";
import { NO_DONE_HIDE_AFTER_MS, NO_PRECOMPUTED_BOUNDS } from "./data/kanban-database.js";
import type { Feature, Lane } from "./data/kanban-types.js";

export interface KanbanTakeOptions {
  sessionId: string;
  lanes: Lane[];
  projectId?: number;
}

export class KanbanTools {
  constructor(private db: KanbanDatabase) {}

  kanbanAdd(opts: {
    projectId: number;
    slug?: string | null;
    title: string;
    description?: string;
    designDoc?: string;
  }): number {
    return this.db.createFeature({
      projectId: opts.projectId,
      slug: opts.slug ?? "",
      title: opts.title,
      description: opts.description ?? null,
      lane: "backlog",
      designDoc: opts.designDoc ?? null,
    });
  }

  kanbanTake(opts: KanbanTakeOptions): Feature | null {
    // Entire pick+lock+move must be atomic to prevent race conditions
    return this.db.runInTransaction(() => {
      // Find highest-priority unlocked features in specified lanes
      const features = this.db.findAvailableFeatures(opts.projectId, opts.lanes);
      log.info(
        `[kanban] kanbanTake: found ${features.length} available feature(s) in lane(s) [${opts.lanes.join(", ")}] for project ${opts.projectId}, session=${opts.sessionId}`,
      );
      if (features.length === 0) return null;

      // Try each candidate in priority order, skipping invalid ones
      for (const feature of features) {
        const locked = this.db.lockFeature(feature.id, opts.sessionId);
        if (!locked) {
          log.info(`[kanban] kanbanTake: failed to lock feature ${feature.id} "${feature.title}" (race condition)`);
          continue; // Race condition — another agent got it, try next
        }

        log.info(
          `[kanban] kanbanTake: locked feature ${feature.id} "${feature.title}" (lane=${feature.lane}, slug="${feature.slug}", description=${feature.description ? "present" : "MISSING"})`,
        );

        // Move to in-progress if from ready lane
        if (feature.lane === "ready") {
          this.db.moveFeature({
            featureId: feature.id,
            toLane: "in-progress",
            changedBy: `agent:${opts.sessionId}`,
            fromLane: feature.lane,
          });
          // FIFO priority only for ready→in-progress moves; design picks stay in design lane and keep their priority
          this.db.assignFifoPriority(feature.id, feature.project_id, "in-progress", NO_PRECOMPUTED_BOUNDS);
        }

        return this.db.getFeature(feature.id);
      }

      log.info(`[kanban] kanbanTake: all ${features.length} candidate(s) were skipped (lock failures)`);
      return null;
    });
  }

  /** Peek at the next available feature without locking or moving it. Read-only. */
  kanbanPeek(opts: { projectId: number; lanes: Lane[] }): Feature | null {
    return this.db.runInTransaction(() => {
      const features = this.db.findAvailableFeatures(opts.projectId, opts.lanes);
      return features.length > 0 ? features[0] : null;
    });
  }

  kanbanMove(opts: { featureId: number; toLane: Lane; changedBy: string; note?: string }): void {
    this.db.moveFeature({
      featureId: opts.featureId,
      toLane: opts.toLane,
      changedBy: opts.changedBy,
      note: opts.note,
    });
  }

  kanbanRelease(opts: { featureId: number }): void {
    this.db.unlockFeature(opts.featureId);
  }

  kanbanList(opts: { projectId: number; lane?: Lane }): Feature[] {
    if (opts.lane) {
      return this.db.listFeatures(opts.projectId, opts.lane, NO_DONE_HIDE_AFTER_MS);
    }
    return this.db.listAllFeatures(opts.projectId, NO_DONE_HIDE_AFTER_MS);
  }

  kanbanUpdate(opts: {
    featureId: number;
    title?: string;
    description?: string;
    priority?: number;
    addTags?: string[];
    removeTags?: string[];
    addDependency?: { dependsOnId: number; kind: "blocks" | "requires" | "related" };
    removeDependency?: { dependsOnId: number };
  }): void {
    // Wrap entire update in transaction for atomicity
    this.db.runInTransaction(() => {
      this.db.updateFeature({
        featureId: opts.featureId,
        title: opts.title,
        description: opts.description,
        priority: opts.priority,
      });

      // Fetch tags once for both add and remove operations
      const needsTagWork = (opts.addTags?.length ?? 0) > 0 || (opts.removeTags?.length ?? 0) > 0;
      const existingTags = needsTagWork ? this.db.listTags() : [];

      // Handle tag additions
      if (opts.addTags?.length) {
        for (const tagName of opts.addTags) {
          let tagId = existingTags.find((t) => t.name === tagName)?.id;
          if (tagId === undefined) {
            tagId = this.db.createTag({ name: tagName });
          }
          this.db.addFeatureTag(opts.featureId, tagId);
        }
      }

      // Handle tag removals
      if (opts.removeTags?.length) {
        for (const tagName of opts.removeTags) {
          const tag = existingTags.find((t) => t.name === tagName);
          if (tag) {
            this.db.removeFeatureTag(opts.featureId, tag.id);
          }
        }
      }

      // Handle dependency changes
      if (opts.addDependency) {
        this.db.addDependency({
          featureId: opts.featureId,
          dependsOnId: opts.addDependency.dependsOnId,
          kind: opts.addDependency.kind,
        });
      }
      if (opts.removeDependency) {
        this.db.removeDependency(opts.featureId, opts.removeDependency.dependsOnId);
      }
    });
  }

  kanbanHistory(featureId: number) {
    return this.db.getFeatureHistory(featureId);
  }

  kanbanHeartbeat(featureId: number, sessionId: string): void {
    this.db.heartbeat(featureId, sessionId);
  }
}

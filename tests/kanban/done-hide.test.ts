// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";

async function createDb() {
  return KanbanDatabase.createInMemory();
}

describe("kanbanDoneHideAfterMs runtime behavior", () => {
  test("listDoneFeatures returns all done features when no cutoff", async () => {
    const db = await createDb();
    try {
      const projectId = db.createProject({ name: "Test", repoPath: "/test" });
      db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "done" });
      db.createFeature({ projectId, slug: "feat-2", title: "Feature 2", lane: "done" });

      const features = db.listFeatures(projectId, "done", undefined);
      expect(features).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("listDoneFeatures filters out features done before cutoff", async () => {
    const db = await createDb();
    try {
      const projectId = db.createProject({ name: "Test", repoPath: "/test" });

      // Create feature and move to done with an old timestamp
      const featureId = db.createFeature({ projectId, slug: "old-feature", title: "Old Feature", lane: "backlog" });
      db.moveFeature({ featureId, toLane: "done", changedBy: "system" });

      // Manually backdate the history entry to 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      db.rawExec("UPDATE feature_history SET created_at = ? WHERE feature_id = ? AND to_lane = 'done'", [
        twoHoursAgo,
        featureId,
      ]);

      // Create a recent done feature
      const recentId = db.createFeature({ projectId, slug: "recent-feature", title: "Recent Feature", lane: "done" });
      // Its history is already recent (just created)

      // With 1 hour cutoff, old feature should be hidden
      const oneHourMs = 60 * 60 * 1000;
      const visible = db.listFeatures(projectId, "done", oneHourMs);
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe(recentId);
    } finally {
      db.close();
    }
  });

  test("listDoneFeatures returns all when cutoff is 0", async () => {
    const db = await createDb();
    try {
      const projectId = db.createProject({ name: "Test", repoPath: "/test" });
      db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "done" });

      const features = db.listFeatures(projectId, "done", 0);
      expect(features).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("listDoneFeatures with cutoff only affects done lane, not other lanes", async () => {
    const db = await createDb();
    try {
      const projectId = db.createProject({ name: "Test", repoPath: "/test" });
      db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "in-progress" });

      // Cutoff should not affect non-done lanes
      const features = db.listFeatures(projectId, "in-progress", 1000);
      expect(features).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

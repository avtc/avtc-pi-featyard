// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";

let tempDir: string | null = null;

async function createDb(): Promise<{ db: KanbanDatabase; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kanban-overlay-"));
  tempDir = dir;
  const db = await KanbanDatabase.createInMemory();
  return { db, dir };
}

afterEach(async () => {
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    tempDir = null;
  }
});

describe("overlay_status", () => {
  test("setOverlayStatus sets waiting-for-response", async () => {
    const { db } = await createDb();
    const projectId = db.createProject({ name: "test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "in-progress" });

    db.setOverlayStatus(featureId, "waiting-for-response");

    const feature = db.getFeature(featureId);
    expect(feature?.overlay_status).toBe("waiting-for-response");
    db.close();
  });

  test("clearOverlayStatus resets to null", async () => {
    const { db } = await createDb();
    const projectId = db.createProject({ name: "test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "in-progress" });

    db.setOverlayStatus(featureId, "waiting-for-response");
    db.clearOverlayStatus(featureId);

    const feature = db.getFeature(featureId);
    expect(feature?.overlay_status).toBeNull();
    db.close();
  });

  test("overlay_status defaults to null on new features", async () => {
    const { db } = await createDb();
    const projectId = db.createProject({ name: "test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "backlog" });

    const feature = db.getFeature(featureId);
    expect(feature?.overlay_status).toBeNull();
    db.close();
  });

  test("overlay_status is readable after set", async () => {
    const { db } = await createDb();
    const projectId = db.createProject({ name: "test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "in-progress" });

    db.setOverlayStatus(featureId, "waiting-for-response");

    // Re-read from same DB connection
    const feature = db.getFeature(featureId);
    expect(feature?.overlay_status).toBe("waiting-for-response");
  });

  test("setOverlayStatus on non-existent feature returns false", async () => {
    const { db } = await createDb();
    const result = db.setOverlayStatus(99999, "waiting-for-response");
    expect(result).toBe(false);
    db.close();
  });

  test("clearOverlayStatus on non-existent feature does not throw", async () => {
    const { db } = await createDb();
    expect(() => db.clearOverlayStatus(99999)).not.toThrow();
    db.close();
  });
});

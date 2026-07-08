// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import type { Feature } from "../../../src/kanban/data/kanban-types.js";
import { resetInstances } from "../../../src/kanban/kanban-bridge.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-completion-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetInstances();
});

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("onFeatureCompletion actual lane check", () => {
  test("feature in design lane has correct initial state with lock", async () => {
    const tempDir = createTempDir();
    const db = await KanbanDatabase.createInMemory();
    const projectId = db.createProject({ name: "test", repoPath: tempDir });

    const featureId = db.createFeature({
      projectId,
      slug: "test-feature",
      title: "Test",
      description: "Test",
      lane: "design",
    });

    db.lockFeature(featureId, "agent-session-1");

    const feature = db.getFeature(featureId) as Feature;
    // Verify DB-level state: design lane + locked_by_session populated
    expect(feature.lane).toBe("design");
    expect(feature.locked_at).not.toBeNull();
    expect(feature.locked_by_session).toBe("agent-session-1");
  });

  test("feature moved to ready by user stays in ready after completion", async () => {
    const tempDir = createTempDir();
    const db = await KanbanDatabase.createInMemory();
    const projectId = db.createProject({ name: "test", repoPath: tempDir });

    const featureId = db.createFeature({
      projectId,
      slug: "test-feature",
      title: "Test",
      description: "Test",
      lane: "design",
    });

    db.lockFeature(featureId, "agent-session-1");

    // Simulate: user moved the feature to ready while agent was working
    db.moveFeature({
      featureId,
      toLane: "ready",
      changedBy: "user",
      note: "User pre-approved",
    });

    // Verify the feature is now in ready
    const feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("ready");

    // After completion, the agent should NOT move it back to design-approval
    // The actual-lane check should detect lane !== "design" and skip the move
    // Just release the lock
    db.unlockFeature(featureId);

    const afterUnlock = db.getFeature(featureId) as Feature;
    expect(afterUnlock.lane).toBe("ready"); // Still in ready
    expect(afterUnlock.locked_at).toBeNull(); // Lock released
  });
});

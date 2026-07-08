// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { AutoAgentStateMachine } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import type { Feature } from "../../../src/kanban/data/kanban-types.js";
import { resetInstances } from "../../../src/kanban/kanban-bridge.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-session-slug-test-"));
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

describe("Feature.locked_by_session", () => {
  test("locked feature includes session_id via locked_by_session", async () => {
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

    db.lockFeature(featureId, "session-123");

    const feature = db.getFeature(featureId) as Feature;
    expect(feature.locked_by_session).toBe("session-123");
  });

  test("unlocked feature has null locked_by_session", async () => {
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

    const feature = db.getFeature(featureId) as Feature;
    expect(feature.locked_by_session).toBeNull();
  });
});

describe("AutoAgentStateMachine.adoptFeature", () => {
  test("sets currentFeatureId and currentFeatureLane", () => {
    const sm = new AutoAgentStateMachine("agent", 1, "test-session");
    sm.start();

    sm.adoptFeature(42, "design");

    expect(sm.getCurrentFeatureId()).toBe(42);
    expect(sm.getCurrentFeatureLane()).toBe("design");
  });
});

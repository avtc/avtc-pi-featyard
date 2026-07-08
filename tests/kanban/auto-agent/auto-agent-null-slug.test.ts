// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutoAgentStateMachine } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import { KanbanTools } from "../../../src/kanban/kanban-operations.js";

async function createDb(): Promise<{ db: KanbanDatabase; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-test-"));
  const db = await KanbanDatabase.createInMemory();
  return { db, dir };
}

describe("Auto-agent pickNextFeature with null-slug features", () => {
  const instances: { db: KanbanDatabase; dir: string }[] = [];

  afterEach(async () => {
    for (const { db, dir } of instances) {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    instances.length = 0;
  });

  async function createTestDb() {
    const instance = await createDb();
    instances.push(instance);
    return instance;
  }

  it("pickNextFeature returns temp slug for null-slug feature", async () => {
    const { db } = await createTestDb();
    const tools = new KanbanTools(db);
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    // Add feature without slug (null slug)
    const featureId = db.createFeature({
      projectId,
      slug: null as unknown as string,
      title: "Untitled feature",
    });
    // Move to ready lane so worker can pick it
    db.moveFeature({ featureId, toLane: "ready", changedBy: "test" });

    const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
    sm.start();

    const result = sm.pickNextFeature(tools, projectId, "session-1");
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).feature.id).toBe(featureId);
    // Slug should be the temp slug (kanban-{id})
    expect((result as NonNullable<typeof result>).feature.slug).toBe(`kanban-${featureId}`);
    expect((result as NonNullable<typeof result>).skill).toBe("ff-plan"); // worker picks from ready lane
  });

  it("pickNextFeature returns real slug for feature with slug", async () => {
    const { db } = await createTestDb();
    const tools = new KanbanTools(db);
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const featureId = db.createFeature({
      projectId,
      slug: "2026-05-16-my-feature",
      title: "My Feature",
    });
    db.moveFeature({ featureId, toLane: "ready", changedBy: "test" });

    const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
    sm.start();

    const result = sm.pickNextFeature(tools, projectId, "session-1");
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).feature.slug).toBe("2026-05-16-my-feature");
  });

  it("pickNextFeature sets kanbanFeatureId on returned feature metadata", async () => {
    const { db } = await createTestDb();
    const tools = new KanbanTools(db);
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const featureId = db.createFeature({
      projectId,
      slug: null as unknown as string,
      title: "Untitled feature",
      description: "Needs designing",
    });
    db.moveFeature({ featureId, toLane: "design", changedBy: "test" });

    const sm = new AutoAgentStateMachine("designer", projectId, "session-1");
    sm.start();

    const result = sm.pickNextFeature(tools, projectId, "session-1");
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).kanbanFeatureId).toBe(featureId);
  });

  it("pickNextFeature returns null for no available features", async () => {
    const { db } = await createTestDb();
    const tools = new KanbanTools(db);
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
    sm.start();

    const result = sm.pickNextFeature(tools, projectId, "session-1");
    expect(result).toBeNull();
    expect(sm.getState()).toBe("polling"); // noFeatureAvailable was called
  });
});

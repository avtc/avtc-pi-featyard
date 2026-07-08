// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AutoAgentStateMachine } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import { resetInstances } from "../../../src/kanban/kanban-bridge.js";
import { KanbanTools } from "../../../src/kanban/kanban-operations.js";

let tempDir: string | null = null;
let db: KanbanDatabase | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  resetInstances();
  if (db) {
    db.close();
    db = null;
  }
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    tempDir = null;
  }
});

async function createTestDb() {
  tempDir = fs.mkdtempSync(join(os.tmpdir(), "kanban-poll-test-"));
  db = await KanbanDatabase.createInMemory();
  return db;
}

describe("auto-agent polling", () => {
  test("enters polling state when no feature available", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "session-1");
    sm.start();
    sm.noFeatureAvailable();
    expect(sm.getState()).toBe("polling");
  });

  test("polling retries pickNextFeature after autoPollMs interval", async () => {
    const db = await createTestDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const sessionId = "poll-session";

    const sm = new AutoAgentStateMachine("worker", projectId, sessionId);
    sm.start();
    sm.noFeatureAvailable();
    expect(sm.getState()).toBe("polling");

    // Add a feature while "polling" — simulates another agent adding to ready lane
    db.createFeature({ projectId, slug: "new-feature", title: "New Feature", lane: "ready" });

    // Simulate polling retry — transition back to working, then pick
    sm.featureFound(); // transition from polling→working
    const tools = new KanbanTools(db);
    const result = sm.pickNextFeature(tools, projectId, sessionId);

    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).feature.slug).toBe("new-feature");
    expect(sm.getState()).toBe("working");
  });

  test("requestStop during polling clears polling state", () => {
    const sm = new AutoAgentStateMachine("agent", 1, "session-1");
    sm.start();
    sm.noFeatureAvailable();
    expect(sm.getState()).toBe("polling");

    sm.requestStop();
    expect(sm.getState()).toBe("stopped");
  });

  test("polling retry: pickNextFeature failure transitions to error state", async () => {
    const db = await createTestDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const sessionId = "poll-session";

    const sm = new AutoAgentStateMachine("worker", projectId, sessionId);
    sm.start();
    sm.noFeatureAvailable();
    expect(sm.getState()).toBe("polling");

    // Simulate: polling timer fires, featureFound (polling→working),
    // but pickNextFeature throws (e.g. DB error during kanbanTake)
    sm.featureFound(); // polling → working
    expect(sm.getState()).toBe("working");

    // Simulate error during pick — this is what the catch block in index.ts does
    sm.error("database connection lost");
    expect(sm.getState()).toBe("error");
  });

  test("polling retry: kanbanTake returns null keeps polling", async () => {
    const db = await createTestDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const sessionId = "poll-session";

    const sm = new AutoAgentStateMachine("worker", projectId, sessionId);
    sm.start();

    // No features at all
    const tools = new KanbanTools(db);
    const result = sm.pickNextFeature(tools, projectId, sessionId);

    // No feature available → enters polling state
    expect(result).toBeNull();
    expect(sm.getState()).toBe("polling");

    // Simulate another polling cycle: featureFound + pickNextFeature still null
    sm.featureFound();
    const tools2 = new KanbanTools(db);
    const result2 = sm.pickNextFeature(tools2, projectId, sessionId);
    expect(result2).toBeNull();
    expect(sm.getState()).toBe("polling");
  });
});

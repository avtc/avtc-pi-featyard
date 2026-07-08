// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { AutoAgentStateMachine } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import { KanbanTools } from "../../../src/kanban/kanban-operations.js";

async function createDb(): Promise<{ db: KanbanDatabase; tools: KanbanTools }> {
  const db = await KanbanDatabase.createInMemory();
  const tools = new KanbanTools(db);
  return { db, tools };
}

describe("auto-agent handleFeatureError (fatal)", () => {
  test("moves feature back to original lane and releases lock", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "2026-05-16-error-feature",
        title: "Error Feature",
        lane: "ready",
      });

      const sessionId = "err-test-session";
      const sm = new AutoAgentStateMachine("worker", projectId, sessionId);
      sm.start();
      const result = sm.pickNextFeature(tools, projectId, sessionId);
      expect(result).not.toBeNull();

      // Feature should be locked and in-progress
      let feature = db.getFeature(featureId);
      expect((feature as NonNullable<typeof feature>).lane).toBe("in-progress");
      expect((feature as NonNullable<typeof feature>).locked_at).toBeTruthy();

      // Simulate error
      sm.handleFeatureError(tools, featureId, sessionId, "ready", "Test error message");

      feature = db.getFeature(featureId);
      expect((feature as NonNullable<typeof feature>).lane).toBe("ready");
      expect((feature as NonNullable<typeof feature>).locked_at).toBeNull();
      expect(sm.getState()).toBe("error");
    } finally {
      db.close();
    }
  });

  test("records error note in history", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "2026-05-16-history-feature",
        title: "History Feature",
        description: "A feature with description",
        lane: "design",
      });

      const sessionId = "err-test-session";
      const sm = new AutoAgentStateMachine("designer", projectId, sessionId);
      sm.start();
      const result = sm.pickNextFeature(tools, projectId, sessionId);
      expect(result).not.toBeNull();

      sm.handleFeatureError(tools, featureId, sessionId, "design", "Build failed");

      const history = db.getFeatureHistory(featureId);
      const errorEntry = history.find((h) => h.note?.includes("Build failed"));
      expect(errorEntry).toBeDefined();
      expect((errorEntry as NonNullable<typeof errorEntry>).from_lane).toBe("design");
      expect((errorEntry as NonNullable<typeof errorEntry>).to_lane).toBe("design");
    } finally {
      db.close();
    }
  });

  test("designer error returns to design lane", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "2026-05-16-design-error",
        title: "Design Error",
        lane: "design",
      });

      const sessionId = "designer-session";
      const sm = new AutoAgentStateMachine("designer", projectId, sessionId);
      sm.start();
      sm.pickNextFeature(tools, projectId, sessionId);

      // Designer picked from design lane, error returns to design
      sm.handleFeatureError(tools, featureId, sessionId, "design", "Design review failed");

      const feature = db.getFeature(featureId);
      expect((feature as NonNullable<typeof feature>).lane).toBe("design");
      expect((feature as NonNullable<typeof feature>).locked_at).toBeNull();
    } finally {
      db.close();
    }
  });

  test("state machine enters error state after handleFeatureError", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "2026-05-16-sm-error",
        title: "SM Error",
        lane: "ready",
      });

      const sessionId = "sm-session";
      const sm = new AutoAgentStateMachine("worker", projectId, sessionId);
      sm.start();
      sm.pickNextFeature(tools, projectId, sessionId);
      expect(sm.getState()).toBe("working");

      sm.handleFeatureError(tools, featureId, sessionId, "ready", "Critical failure");

      expect(sm.getState()).toBe("error");
      // Feature still available for re-pick by another agent
      const feature = db.getFeature(featureId);
      expect((feature as NonNullable<typeof feature>).locked_at).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("auto-agent handleFeatureTransientError", () => {
  test("blocks agent in waiting state — keeps lock, keeps lane", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "2026-05-16-transient-error",
        title: "Transient Error Feature",
        lane: "ready",
      });

      const sessionId = "transient-session";
      const sm = new AutoAgentStateMachine("worker", projectId, sessionId);
      sm.start();
      const result = sm.pickNextFeature(tools, projectId, sessionId);
      expect(result).not.toBeNull();

      // Feature should be locked and in-progress
      let feature = db.getFeature(featureId);
      expect((feature as NonNullable<typeof feature>).lane).toBe("in-progress");
      expect((feature as NonNullable<typeof feature>).locked_at).toBeTruthy();
      expect(sm.getState()).toBe("working");

      // Simulate transient error (usage limit, network error)
      sm.handleFeatureTransientError(featureId, "Usage limit reached for 5 hour");

      // Agent should be in waiting state — NOT error
      expect(sm.getState()).toBe("waiting");

      // Lock should still be held
      feature = db.getFeature(featureId);
      expect((feature as NonNullable<typeof feature>).locked_at).toBeTruthy();

      // Feature should stay in in-progress — NOT moved back
      expect((feature as NonNullable<typeof feature>).lane).toBe("in-progress");
    } finally {
      db.close();
    }
  });

  test("designer transient error keeps feature in design lane with lock", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "2026-05-16-design-transient",
        title: "Design Transient",
        description: "Has description",
        lane: "design",
      });

      const sessionId = "designer-transient-session";
      const sm = new AutoAgentStateMachine("designer", projectId, sessionId);
      sm.start();
      sm.pickNextFeature(tools, projectId, sessionId);
      expect(sm.getState()).toBe("working");

      sm.handleFeatureTransientError(featureId, "Network error");

      // Agent blocked, not dead
      expect(sm.getState()).toBe("waiting");

      // Feature stays in design with lock
      const feature = db.getFeature(featureId);
      expect((feature as NonNullable<typeof feature>).lane).toBe("design");
      expect((feature as NonNullable<typeof feature>).locked_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  test("unblock resumes agent from waiting to working after transient error", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "2026-05-16-resume-test",
        title: "Resume Test",
        lane: "ready",
      });

      const sessionId = "resume-session";
      const sm = new AutoAgentStateMachine("worker", projectId, sessionId);
      sm.start();
      sm.pickNextFeature(tools, projectId, sessionId);
      expect(sm.getState()).toBe("working");

      // Transient error blocks the agent
      sm.handleFeatureTransientError(featureId, "Usage limit reached");
      expect(sm.getState()).toBe("waiting");

      // User comes back and sends a message → unblock
      sm.unblock();
      expect(sm.getState()).toBe("working");

      // Lock still held, feature still in in-progress
      const feature = db.getFeature(featureId);
      expect((feature as NonNullable<typeof feature>).lane).toBe("in-progress");
      expect((feature as NonNullable<typeof feature>).locked_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  test("no-op if agent not in working state", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "noop-session");
    // Agent starts in idle
    expect(sm.getState()).toBe("idle");

    // Should not throw and should not change state
    sm.handleFeatureTransientError(42, "Some error");
    expect(sm.getState()).toBe("idle");
  });
});

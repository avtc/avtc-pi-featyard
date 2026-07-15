// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { AutoAgentStateMachine, computeTargetLane } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import { KanbanTools } from "../../../src/kanban/kanban-operations.js";

async function createDb(): Promise<{ db: KanbanDatabase; tools: KanbanTools }> {
  const db = await KanbanDatabase.createInMemory();
  const tools = new KanbanTools(db);
  return { db, tools };
}

describe("AutoAgentStateMachine methods", () => {
  describe("pickNextFeature", () => {
    test("picks feature from idle state without start", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        db.createFeature({ projectId, slug: "idle-f", title: "Idle Feature", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "sess-1");
        expect(sm.getState()).toBe("idle");

        const result = sm.pickNextFeature(tools, projectId, "sess-1");
        expect(result).not.toBeNull();
        expect((result as NonNullable<typeof result>).feature.slug).toBe("idle-f");
      } finally {
        db.close();
      }
    });

    test("returns null when state is stopped", async () => {
      const { db, tools } = await createDb();
      try {
        const sm = new AutoAgentStateMachine("worker", 1, "session-1");
        sm.start();
        sm.requestStop();

        const result = sm.pickNextFeature(tools, 1, "session-1");
        expect(result).toBeNull();
      } finally {
        db.close();
      }
    });

    test("transitions to polling when no feature available", async () => {
      const { db, tools } = await createDb();
      try {
        const sm = new AutoAgentStateMachine("worker", 1, "session-1");
        sm.start();

        const result = sm.pickNextFeature(tools, 1, "session-1");
        expect(result).toBeNull();
        expect(sm.getState()).toBe("polling");
      } finally {
        db.close();
      }
    });

    test("returns feature with correct skill for worker from ready lane", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();

        const result = sm.pickNextFeature(tools, projectId, "session-1");
        expect(result).not.toBeNull();
        expect((result as NonNullable<typeof result>).feature.slug).toBe("feat-1");
        expect((result as NonNullable<typeof result>).skill).toBe("fy-plan");
        expect(sm.getState()).toBe("working");
      } finally {
        db.close();
      }
    });

    test("returns feature with designing skill for designer from design lane", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        db.createFeature({
          projectId,
          slug: "feat-2",
          title: "Feature 2",
          lane: "design",
          description: "Design feature",
        });

        const sm = new AutoAgentStateMachine("designer", projectId, "session-1");
        sm.start();

        const result = sm.pickNextFeature(tools, projectId, "session-1");
        expect(result).not.toBeNull();
        expect((result as NonNullable<typeof result>).feature.slug).toBe("feat-2");
        expect((result as NonNullable<typeof result>).skill).toBe("fy-design");
      } finally {
        db.close();
      }
    });

    test("locks feature when picked", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({ projectId, slug: "feat-3", title: "Feature 3", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");

        const feature = db.getFeature(featureId);
        expect((feature as NonNullable<typeof feature>).locked_at).not.toBeNull();
      } finally {
        db.close();
      }
    });

    test("agent role picks design lane before higher-priority ready lane", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        // Create a high-priority ready feature
        db.createFeature({ projectId, slug: "ready-high", title: "Ready High", lane: "ready", priority: 100 });
        // Create a low-priority design feature
        db.createFeature({
          projectId,
          slug: "design-low",
          title: "Design Low",
          lane: "design",
          priority: 1,
          description: "Needs design",
        });

        const sm = new AutoAgentStateMachine("agent", projectId, "session-1");
        sm.start();

        const result = sm.pickNextFeature(tools, projectId, "session-1");
        expect(result).not.toBeNull();
        // Design lane should be picked first despite lower priority
        expect((result as NonNullable<typeof result>).feature.slug).toBe("design-low");
        expect((result as NonNullable<typeof result>).skill).toBe("fy-design");
      } finally {
        db.close();
      }
    });
  });

  describe("handleFeatureCompletion", () => {
    test("moves feature to done, releases lock, and picks next", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId1 = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });
        const featureId2 = db.createFeature({ projectId, slug: "feat-2", title: "Feature 2", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();

        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();
        expect((first as NonNullable<typeof first>).feature.id).toBe(featureId1);

        const next = sm.handleFeatureCompletion(tools, featureId1, "session-1", projectId);
        expect(next).not.toBeNull();
        expect((next as NonNullable<typeof next>).feature.id).toBe(featureId2);

        const done = db.getFeature(featureId1);
        expect((done as NonNullable<typeof done>).lane).toBe("done");
        expect((done as NonNullable<typeof done>).locked_at).toBeNull();
      } finally {
        db.close();
      }
    });

    test("returns null when no more features after completion", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();

        const next = sm.handleFeatureCompletion(tools, featureId, "session-1", projectId);
        expect(next).toBeNull();
        expect(sm.getState()).toBe("polling");
      } finally {
        db.close();
      }
    });

    test("does not pick next when stop was requested", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId1 = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });
        db.createFeature({ projectId, slug: "feat-2", title: "Feature 2", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();

        sm.requestStop();

        const next = sm.handleFeatureCompletion(tools, featureId1, "session-1", projectId);
        expect(next).toBeNull();
        expect(sm.getState()).toBe("stopped");
      } finally {
        db.close();
      }
    });

    test("designer moves design feature to design-approval when enabled", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({
          projectId,
          slug: "feat-1",
          title: "Feature 1",
          lane: "design",
          description: "Design for feature 1",
        });

        const sm = new AutoAgentStateMachine("designer", projectId, "session-1");
        sm.start();
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();

        const next = sm.handleFeatureCompletion(tools, featureId, "session-1", projectId, {
          designApprovalEnabled: true,
        });
        expect(next).toBeNull(); // no more features

        const feature = db.getFeature(featureId);
        expect((feature as NonNullable<typeof feature>).lane).toBe("design-approval");
        expect((feature as NonNullable<typeof feature>).locked_at).toBeNull();
      } finally {
        db.close();
      }
    });

    test("designer moves design feature to ready when approval disabled", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({
          projectId,
          slug: "feat-1",
          title: "Feature 1",
          lane: "design",
          description: "Design for feature 1",
        });

        const sm = new AutoAgentStateMachine("designer", projectId, "session-1");
        sm.start();
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();

        const next = sm.handleFeatureCompletion(tools, featureId, "session-1", projectId, {
          designApprovalEnabled: false,
        });
        expect(next).toBeNull();

        const feature = db.getFeature(featureId);
        expect((feature as NonNullable<typeof feature>).lane).toBe("ready");
        expect((feature as NonNullable<typeof feature>).locked_at).toBeNull();
      } finally {
        db.close();
      }
    });

    test("worker still moves ready feature to done", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();

        sm.handleFeatureCompletion(tools, featureId, "session-1", projectId, {
          designApprovalEnabled: true,
        });

        const feature = db.getFeature(featureId);
        expect((feature as NonNullable<typeof feature>).lane).toBe("done");
      } finally {
        db.close();
      }
    });

    test("agent moves design feature to ready when designApprovalEnabled=false", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const designId = db.createFeature({
          projectId,
          slug: "design-feat",
          title: "Design Feature",
          lane: "design",
          description: "Design for feature",
          priority: 1,
        });
        db.createFeature({ projectId, slug: "ready-feat", title: "Ready Feature", lane: "ready", priority: 100 });

        const sm = new AutoAgentStateMachine("agent", projectId, "session-1");
        sm.start();
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();
        expect((first as NonNullable<typeof first>).feature.id).toBe(designId); // agent picks design first

        const next = sm.handleFeatureCompletion(tools, designId, "session-1", projectId, {
          designApprovalEnabled: false,
        });
        expect(next).not.toBeNull(); // picks ready-feat next (higher priority)
        expect((next as NonNullable<typeof next>).feature.id).not.toBe(designId); // not the same feature

        const feature = db.getFeature(designId);
        expect((feature as NonNullable<typeof feature>).lane).toBe("ready"); // design→ready (skip design-approval)
        expect((feature as NonNullable<typeof feature>).locked_at).toBeNull(); // released
      } finally {
        db.close();
      }
    });

    test("completeOnly stops after complete without picking next feature", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId1 = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "design" });
        const featureId2 = db.createFeature({ projectId, slug: "feat-2", title: "Feature 2", lane: "design" });

        const sm = new AutoAgentStateMachine("designer", projectId, "session-1");
        sm.start();
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();

        // completeOnly: should NOT pick next feature
        const next = sm.handleFeatureCompletion(tools, featureId1, "session-1", projectId, {
          designApprovalEnabled: true,
          completeOnly: true,
        });
        expect(next).toBeNull(); // No next feature returned
        expect(sm.getState()).toBe("idle"); // Stopped after complete(), no start() called

        // Feature was moved and lock released
        const moved = db.getFeature(featureId1);
        expect((moved as NonNullable<typeof moved>).lane).toBe("design-approval");
        expect((moved as NonNullable<typeof moved>).locked_at).toBeNull();

        // Next feature is still available (not locked)
        const avail = db.findAvailableFeatures(projectId, ["design"]);
        expect(avail.length).toBe(1);
        expect(avail[0].id).toBe(featureId2);
      } finally {
        db.close();
      }
    });

    test("completeOnly with design approval disabled moves to ready", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "design" });

        const sm = new AutoAgentStateMachine("designer", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");

        const next = sm.handleFeatureCompletion(tools, featureId, "session-1", projectId, {
          designApprovalEnabled: false,
          completeOnly: true,
        });
        expect(next).toBeNull();

        const moved = db.getFeature(featureId);
        expect((moved as NonNullable<typeof moved>).lane).toBe("ready");
      } finally {
        db.close();
      }
    });

    test("completeOnly false (default) behaves like existing code", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId1 = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });
        const featureId2 = db.createFeature({ projectId, slug: "feat-2", title: "Feature 2", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");

        // Default behavior: picks next feature
        const next = sm.handleFeatureCompletion(tools, featureId1, "session-1", projectId, {
          completeOnly: false,
        });
        expect(next).not.toBeNull();
        expect((next as NonNullable<typeof next>).feature.id).toBe(featureId2);
      } finally {
        db.close();
      }
    });

    test("completeOnly + requestStop returns null and state is stopped", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId1 = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });
        db.createFeature({ projectId, slug: "feat-2", title: "Feature 2", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");

        // Request stop before completion
        sm.requestStop();

        // complete() inside handleFeatureCompletion should transition to stopped
        const result = sm.handleFeatureCompletion(tools, featureId1, "session-1", projectId, {
          completeOnly: true,
        });
        expect(result).toBeNull();
        expect(sm.getState()).toBe("stopped");
      } finally {
        db.close();
      }
    });
  });

  describe("handleFeatureUatHandoff", () => {
    test("releases lock, keeps card in current lane, and picks next feature", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId1 = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });
        const featureId2 = db.createFeature({ projectId, slug: "feat-2", title: "Feature 2", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();

        // Pick first feature (moves ready → in-progress)
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();
        expect((first as NonNullable<typeof first>).feature.id).toBe(featureId1);

        // Simulate: feature has been moved to UAT by sync callback
        db.moveFeature({ featureId: featureId1, toLane: "uat", changedBy: "system" });

        // UAT handoff: release lock, keep in UAT, pick next
        const next = sm.handleFeatureUatHandoff(tools, featureId1, "session-1", projectId);
        expect(next).not.toBeNull();
        expect((next as NonNullable<typeof next>).feature.id).toBe(featureId2);

        // Feature 1 stays in UAT (not moved to done)
        const feature1 = db.getFeature(featureId1);
        expect((feature1 as NonNullable<typeof feature1>).lane).toBe("uat");
        expect((feature1 as NonNullable<typeof feature1>).locked_at).toBeNull();

        // Agent is now working on feature 2
        expect(sm.getState()).toBe("working");
        expect(sm.getCurrentFeatureId()).toBe(featureId2);
      } finally {
        db.close();
      }
    });

    test("returns null when no more features after UAT handoff", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();

        // Simulate move to UAT
        db.moveFeature({ featureId, toLane: "uat", changedBy: "system" });

        const next = sm.handleFeatureUatHandoff(tools, featureId, "session-1", projectId);
        expect(next).toBeNull();
        expect(sm.getState()).toBe("polling");

        // Feature stays in UAT, lock released
        const feature = db.getFeature(featureId);
        expect((feature as NonNullable<typeof feature>).lane).toBe("uat");
        expect((feature as NonNullable<typeof feature>).locked_at).toBeNull();
      } finally {
        db.close();
      }
    });

    test("does not pick next when stop was requested", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId1 = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });
        db.createFeature({ projectId, slug: "feat-2", title: "Feature 2", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        const first = sm.pickNextFeature(tools, projectId, "session-1");
        expect(first).not.toBeNull();

        db.moveFeature({ featureId: featureId1, toLane: "uat", changedBy: "system" });

        sm.requestStop();

        const next = sm.handleFeatureUatHandoff(tools, featureId1, "session-1", projectId);
        expect(next).toBeNull();
        expect(sm.getState()).toBe("stopped");

        // Lock is still released even when stopped
        const feature = db.getFeature(featureId1);
        expect((feature as NonNullable<typeof feature>).locked_at).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  describe("handleFeatureError", () => {
    test("moves feature back to original lane and releases lock", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        const picked = sm.pickNextFeature(tools, projectId, "session-1");
        expect(picked).not.toBeNull();

        const inProgress = db.getFeature(featureId);
        expect((inProgress as NonNullable<typeof inProgress>).lane).toBe("in-progress");

        sm.handleFeatureError(tools, featureId, "session-1", "ready", "Something went wrong");

        const backToReady = db.getFeature(featureId);
        expect((backToReady as NonNullable<typeof backToReady>).lane).toBe("ready");
        expect((backToReady as NonNullable<typeof backToReady>).locked_at).toBeNull();

        expect(sm.getState()).toBe("error");
      } finally {
        db.close();
      }
    });

    test("records error note in feature history", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({
          projectId,
          slug: "feat-1",
          title: "Feature 1",
          lane: "design",
          description: "Design feature",
        });

        const sm = new AutoAgentStateMachine("designer", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");

        sm.handleFeatureError(tools, featureId, "session-1", "design", "LLM rate limit exceeded");

        const history = db.getFeatureHistory(featureId);
        expect(history.length).toBeGreaterThan(0);
        expect(history[0].note).toContain("Error: LLM rate limit exceeded");
      } finally {
        db.close();
      }
    });
  });
  test("pickNextFeature returns null when state is error", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      db.createFeature({ projectId, slug: "ready-f", title: "Ready", lane: "ready" });

      const sm = new AutoAgentStateMachine("worker", projectId, "sess-1");
      sm.start();
      sm.error("test error");
      expect(sm.getState()).toBe("error");

      const result = sm.pickNextFeature(tools, projectId, "sess-1");
      expect(result).toBeNull();
    } finally {
      db.close();
    }
  });

  test("pickNextFeature returns null when state is waiting", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      db.createFeature({ projectId, slug: "ready-f", title: "Ready", lane: "ready" });

      const sm = new AutoAgentStateMachine("worker", projectId, "sess-1");
      sm.start();
      sm.block(); // working → waiting
      expect(sm.getState()).toBe("waiting");

      const result = sm.pickNextFeature(tools, projectId, "sess-1");
      expect(result).toBeNull();
    } finally {
      db.close();
    }
  });

  test("pickNextFeature returns null when state is polling", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      db.createFeature({ projectId, slug: "ready-f", title: "Ready", lane: "ready" });

      const sm = new AutoAgentStateMachine("worker", projectId, "sess-1");
      sm.start();
      sm.noFeatureAvailable(); // working → polling
      expect(sm.getState()).toBe("polling");

      const result = sm.pickNextFeature(tools, projectId, "sess-1");
      expect(result).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("computeTargetLane", () => {
  test("design + designApprovalEnabled=true → design-approval", () => {
    expect(computeTargetLane("design", true)).toBe("design-approval");
  });

  test("design + designApprovalEnabled=false → ready", () => {
    expect(computeTargetLane("design", false)).toBe("ready");
  });

  test("ready → done", () => {
    expect(computeTargetLane("ready", true)).toBe("done");
    expect(computeTargetLane("ready", false)).toBe("done");
  });

  test("in-progress → done", () => {
    expect(computeTargetLane("in-progress", true)).toBe("done");
    expect(computeTargetLane("in-progress", false)).toBe("done");
  });

  test("design-approval → done", () => {
    expect(computeTargetLane("design-approval", true)).toBe("done");
  });

  test("backlog → done", () => {
    expect(computeTargetLane("backlog", true)).toBe("done");
    expect(computeTargetLane("backlog", false)).toBe("done");
  });

  test("uat → done", () => {
    expect(computeTargetLane("uat", true)).toBe("done");
    expect(computeTargetLane("uat", false)).toBe("done");
  });

  test("done → done", () => {
    expect(computeTargetLane("done", true)).toBe("done");
    expect(computeTargetLane("done", false)).toBe("done");
  });
});

describe("handleFeatureCompletion error handling", () => {
  test("handleFeatureCompletion throws when kanbanMove fails", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      db.createFeature({ projectId, slug: "err-feat", title: "Error Feature", lane: "design" });

      const sm = new AutoAgentStateMachine("designer", projectId, "sess-1");
      sm.start();
      const result = sm.pickNextFeature(tools, projectId, "sess-1");
      expect(result).not.toBeNull();

      // Replace kanbanMove with a throwing version
      const originalMove = tools.kanbanMove.bind(tools);
      tools.kanbanMove = () => {
        throw new Error("Simulated DB error");
      };

      // handleFeatureCompletion should throw
      expect(() =>
        sm.handleFeatureCompletion(tools, (result as NonNullable<typeof result>).kanbanFeatureId, "sess-1", projectId, {
          designApprovalEnabled: true,
        }),
      ).toThrow("Simulated DB error");

      // State should still be working (handleFeatureCompletion didn't complete)
      expect(sm.getState()).toBe("working");

      // Restore
      tools.kanbanMove = originalMove;
    } finally {
      db.close();
    }
  });

  test("handleFeatureCompletion returns null and completes when currentFeatureLane is null", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      db.createFeature({ projectId, slug: "null-lane-feat", title: "Null Lane Feature", lane: "design" });

      const sm = new AutoAgentStateMachine("designer", projectId, "sess-1");
      sm.start();
      const result = sm.pickNextFeature(tools, projectId, "sess-1");
      expect(result).not.toBeNull();

      // Simulate null currentFeatureLane
      (sm as unknown as Record<string, unknown>).currentFeatureLane = null;

      const returnVal = sm.handleFeatureCompletion(
        tools,
        (result as NonNullable<typeof result>).kanbanFeatureId,
        "sess-1",
        projectId,
      );
      expect(returnVal).toBeNull();
      expect(sm.getState()).toBe("idle"); // completed gracefully
    } finally {
      db.close();
    }
  });
});

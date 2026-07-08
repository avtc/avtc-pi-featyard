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

describe("AutoAgentStateMachine onBlock/isActive callbacks", () => {
  describe("block", () => {
    test("transitions from working to waiting", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");
        expect(sm.getState()).toBe("working");

        sm.block();
        expect(sm.getState()).toBe("waiting");
      } finally {
        db.close();
      }
    });

    test("is no-op when state is not working", async () => {
      const { db } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        // Go to error state (error() works from any state)
        sm.error("test error");
        expect(sm.getState()).toBe("error");

        // block() should be no-op when in error state
        sm.block();
        expect(sm.getState()).toBe("error");
      } finally {
        db.close();
      }
    });

    test("handles null currentFeatureId gracefully", async () => {
      const { db } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const overlayCalls: Array<{ featureId: number; status: string | null }> = [];

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.setOverlayCallback((fid, status) => {
          overlayCalls.push({ featureId: fid, status });
        });
        sm.start();
        // currentFeatureId is null (no feature picked)
        expect(sm.getCurrentFeatureId()).toBeNull();

        sm.block();

        // Should still transition to waiting, but no overlay call
        expect(sm.getState()).toBe("waiting");
        expect(overlayCalls).toEqual([]);
      } finally {
        db.close();
      }
    });

    test("calls overlayCallback with waiting-for-response status", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const overlayCalls: Array<{ featureId: number; status: string | null }> = [];
        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.setOverlayCallback((fid, status) => {
          overlayCalls.push({ featureId: fid, status });
        });
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");

        sm.block();

        expect(overlayCalls).toEqual([{ featureId, status: "waiting-for-response" }]);
      } finally {
        db.close();
      }
    });
  });

  describe("unblock", () => {
    test("transitions from waiting back to working", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");
        sm.block();
        expect(sm.getState()).toBe("waiting");

        sm.unblock();
        expect(sm.getState()).toBe("working");
      } finally {
        db.close();
      }
    });

    test("clears overlay status on unblock", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const overlayCalls: Array<{ featureId: number; status: string | null }> = [];
        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.setOverlayCallback((fid, status) => {
          overlayCalls.push({ featureId: fid, status });
        });
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");

        sm.block();
        sm.unblock();

        expect(overlayCalls).toEqual([
          { featureId, status: "waiting-for-response" },
          { featureId, status: null },
        ]);
      } finally {
        db.close();
      }
    });
  });

  describe("isActive-like state checks", () => {
    test("working state is active", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");

        expect(sm.getState()).toBe("working");
        // isActive checks: working, polling, waiting are all "in-progress"
        expect(["working", "polling", "waiting", "grace-period", "paused"]).toContain(sm.getState());
      } finally {
        db.close();
      }
    });

    test("waiting state is active", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");
        sm.block();

        expect(sm.getState()).toBe("waiting");
        expect(["working", "polling", "waiting", "grace-period", "paused"]).toContain(sm.getState());
      } finally {
        db.close();
      }
    });

    test("polling state is active", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        // pickNextFeature with no features → transitions to polling
        sm.pickNextFeature(tools, projectId, "session-1");

        expect(sm.getState()).toBe("polling");
        expect(["working", "polling", "waiting", "grace-period", "paused"]).toContain(sm.getState());
      } finally {
        db.close();
      }
    });

    test("grace-period state is active", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "design" });

        const sm = new AutoAgentStateMachine("designer", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");
        sm.enterGracePeriod();

        expect(sm.getState()).toBe("grace-period");
        expect(["working", "polling", "waiting", "grace-period", "paused"]).toContain(sm.getState());
      } finally {
        db.close();
      }
    });

    test("stopped state is not active", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        // requestStop immediately transitions to stopped from any state
        sm.pickNextFeature(tools, projectId, "session-1"); // no features → polling
        expect(sm.getState()).toBe("polling");
        sm.requestStop();

        expect(sm.getState()).toBe("stopped");
        expect(["working", "polling", "waiting", "grace-period", "paused"]).not.toContain(sm.getState());
      } finally {
        db.close();
      }
    });

    test("error state is not active", async () => {
      const { db } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        sm.error("test error");

        expect(sm.getState()).toBe("error");
        expect(["working", "polling", "waiting", "grace-period", "paused"]).not.toContain(sm.getState());
      } finally {
        db.close();
      }
    });

    test("paused state is active", async () => {
      const { db, tools } = await createDb();
      try {
        const projectId = db.createProject({ name: "test", repoPath: "/test" });
        db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

        const sm = new AutoAgentStateMachine("worker", projectId, "session-1");
        sm.start();
        sm.pickNextFeature(tools, projectId, "session-1");
        sm.pause();

        expect(sm.getState()).toBe("paused");
        expect(["working", "polling", "waiting", "grace-period", "paused"]).toContain(sm.getState());
      } finally {
        db.close();
      }
    });
  });
});

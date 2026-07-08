// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import type { AutoAgentCallback } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { AutoAgentStateMachine } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import { KanbanTools } from "../../../src/kanban/kanban-operations.js";

async function createDb(): Promise<{ db: KanbanDatabase; tools: KanbanTools }> {
  const db = await KanbanDatabase.createInMemory();
  const tools = new KanbanTools(db);
  return { db, tools };
}

describe("auto-agent loop integration", () => {
  test("pickNextFeature returns feature from ready lane for worker role", async () => {
    const { db, tools } = await createDb();
    try {
      // Setup: create project and feature in ready lane
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "2026-05-16-test-feature",
        title: "Test Feature",
        description: "A test feature",
        lane: "ready",
      });

      // Worker picks from ready lane
      const picked = tools.kanbanTake({
        projectId,
        lanes: ["ready"],
        sessionId: "worker-1",
      });

      expect(picked).toBeDefined();
      expect((picked as NonNullable<typeof picked>).id).toBe(featureId);
      expect((picked as NonNullable<typeof picked>).lane).toBe("in-progress");
      expect((picked as NonNullable<typeof picked>).locked_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  test("pickNextFeature returns null when no features available", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });

      const picked = tools.kanbanTake({
        projectId,
        lanes: ["ready"],
        sessionId: "worker-1",
      });

      expect(picked).toBeNull();
    } finally {
      db.close();
    }
  });

  test("pickNextFeature picks from design lane for designer role", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "2026-05-16-design-feature",
        title: "Design Feature",
        description: "A design feature",
        lane: "design",
      });

      const picked = tools.kanbanTake({
        projectId,
        lanes: ["design"],
        sessionId: "designer-1",
      });

      expect(picked).toBeDefined();
      expect((picked as NonNullable<typeof picked>).id).toBe(featureId);
    } finally {
      db.close();
    }
  });

  test("pickNextFeature prefers design over ready for agent role", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      db.createFeature({
        projectId,
        slug: "2026-05-16-ready-feature",
        title: "Ready Feature",
        description: "A ready feature",
        lane: "ready",
        priority: 1,
      });
      const designFeatureId = db.createFeature({
        projectId,
        slug: "2026-05-16-design-feature",
        title: "Design Feature",
        description: "A design feature",
        lane: "design",
        priority: 1,
      });

      // Agent picks from design first, then ready
      const picked = tools.kanbanTake({
        projectId,
        lanes: ["design", "ready"],
        sessionId: "agent-1",
      });

      expect(picked).toBeDefined();
      expect((picked as NonNullable<typeof picked>).id).toBe(designFeatureId);
    } finally {
      db.close();
    }
  });

  test("on feature completion, lock is released and feature moved to done", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      db.createFeature({
        projectId,
        slug: "2026-05-16-complete-feature",
        title: "Complete Feature",
        description: "A feature to complete",
        lane: "ready",
      });

      // Take the feature
      const picked = tools.kanbanTake({
        projectId,
        lanes: ["ready"],
        sessionId: "worker-1",
      });
      expect(picked).toBeDefined();

      // Complete: move to done and release lock
      tools.kanbanMove({
        featureId: (picked as NonNullable<typeof picked>).id,
        toLane: "done",
        changedBy: "agent:worker-1",
      });
      tools.kanbanRelease({ featureId: (picked as NonNullable<typeof picked>).id });

      const updated = db.getFeature((picked as NonNullable<typeof picked>).id);
      expect((updated as NonNullable<typeof updated>).lane).toBe("done");
      expect((updated as NonNullable<typeof updated>).locked_at).toBeNull();
    } finally {
      db.close();
    }
  });

  test("on error, lock is released and feature moved back to original lane", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
      db.createFeature({
        projectId,
        slug: "2026-05-16-error-feature",
        title: "Error Feature",
        description: "A feature that errors",
        lane: "ready",
      });

      // Take the feature
      const picked = tools.kanbanTake({
        projectId,
        lanes: ["ready"],
        sessionId: "worker-1",
      });
      expect(picked).toBeDefined();

      // Error: move back to ready and release lock
      tools.kanbanMove({
        featureId: (picked as NonNullable<typeof picked>).id,
        toLane: "ready",
        changedBy: "agent:worker-1",
        note: "Error: something went wrong",
      });
      tools.kanbanRelease({ featureId: (picked as NonNullable<typeof picked>).id });

      const updated = db.getFeature((picked as NonNullable<typeof picked>).id);
      expect((updated as NonNullable<typeof updated>).lane).toBe("ready");
      expect((updated as NonNullable<typeof updated>).locked_at).toBeNull();
    } finally {
      db.close();
    }
  });

  test("auto-agent callback bridge via globalThis", async () => {
    // Test the cross-extension callback pattern
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();

    // Simulate the callback bridge pattern
    let callbackInvoked = false;
    const bridge = {
      onFeatureComplete: () => {
        callbackInvoked = true;
        sm.complete(); // feature done, check for next
        if (sm.getState() === "idle") {
          // Would normally call pickNextFeature
        }
      },
    };

    // Store on globalThis (simulating cross-extension state)
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgentCallback = bridge as unknown as AutoAgentCallback;

    // Simulate workflow-monitor calling the callback on feature completion
    const cb = globalThis.__piKanban?.autoAgentCallback?.onFeatureComplete;
    if (cb) cb("test-feature");
    expect(callbackInvoked).toBe(true);
    expect(sm.getState()).toBe("idle");

    // Cleanup
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgentCallback = undefined as unknown as AutoAgentCallback;
  });

  // --- Role-based pickNextFeature tests via AutoAgentStateMachine ---

  test("pickNextFeature: worker picks from ready lane only", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      // Feature in design lane (worker should NOT pick)
      db.createFeature({
        projectId,
        slug: "design-f",
        title: "Design",
        lane: "design",
        description: "Design feature description",
      });
      // Feature in ready lane (worker SHOULD pick)
      const readyId = db.createFeature({ projectId, slug: "ready-f", title: "Ready", lane: "ready" });

      const sm = new AutoAgentStateMachine("worker", projectId, "sess-1");
      sm.start();

      const result = sm.pickNextFeature(tools, projectId, "sess-1");
      expect(result).not.toBeNull();
      expect((result as NonNullable<typeof result>).feature.id).toBe(readyId);
      expect((result as NonNullable<typeof result>).skill).toBe("ff-plan");
      expect((result as NonNullable<typeof result>).kanbanFeatureId).toBe(readyId);
    } finally {
      db.close();
    }
  });

  test("pickNextFeature: designer picks from design lane only", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      // Feature in ready lane (designer should NOT pick)
      db.createFeature({ projectId, slug: "ready-f", title: "Ready", lane: "ready" });
      // Feature in design lane (designer SHOULD pick)
      const designId = db.createFeature({
        projectId,
        slug: "design-f",
        title: "Design",
        lane: "design",
        description: "Design feature description",
      });

      const sm = new AutoAgentStateMachine("designer", projectId, "sess-2");
      sm.start();

      const result = sm.pickNextFeature(tools, projectId, "sess-2");
      expect(result).not.toBeNull();
      expect((result as NonNullable<typeof result>).feature.id).toBe(designId);
      expect((result as NonNullable<typeof result>).skill).toBe("ff-design");
    } finally {
      db.close();
    }
  });

  test("pickNextFeature: agent picks from design first, then ready", async () => {
    const { db, tools } = await createDb();
    try {
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      const readyId = db.createFeature({ projectId, slug: "ready-f", title: "Ready", lane: "ready" });
      const designId = db.createFeature({
        projectId,
        slug: "design-f",
        title: "Design",
        lane: "design",
        description: "Design feature description",
      });

      const sm = new AutoAgentStateMachine("agent", projectId, "sess-3");
      sm.start();

      // First pick should get design feature
      const first = sm.pickNextFeature(tools, projectId, "sess-3");
      expect(first).not.toBeNull();
      expect((first as NonNullable<typeof first>).feature.id).toBe(designId);
      expect((first as NonNullable<typeof first>).skill).toBe("ff-design");

      // handleFeatureCompletion moves design feature to design-approval (default) and picks next
      const second = sm.handleFeatureCompletion(tools, designId, "sess-3", projectId);
      expect(second).not.toBeNull();
      expect((second as NonNullable<typeof second>).feature.id).toBe(readyId);
      expect((second as NonNullable<typeof second>).skill).toBe("ff-plan");

      // Verify design feature was moved to design-approval (not done)
      const designFeature = db.getFeature(designId);
      expect((designFeature as NonNullable<typeof designFeature>).lane).toBe("design-approval");
    } finally {
      db.close();
    }
  });
});

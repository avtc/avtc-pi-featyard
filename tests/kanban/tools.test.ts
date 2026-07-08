// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import type { Feature } from "../../src/kanban/data/kanban-types.js";
import { KanbanTools } from "../../src/kanban/kanban-operations.js";

const TEMP_DIRS: string[] = [];
const DATABASES: KanbanDatabase[] = [];

afterEach(() => {
  for (const db of DATABASES.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-tools-test-"));
  TEMP_DIRS.push(dir);
  const db = await KanbanDatabase.createInMemory();
  DATABASES.push(db);
  const tools = new KanbanTools(db);
  const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
  return { db, tools, projectId, dir };
}

describe("kanban_add", () => {
  test("adds feature to backlog", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = tools.kanbanAdd({
      projectId,
      slug: "new-feature",
      title: "New Feature",
      description: "A new feature",
    });
    expect(featureId).toBeGreaterThan(0);

    const feature = db.getFeature(featureId);
    expect((feature as NonNullable<typeof feature>).lane).toBe("backlog");
  });
});

describe("kanban_take", () => {
  test("picks from ready lane and moves to in-progress", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({
      projectId,
      slug: "take-test",
      title: "Take",
      lane: "ready",
    });

    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["ready"] });
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).id).toBe(featureId);

    const feature = db.getFeature(featureId);
    expect((feature as NonNullable<typeof feature>).lane).toBe("in-progress");
  });

  test("picks from design lane and keeps in design", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({
      projectId,
      slug: "design-test",
      title: "Design",
      lane: "design",
      description: "Needs design",
    });

    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["design"] });
    expect(result).not.toBeNull();

    const feature = db.getFeature(featureId);
    expect((feature as NonNullable<typeof feature>).lane).toBe("design"); // stays in design
  });

  test("returns null when no features available", async () => {
    const { tools } = await setup();
    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["ready"] });
    expect(result).toBeNull();
  });

  test("prevents race conditions — second take returns null", async () => {
    const { tools, projectId, db } = await setup();
    db.createFeature({ projectId, slug: "race-test", title: "Race", lane: "ready" });

    const result1 = tools.kanbanTake({ sessionId: "session-1", lanes: ["ready"] });
    const result2 = tools.kanbanTake({ sessionId: "session-2", lanes: ["ready"] });

    expect(result1).not.toBeNull();
    expect(result2).toBeNull(); // no more features
  });
});

describe("kanban_take cross-project isolation", () => {
  test("kanbanTake with projectId only picks features from that project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-xproject-"));
    TEMP_DIRS.push(dir);
    const db = await KanbanDatabase.createInMemory();
    DATABASES.push(db);
    const tools = new KanbanTools(db);

    // Create two projects
    const projectA = db.createProject({ name: "Project A", repoPath: "/home/user/proj-a" });
    const projectB = db.createProject({ name: "Project B", repoPath: "/home/user/proj-b" });

    // Add ready features to both projects
    db.createFeature({ projectId: projectA, slug: "feature-a1", title: "A1", lane: "ready" });
    db.createFeature({ projectId: projectA, slug: "feature-a2", title: "A2", lane: "ready" });
    db.createFeature({ projectId: projectB, slug: "feature-b1", title: "B1", lane: "ready" });

    // Take from project A only
    const result = tools.kanbanTake({ sessionId: "s1", lanes: ["ready"], projectId: projectA });
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).slug).toBe("feature-a1"); // picks from project A

    // Project B feature should still be available
    const bFeature = db.getFeature(db.findAvailableFeatures(projectB, ["ready"])[0]?.id ?? -1);
    expect(bFeature).toBeTruthy();
    expect((bFeature as NonNullable<typeof bFeature>).slug).toBe("feature-b1");
  });

  test("kanbanTake without projectId picks from any project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-xproject2-"));
    TEMP_DIRS.push(dir);
    const db = await KanbanDatabase.createInMemory();
    DATABASES.push(db);
    const tools = new KanbanTools(db);

    const projectA = db.createProject({ name: "Project A", repoPath: "/home/user/proj-a" });
    const projectB = db.createProject({ name: "Project B", repoPath: "/home/user/proj-b" });

    db.createFeature({ projectId: projectA, slug: "feature-a1", title: "A1", lane: "ready" });
    db.createFeature({ projectId: projectB, slug: "feature-b1", title: "B1", lane: "ready" });

    // Take without projectId should pick from any project
    const result = tools.kanbanTake({ sessionId: "s1", lanes: ["ready"] });
    expect(result).not.toBeNull();
  });
});

describe("kanban_take description validation", () => {
  test("rejects design lane feature with empty description", async () => {
    const { tools, projectId, db } = await setup();
    db.createFeature({
      projectId,
      slug: "no-desc",
      title: "No Description",
      lane: "design",
      description: "",
    });

    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["design"] });
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).slug).toBe("no-desc");
  });

  test("accepts design lane feature with null description (title is sufficient)", async () => {
    const { tools, projectId, db } = await setup();
    db.createFeature({
      projectId,
      slug: "null-desc",
      title: "Null Description",
      lane: "design",
      description: null,
    });

    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["design"] });
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).slug).toBe("null-desc");
  });

  test("picks first available design feature regardless of description", async () => {
    const { tools, projectId, db } = await setup();
    // First feature: empty description (should be picked)
    db.createFeature({
      projectId,
      slug: "empty-desc",
      title: "Empty Description",
      lane: "design",
      description: "",
    });
    // Second feature: valid description (should NOT be picked, first has priority)
    db.createFeature({
      projectId,
      slug: "valid-desc",
      title: "Valid Description",
      lane: "design",
      description: "This has a description",
    });

    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["design"] });
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).slug).toBe("empty-desc");
  });

  test("accepts design lane feature with non-empty description", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({
      projectId,
      slug: "has-desc",
      title: "Has Description",
      lane: "design",
      description: "A proper description for designing",
    });

    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["design"] });
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).id).toBe(featureId);
  });

  test("does not validate description for ready lane", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({
      projectId,
      slug: "ready-no-desc",
      title: "Ready No Desc",
      lane: "ready",
      description: "",
    });

    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["ready"] });
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).id).toBe(featureId);
  });
});

describe("kanban_move", () => {
  test("moves feature to new lane", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({
      projectId,
      slug: "move-test",
      title: "Move",
      lane: "backlog",
    });

    tools.kanbanMove({ featureId, toLane: "design", changedBy: "user" });
    expect((db.getFeature(featureId) as NonNullable<ReturnType<typeof db.getFeature>>).lane).toBe("design");
  });
});

describe("kanban_release", () => {
  test("releases feature lock", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({
      projectId,
      slug: "release-test",
      title: "Release",
      lane: "ready",
    });

    tools.kanbanTake({ sessionId: "session-1", lanes: ["ready"] });
    tools.kanbanRelease({ featureId });

    // Should be lockable again
    const result = tools.kanbanTake({ sessionId: "session-2", lanes: ["in-progress"] });
    expect(result).not.toBeNull();
  });
});

describe("kanban_list", () => {
  test("lists features filtered by lane", async () => {
    const { tools, projectId, db } = await setup();
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog" });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "ready" });

    const backlog = tools.kanbanList({ projectId, lane: "backlog" });
    expect(backlog).toHaveLength(1);
    expect(backlog[0]?.slug).toBe("a");
  });

  test("lists all features when no lane filter", async () => {
    const { tools, projectId, db } = await setup();
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog" });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "ready" });

    const all = tools.kanbanList({ projectId });
    expect(all).toHaveLength(2);
  });
});

describe("kanban_update", () => {
  test("updates title and description", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({ projectId, slug: "update-test", title: "Original", lane: "backlog" });

    tools.kanbanUpdate({ featureId, title: "Updated Title", description: "New description" });

    const feature = db.getFeature(featureId);
    expect((feature as NonNullable<typeof feature>).title).toBe("Updated Title");
    expect((feature as NonNullable<typeof feature>).description).toBe("New description");
  });

  test("updates priority", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({ projectId, slug: "prio-test", title: "Prio", lane: "backlog", priority: 0 });

    tools.kanbanUpdate({ featureId, priority: 10 });

    const feature = db.getFeature(featureId);
    expect((feature as NonNullable<typeof feature>).priority).toBe(10);
  });

  test("partial update leaves other fields unchanged", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({
      projectId,
      slug: "partial-test",
      title: "Original",
      lane: "backlog",
      description: "Keep me",
    });

    tools.kanbanUpdate({ featureId, title: "New Title" });

    const feature = db.getFeature(featureId);
    expect((feature as NonNullable<typeof feature>).title).toBe("New Title");
    expect((feature as NonNullable<typeof feature>).description).toBe("Keep me");
  });
});

describe("kanban_history", () => {
  test("returns empty history for new feature", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({ projectId, slug: "hist-test", title: "History", lane: "backlog" });

    const history = tools.kanbanHistory(featureId);
    expect(history).toEqual([]);
  });

  test("records lane move in history", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({ projectId, slug: "move-hist", title: "MoveHist", lane: "backlog" });

    tools.kanbanMove({ featureId, toLane: "design", changedBy: "user", note: "Starting design" });

    const history = tools.kanbanHistory(featureId);
    expect(history).toHaveLength(1);
    expect(history[0]?.from_lane).toBe("backlog");
    expect(history[0]?.to_lane).toBe("design");
    expect(history[0]?.changed_by).toBe("user");
    expect(history[0]?.note).toBe("Starting design");
  });

  test("accumulates multiple moves", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({ projectId, slug: "multi-hist", title: "Multi", lane: "backlog" });

    tools.kanbanMove({ featureId, toLane: "design", changedBy: "user" });
    tools.kanbanMove({ featureId, toLane: "ready", changedBy: "user" });
    tools.kanbanMove({ featureId, toLane: "in-progress", changedBy: "agent:session-1" });

    const history = tools.kanbanHistory(featureId);
    expect(history).toHaveLength(3);
    // Ordered by created_at DESC — newest first
    expect(history[0]?.to_lane).toBe("in-progress");
    expect(history[1]?.to_lane).toBe("ready");
    expect(history[2]?.to_lane).toBe("design");
  });
});

describe("kanban_heartbeat", () => {
  test("refreshes lock heartbeat", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({ projectId, slug: "hb-test", title: "Heartbeat", lane: "ready" });

    // Take to lock it
    tools.kanbanTake({ sessionId: "session-1", lanes: ["ready"] });
    const before = db.getFeature(featureId) as Feature;
    expect(before.locked_at).toBeTruthy();

    // Wait a tiny bit so heartbeat timestamp differs
    await new Promise((r) => setTimeout(r, 0));

    tools.kanbanHeartbeat(featureId, "session-1");
    const after = db.getFeature(featureId) as Feature;
    expect(after.last_heartbeat).toBeTruthy();
  });

  test("heartbeat on unlocked feature is a no-op", async () => {
    const { tools, projectId, db } = await setup();
    const featureId = db.createFeature({ projectId, slug: "hb-noop", title: "NoLock", lane: "backlog" });

    // Should not throw
    tools.kanbanHeartbeat(featureId, "session-1");

    const feature = db.getFeature(featureId) as Feature;
    expect(feature.locked_at).toBeFalsy();
  });
});

describe("kanbanTake edge cases", () => {
  test("returns null when specified lanes are empty", async () => {
    const { tools, projectId, db } = await setup();
    // Create a feature in backlog only (not in ready or design)
    db.createFeature({
      projectId,
      slug: "backlog-f",
      title: "Backlog Feature",
      lane: "backlog",
    });

    // Try to take from ready and design lanes (both empty)
    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["ready", "design"] });
    expect(result).toBeNull();
  });

  test("accepts design-lane feature with whitespace-only description", async () => {
    const { tools, projectId, db } = await setup();
    db.createFeature({
      projectId,
      slug: "ws-design",
      title: "Whitespace Design",
      lane: "design",
      description: "   ",
    });

    const result = tools.kanbanTake({ sessionId: "session-1", lanes: ["design"] });
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).slug).toBe("ws-design");
  });

  describe("kanbanUpdate with tags and dependencies", () => {
    test("kanbanUpdate adds tags by name (creates tag if needed)", async () => {
      const { tools, db } = await setup();
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      const featureId = db.createFeature({ projectId, slug: "feat-tags", title: "Tags Feature" });
      tools.kanbanUpdate({ featureId, addTags: ["bug", "urgent"] });
      const tags = db.listFeatureTags(featureId);
      expect(tags).toHaveLength(2);
      expect(tags.map((t) => t.name).sort()).toEqual(["bug", "urgent"]);
    });

    test("kanbanUpdate removes tags by name", async () => {
      const { tools, db } = await setup();
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      const featureId = db.createFeature({ projectId, slug: "feat-tags2", title: "Tags Feature 2" });
      tools.kanbanUpdate({ featureId, addTags: ["bug", "urgent"] });
      tools.kanbanUpdate({ featureId, removeTags: ["bug"] });
      const tags = db.listFeatureTags(featureId);
      expect(tags).toHaveLength(1);
      expect(tags[0].name).toBe("urgent");
    });

    test("kanbanUpdate adds dependency", async () => {
      const { tools, db } = await setup();
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      const featureA = db.createFeature({ projectId, slug: "feat-a", title: "A" });
      const featureB = db.createFeature({ projectId, slug: "feat-b", title: "B" });
      tools.kanbanUpdate({ featureId: featureA, addDependency: { dependsOnId: featureB, kind: "blocks" } });
      const deps = db.listDependencies(featureA);
      expect(deps).toHaveLength(1);
      expect(deps[0].dependsOnId).toBe(featureB);
      expect(deps[0].kind).toBe("blocks");
    });

    test("kanbanUpdate removes dependency", async () => {
      const { tools, db } = await setup();
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      const featureA = db.createFeature({ projectId, slug: "feat-a", title: "A" });
      const featureB = db.createFeature({ projectId, slug: "feat-b", title: "B" });
      tools.kanbanUpdate({ featureId: featureA, addDependency: { dependsOnId: featureB, kind: "requires" } });
      tools.kanbanUpdate({ featureId: featureA, removeDependency: { dependsOnId: featureB } });
      const deps = db.listDependencies(featureA);
      expect(deps).toHaveLength(0);
    });
  });
});

describe("kanbanTake FIFO priority", () => {
  test("assigns FIFO priority when taking feature to in-progress", async () => {
    const { tools, db, projectId } = await setup();
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "ready", priority: 50 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "ready", priority: 50 });

    // Take first feature
    const result1 = tools.kanbanTake({ sessionId: "session-1", lanes: ["ready"] });
    expect(result1).not.toBeNull();
    expect((result1 as NonNullable<typeof result1>).id).toBe(id1);
    expect((result1 as NonNullable<typeof result1>).lane).toBe("in-progress");

    // Take second feature
    const result2 = tools.kanbanTake({ sessionId: "session-2", lanes: ["ready"] });
    expect(result2).not.toBeNull();
    expect((result2 as NonNullable<typeof result2>).id).toBe(id2);
    expect((result2 as NonNullable<typeof result2>).lane).toBe("in-progress");

    // Verify FIFO: id1 first → min(50)-10=40, id2 second → min(40,50)-10=30
    const f1 = db.getFeature(id1) as Feature;
    const f2 = db.getFeature(id2) as Feature;
    expect(f1.priority).toBe(40);
    expect(f2.priority).toBe(30);
  });

  test("design lane picks keep original priority (no FIFO)", async () => {
    const { tools, db, projectId } = await setup();
    const id1 = db.createFeature({
      projectId,
      slug: "a",
      title: "A",
      lane: "design",
      priority: 50,
      description: "Design A",
    });
    const id2 = db.createFeature({
      projectId,
      slug: "b",
      title: "B",
      lane: "design",
      priority: 30,
      description: "Design B",
    });

    // Take first feature from design lane
    const result1 = tools.kanbanTake({ sessionId: "session-1", lanes: ["design"] });
    expect(result1).not.toBeNull();
    expect((result1 as NonNullable<typeof result1>).id).toBe(id1);
    // Design picks stay in design lane
    expect((result1 as NonNullable<typeof result1>).lane).toBe("design");
    // Priority should be unchanged (not FIFO-reassigned)
    expect((result1 as NonNullable<typeof result1>).priority).toBe(50);

    // Take second feature from design lane
    const result2 = tools.kanbanTake({ sessionId: "session-2", lanes: ["design"] });
    expect(result2).not.toBeNull();
    expect((result2 as NonNullable<typeof result2>).id).toBe(id2);
    expect((result2 as NonNullable<typeof result2>).lane).toBe("design");
    // Priority should be unchanged
    expect((result2 as NonNullable<typeof result2>).priority).toBe(30);
  });
});

describe("kanbanPeek", () => {
  test("returns highest-priority feature without locking", async () => {
    const { db, tools, projectId } = await setup();
    const featureId1 = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "design" });
    db.createFeature({ projectId, slug: "feat-2", title: "Feature 2", lane: "design" });

    const peeked = tools.kanbanPeek({ projectId, lanes: ["design"] });
    expect(peeked).not.toBeNull();
    expect((peeked as NonNullable<typeof peeked>).id).toBe(featureId1);

    // Feature is NOT locked — can be taken by another agent
    const lockResult = db.lockFeature(featureId1, "other-session");
    expect(lockResult).toBe(true);
  });

  test("returns null when no features available", async () => {
    const { tools, projectId } = await setup();

    const peeked = tools.kanbanPeek({ projectId, lanes: ["design"] });
    expect(peeked).toBeNull();
  });

  test("skips locked features", async () => {
    const { db, tools, projectId } = await setup();
    const featureId = db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "design" });
    db.lockFeature(featureId, "other-session");

    const peeked = tools.kanbanPeek({ projectId, lanes: ["design"] });
    expect(peeked).toBeNull();
  });

  test("does not move ready features to in-progress", async () => {
    const { db, tools, projectId } = await setup();
    db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

    const peeked = tools.kanbanPeek({ projectId, lanes: ["ready"] });
    expect(peeked).not.toBeNull();
    expect((peeked as NonNullable<typeof peeked>).lane).toBe("ready"); // NOT moved to in-progress
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, test } from "vitest";
import {
  EMPTY_PARAMS,
  fifoPriority,
  INTERACTIVE_SESSION_PREFIX,
  interactiveSessionIdFor,
  KanbanDatabase,
  topPriority,
} from "../../../src/kanban/data/kanban-database.js";

const DATABASES: KanbanDatabase[] = [];

afterEach(() => {
  for (const db of DATABASES.splice(0)) {
    try {
      db.close();
    } catch {}
  }
});

async function createDb(): Promise<KanbanDatabase> {
  const db = await KanbanDatabase.createInMemory();
  DATABASES.push(db);
  return db;
}

describe("interactive session id helpers", () => {
  test("INTERACTIVE_SESSION_PREFIX is the session: literal", () => {
    // Single source of truth for the interactive-lock identity and the sweeper's
    // NOT LIKE 'session:%' exemption. Changing this would break lock immortality.
    expect(INTERACTIVE_SESSION_PREFIX).toBe("session:");
  });

  test("interactiveSessionIdFor builds the session:<slug> identity", () => {
    expect(interactiveSessionIdFor("my-feature")).toBe("session:my-feature");
    expect(interactiveSessionIdFor("2026-06-20-user-decisions")).toBe("session:2026-06-20-user-decisions");
  });

  test("interactiveSessionIdFor with an empty slug yields the bare prefix (defensive)", () => {
    // Documents the slugless edge: the result is still "session:"-prefixed (so it
    // would be exempt from the sweeper), but such features cannot exist in practice
    // (all creation paths auto-generate a slug). /fy:auto-stop guards against this.
    expect(interactiveSessionIdFor("")).toBe("session:");
  });
});

describe("KanbanDatabase", () => {
  test("initializes database with schema", async () => {
    const db = await createDb();
    expect(db).toBeDefined();

    // Verify tables exist
    const tables = db.listTables();
    expect(tables).toContain("projects");
    expect(tables).toContain("features");
    expect(tables).toContain("tags");
    expect(tables).toContain("feature_tags");
    expect(tables).toContain("feature_dependencies");
    expect(tables).toContain("feature_history");
    expect(tables).toContain("feature_locks");
    expect(tables).toContain("schema_migrations");
  });

  test("project CRUD operations", async () => {
    const db = await createDb();

    const projectId = db.createProject({ name: "Test Project", repoPath: "/home/user/project" });
    expect(projectId).toBeGreaterThan(0);

    const project = db.getProject(projectId);
    expect(project?.name).toBe("Test Project");
    expect(project?.repo_path).toBe("/home/user/project");
  });

  test("feature CRUD operations", async () => {
    const db = await createDb();

    const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
    const featureId = db.createFeature({
      projectId,
      slug: "test-feature",
      title: "Test Feature",
      description: "A test feature",
      lane: "backlog",
    });
    expect(featureId).toBeGreaterThan(0);

    const feature = db.getFeature(featureId);
    expect(feature?.slug).toBe("test-feature");
    expect(feature?.title).toBe("Test Feature");
    expect(feature?.lane).toBe("backlog");
  });

  test("feature slug is unique per project", async () => {
    const db = await createDb();

    const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
    db.createFeature({ projectId, slug: "unique-slug", title: "First", lane: "backlog" });

    expect(() => {
      db.createFeature({ projectId, slug: "unique-slug", title: "Second", lane: "backlog" });
    }).toThrow();
  });

  test("move feature and record history", async () => {
    const db = await createDb();

    const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
    const featureId = db.createFeature({
      projectId,
      slug: "move-test",
      title: "Move Test",
      lane: "backlog",
    });

    db.moveFeature({ featureId, toLane: "design", changedBy: "user" });

    const feature = db.getFeature(featureId);
    expect(feature?.lane).toBe("design");

    const history = db.getFeatureHistory(featureId);
    expect(history).toHaveLength(1);
    expect(history[0]?.from_lane).toBe("backlog");
    expect(history[0]?.to_lane).toBe("design");
    expect(history[0]?.changed_by).toBe("user");
  });

  test("lock and unlock feature", async () => {
    const db = await createDb();

    const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
    const featureId = db.createFeature({
      projectId,
      slug: "lock-test",
      title: "Lock Test",
      lane: "ready",
    });

    const locked = db.lockFeature(featureId, "session-1");
    expect(locked).toBe(true);

    // Second lock attempt should fail
    const lockedAgain = db.lockFeature(featureId, "session-2");
    expect(lockedAgain).toBe(false);

    // Unlock
    db.unlockFeature(featureId);

    // Can lock again
    const relocked = db.lockFeature(featureId, "session-3");
    expect(relocked).toBe(true);
  });

  test("lockFeature re-throws non-UNIQUE errors", async () => {
    const db = await createDb();

    // Try to lock a non-existent feature — should throw FK error, not return false
    expect(() => db.lockFeature(99999, "session-1")).toThrow();
  });

  test("heartbeat refreshes lock timestamp", async () => {
    const db = await createDb();

    const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
    const featureId = db.createFeature({
      projectId,
      slug: "heartbeat-test",
      title: "Heartbeat",
      lane: "ready",
    });

    db.lockFeature(featureId, "session-1");
    const lockBefore = db.rawExec("SELECT locked_at, last_heartbeat FROM feature_locks WHERE feature_id = ?", [
      featureId,
    ]);
    const before = lockBefore[0]?.last_heartbeat;

    // Small delay so heartbeat timestamp differs
    await new Promise((r) => setTimeout(r, 10));
    db.heartbeat(featureId, "session-1");
    const lockAfter = db.rawExec("SELECT last_heartbeat FROM feature_locks WHERE feature_id = ?", [featureId]);
    const after = lockAfter[0]?.last_heartbeat;

    expect(after).not.toBe(before);
  });

  test("reassignLock transfers a lock from one session to another", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
    const featureId = db.createFeature({
      projectId,
      slug: "reassign-test",
      title: "Reassign",
      lane: "in-progress",
    });

    const agentSession = "11111111-1111-1111-1111-111111111111";
    const interactiveSession = "session:reassign-test";
    db.lockFeature(featureId, agentSession);

    // Transfer auto-agent lock → interactive identity.
    const moved = db.reassignLock(featureId, agentSession, interactiveSession);
    expect(moved).toBe(true);

    const feature = db.getFeature(featureId);
    expect(feature?.locked_at).toBeTruthy();
    expect(feature?.locked_by_session).toBe(interactiveSession);

    // Reassigning a lock that is NOT held by fromSessionId is a no-op.
    const noop = db.reassignLock(featureId, agentSession, "session:someone-else");
    expect(noop).toBe(false);
    expect(db.getFeature(featureId)?.locked_by_session).toBe(interactiveSession);
  });

  test("reassignLock returns false for a feature with no lock row at all", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
    const featureId = db.createFeature({
      projectId,
      slug: "never-locked",
      title: "Never Locked",
      lane: "backlog",
    });
    // No lockFeature() call — there is no row in feature_locks for this feature.
    expect(db.getFeature(featureId)?.locked_at).toBeNull();

    const moved = db.reassignLock(featureId, "11111111-1111-1111-1111-111111111111", "session:never-locked");
    expect(moved).toBe(false);
    // Still unlocked.
    expect(db.getFeature(featureId)?.locked_at).toBeNull();
  });

  test("reassignLock returns false for an unknown featureId", async () => {
    const db = await createDb();
    db.createProject({ name: "Test", repoPath: "/home/user/test" });

    const moved = db.reassignLock(999999, "11111111-1111-1111-1111-111111111111", "session:unknown");
    expect(moved).toBe(false);
  });

  test("list features by lane with priority ordering", async () => {
    const db = await createDb();

    const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
    db.createFeature({ projectId, slug: "low", title: "Low", lane: "backlog", priority: 1 });
    db.createFeature({ projectId, slug: "high", title: "High", lane: "backlog", priority: 10 });
    db.createFeature({ projectId, slug: "med", title: "Med", lane: "backlog", priority: 5 });

    const features = db.listFeatures(projectId, "backlog", undefined);
    expect(features.map((f) => f.slug)).toEqual(["high", "med", "low"]);
  });

  test("expired locks are cleaned up", async () => {
    const db = await createDb();

    const projectId = db.createProject({ name: "Test", repoPath: "/home/user/test" });
    const featureId = db.createFeature({
      projectId,
      slug: "expire-test",
      title: "Expire",
      lane: "ready",
    });

    db.lockFeature(featureId, "session-1");

    // Manually expire the lock (set last_heartbeat to 31 minutes ago)
    const past = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.rawExec("UPDATE feature_locks SET last_heartbeat = ? WHERE feature_id = ?", [past, featureId]);

    // Cleanup should remove the expired lock
    const cleaned = db.cleanupExpiredLocks(30 * 60 * 1000); // 30 min timeout
    expect(cleaned).toBe(1);

    // Feature should be lockable again
    const locked = db.lockFeature(featureId, "session-2");
    expect(locked).toBe(true);
  });

  test("runInTransaction commits on success", async () => {
    const db = await createDb();

    // Use rawExec inside transaction (no createProject before to avoid save() interaction)
    db.runInTransaction(() => {
      db.rawExec(
        "INSERT INTO projects (name, repo_path, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
        ["TxTest", "/tx"],
      );
    });

    const tables = db.listTables();
    expect(tables).toContain("projects");
    const projects = db.rawExec("SELECT * FROM projects WHERE name = ?", ["TxTest"]);
    expect(projects).toHaveLength(1);
  });

  test("runInTransaction rolls back on error", async () => {
    const db = await createDb();

    expect(() =>
      db.runInTransaction(() => {
        db.rawExec(
          "INSERT INTO projects (name, repo_path, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
          ["TxRollback", "/txrb"],
        );
        throw new Error("boom");
      }),
    ).toThrow("boom");

    const projects = db.rawExec("SELECT * FROM projects WHERE name = ?", ["TxRollback"]);
    expect(projects).toHaveLength(0);
  });

  test("updateFeature modifies title, description, and priority", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "UpdTest", repoPath: "/upd" });
    const featureId = db.createFeature({
      projectId,
      slug: "upd-f",
      title: "Original",
      lane: "backlog",
      description: "Old desc",
      priority: 0,
    });

    db.updateFeature({ featureId, title: "Updated", description: "New desc", priority: 5 });

    const feature = db.getFeature(featureId);
    expect(feature?.title).toBe("Updated");
    expect(feature?.description).toBe("New desc");
    expect(feature?.priority).toBe(5);
  });

  test("updateFeature partial update only changes specified fields", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "PartTest", repoPath: "/part" });
    const featureId = db.createFeature({
      projectId,
      slug: "part-f",
      title: "Keep",
      lane: "backlog",
      description: "Keep desc",
    });

    db.updateFeature({ featureId, priority: 10 });

    const feature = db.getFeature(featureId);
    expect(feature?.title).toBe("Keep");
    expect(feature?.description).toBe("Keep desc");
    expect(feature?.priority).toBe(10);
  });

  test("updateFeature with no fields is a no-op", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "NoopTest", repoPath: "/noop" });
    const featureId = db.createFeature({ projectId, slug: "noop-f", title: "Same", lane: "backlog" });

    db.updateFeature({ featureId });

    const feature = db.getFeature(featureId);
    expect(feature?.title).toBe("Same");
  });

  test("deleteFeature removes feature from database", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "DelTest", repoPath: "/del" });
    const featureId = db.createFeature({ projectId, slug: "del-f", title: "Delete Me", lane: "backlog" });

    expect(db.getFeature(featureId)).not.toBeNull();
    expect(db.deleteFeature(featureId)).toBe(true);
    expect(db.getFeature(featureId)).toBeNull();
  });

  test("deleteFeature returns true for non-existent feature (no-op)", async () => {
    const db = await createDb();
    expect(db.deleteFeature(99999)).toBe(true);
  });

  test("deleteFeature cascades related data", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "CascadeTest", repoPath: "/cascade" });
    const featureId = db.createFeature({ projectId, slug: "cascade-f", title: "Cascade", lane: "backlog" });

    // Add history via move
    db.moveFeature({ featureId, toLane: "design", changedBy: "user" });
    // Lock the feature
    db.lockFeature(featureId, "session-1");

    // Delete should refuse while locked
    expect(db.deleteFeature(featureId)).toBe(false);
    expect(db.getFeature(featureId)).not.toBeNull();

    // Release lock, then delete should succeed and cascade history + locks
    db.unlockFeature(featureId);
    expect(db.deleteFeature(featureId)).toBe(true);
    expect(db.getFeature(featureId)).toBeNull();
    expect(db.getFeatureHistory(featureId)).toEqual([]);
  });

  // --- findFeatureBySlug, findProjectByRepoPath, findFeatureById ---

  test("deleteFeature cleans up orphaned tags", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "TagTest", repoPath: "/tags" });
    const featureId = db.createFeature({ projectId, slug: "tagged-f", title: "Tagged", lane: "backlog" });

    // Manually insert tags and feature_tags (no helper methods yet)
    db.rawExec("INSERT INTO tags (name, color) VALUES ('bug', '#ff0000')", EMPTY_PARAMS);
    db.rawExec("INSERT INTO tags (name, color) VALUES ('enhancement', '#00ff00')", EMPTY_PARAMS);
    db.rawExec("INSERT INTO tags (name, color) VALUES ('shared', '#0000ff')", EMPTY_PARAMS);
    // Get tag IDs
    const tags = db.rawExec("SELECT id, name FROM tags ORDER BY name", EMPTY_PARAMS);
    const tagMap = Object.fromEntries(tags.map((row: Record<string, unknown>) => [row.name, row.id]));

    // Assign all 3 tags to the feature
    db.rawExec(`INSERT INTO feature_tags (feature_id, tag_id) VALUES (${featureId}, ${tagMap.bug})`, EMPTY_PARAMS);
    db.rawExec(
      `INSERT INTO feature_tags (feature_id, tag_id) VALUES (${featureId}, ${tagMap.enhancement})`,
      EMPTY_PARAMS,
    );
    db.rawExec(`INSERT INTO feature_tags (feature_id, tag_id) VALUES (${featureId}, ${tagMap.shared})`, EMPTY_PARAMS);

    // Also assign 'shared' tag to another feature (should NOT be orphaned after delete)
    const otherId = db.createFeature({ projectId, slug: "other-f", title: "Other", lane: "backlog" });
    db.rawExec(`INSERT INTO feature_tags (feature_id, tag_id) VALUES (${otherId}, ${tagMap.shared})`, EMPTY_PARAMS);

    // Delete the feature — 'bug' and 'enhancement' should be orphaned and cleaned up
    expect(db.deleteFeature(featureId)).toBe(true);

    // 'bug' and 'enhancement' should be removed (orphaned), 'shared' should remain
    const remainingTags = db.rawExec("SELECT name FROM tags ORDER BY name", EMPTY_PARAMS);
    const remainingNames = remainingTags.map((row: Record<string, unknown>) => row.name as string);
    expect(remainingNames).toEqual(["shared"]);
  });

  test("deleteFeature wraps tag cleanup and deletion in transaction", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "TxTest", repoPath: "/tx" });
    const featureId = db.createFeature({ projectId, slug: "tx-f", title: "TX", lane: "backlog" });

    // Add a tag to the feature
    db.rawExec("INSERT INTO tags (name, color) VALUES ('orphan', '#ccc')", EMPTY_PARAMS);
    const tags = db.rawExec("SELECT id FROM tags WHERE name = 'orphan'", EMPTY_PARAMS);
    const tagId = tags[0].id as number;
    db.rawExec(`INSERT INTO feature_tags (feature_id, tag_id) VALUES (${featureId}, ${tagId})`, EMPTY_PARAMS);

    // Verify feature exists before delete
    expect(db.getFeature(featureId)).not.toBeNull();

    // deleteFeature should run atomically (tag cleanup + feature deletion in one transaction)
    expect(db.deleteFeature(featureId)).toBe(true);

    // Both feature and its orphaned tag should be gone
    expect(db.getFeature(featureId)).toBeNull();
    const remainingTags = db.rawExec("SELECT name FROM tags WHERE name = 'orphan'", EMPTY_PARAMS);
    expect(remainingTags).toHaveLength(0);
  });

  test("findProjectByRepoPath returns matching project", async () => {
    const db = await createDb();
    const id = db.createProject({ name: "my-project", repoPath: "/home/user/my-project" });
    const found = db.findProjectByRepoPath("/home/user/my-project");
    expect(found).not.toBeNull();
    expect(found?.id).toBe(id);
    expect(found?.name).toBe("my-project");
  });

  test("findProjectByRepoPath returns null when no match", async () => {
    const db = await createDb();
    db.createProject({ name: "my-project", repoPath: "/home/user/my-project" });
    expect(db.findProjectByRepoPath("/nonexistent")).toBeNull();
  });

  test("findFeatureBySlug returns matching feature", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "my-feature", title: "My Feature", lane: "backlog" });
    const found = db.findFeatureBySlug("my-feature", undefined);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(featureId);
  });

  test("findFeatureBySlug scoped by projectId ignores other projects", async () => {
    const db = await createDb();
    const p1 = db.createProject({ name: "proj1", repoPath: "/proj1" });
    const p2 = db.createProject({ name: "proj2", repoPath: "/proj2" });
    db.createFeature({ projectId: p1, slug: "shared-slug", title: "Feature 1", lane: "backlog" });
    db.createFeature({ projectId: p2, slug: "shared-slug", title: "Feature 2", lane: "backlog" });

    // Without projectId: returns first match
    const unscoped = db.findFeatureBySlug("shared-slug", undefined);
    expect(unscoped).not.toBeNull();

    // With p1: returns p1's feature
    const scoped1 = db.findFeatureBySlug("shared-slug", p1);
    expect(scoped1).not.toBeNull();
    expect(scoped1?.project_id).toBe(p1);

    // With p2: returns p2's feature
    const scoped2 = db.findFeatureBySlug("shared-slug", p2);
    expect(scoped2).not.toBeNull();
    expect(scoped2?.project_id).toBe(p2);
  });

  test("findFeatureBySlug returns null when no match", async () => {
    const db = await createDb();
    expect(db.findFeatureBySlug("nonexistent", undefined)).toBeNull();
  });

  test("findFeatureById returns matching feature", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "feat", title: "Feat", lane: "backlog" });
    const found = db.findFeatureById(featureId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(featureId);
    expect(found?.slug).toBe("feat");
  });

  test("findFeatureById returns null for non-existent id", async () => {
    const db = await createDb();
    expect(db.findFeatureById(99999)).toBeNull();
  });
});

describe("feature_dependencies CRUD", () => {
  test("addDependency creates a dependency between two features", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureA = db.createFeature({ projectId, slug: "feat-a", title: "A", lane: "backlog" });
    const featureB = db.createFeature({ projectId, slug: "feat-b", title: "B", lane: "backlog" });

    db.addDependency({ featureId: featureA, dependsOnId: featureB, kind: "blocks" });

    const deps = db.listDependencies(featureA);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({ featureId: featureA, dependsOnId: featureB, kind: "blocks" });
  });

  test("listDependencies returns empty array when no dependencies", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "feat", title: "F", lane: "backlog" });

    expect(db.listDependencies(featureId)).toEqual([]);
  });

  test("removeDependency deletes a specific dependency", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureA = db.createFeature({ projectId, slug: "feat-a", title: "A", lane: "backlog" });
    const featureB = db.createFeature({ projectId, slug: "feat-b", title: "B", lane: "backlog" });

    db.addDependency({ featureId: featureA, dependsOnId: featureB, kind: "requires" });
    db.removeDependency(featureA, featureB);

    expect(db.listDependencies(featureA)).toEqual([]);
  });

  test("listDependents returns features that depend on a given feature", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureA = db.createFeature({ projectId, slug: "feat-a", title: "A", lane: "backlog" });
    const featureB = db.createFeature({ projectId, slug: "feat-b", title: "B", lane: "backlog" });
    const featureC = db.createFeature({ projectId, slug: "feat-c", title: "C", lane: "backlog" });

    db.addDependency({ featureId: featureB, dependsOnId: featureA, kind: "requires" });
    db.addDependency({ featureId: featureC, dependsOnId: featureA, kind: "blocks" });

    const dependents = db.listDependents(featureA);
    expect(dependents).toHaveLength(2);
    expect(dependents.map((d) => d.featureId).sort()).toEqual([featureB, featureC]);
  });

  test("dependencies cascade on feature delete", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureA = db.createFeature({ projectId, slug: "feat-a", title: "A", lane: "backlog" });
    const featureB = db.createFeature({ projectId, slug: "feat-b", title: "B", lane: "backlog" });

    db.addDependency({ featureId: featureA, dependsOnId: featureB, kind: "related" });
    expect(db.deleteFeature(featureB)).toBe(true);

    // Dependency should be cascade-deleted
    expect(db.listDependencies(featureA)).toEqual([]);
  });

  test("addDependency rejects self-referencing dependency", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "feat", title: "F", lane: "backlog" });

    expect(() => db.addDependency({ featureId, dependsOnId: featureId, kind: "blocks" })).toThrow();
  });
});

describe("tags and feature_tags CRUD", () => {
  test("createTag creates a tag with name and optional color", async () => {
    const db = await createDb();
    const tagId = db.createTag({ name: "bug", color: "#ff0000" });

    const tags = db.listTags();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ id: tagId, name: "bug", color: "#ff0000" });
  });

  test("createTag works without color", async () => {
    const db = await createDb();
    const tagId = db.createTag({ name: "enhancement" });

    const tags = db.listTags();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ id: tagId, name: "enhancement", color: null });
  });

  test("createTag rejects duplicate name", async () => {
    const db = await createDb();
    db.createTag({ name: "bug" });
    expect(() => db.createTag({ name: "bug" })).toThrow();
  });

  test("removeTag deletes a tag and unlinks from all features", async () => {
    const db = await createDb();
    const tagId = db.createTag({ name: "bug" });
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "feat", title: "F", lane: "backlog" });

    db.addFeatureTag(featureId, tagId);
    db.removeTag(tagId);

    expect(db.listTags()).toHaveLength(0);
    expect(db.listFeatureTags(featureId)).toEqual([]);
  });

  test("addFeatureTag links a tag to a feature", async () => {
    const db = await createDb();
    const tagId = db.createTag({ name: "urgent" });
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "feat", title: "F", lane: "backlog" });

    db.addFeatureTag(featureId, tagId);

    const featureTags = db.listFeatureTags(featureId);
    expect(featureTags).toHaveLength(1);
    expect(featureTags[0]).toEqual({ id: tagId, name: "urgent", color: null });
  });

  test("removeFeatureTag unlinks a tag from a feature", async () => {
    const db = await createDb();
    const tagId = db.createTag({ name: "docs" });
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "feat", title: "F", lane: "backlog" });

    db.addFeatureTag(featureId, tagId);
    db.removeFeatureTag(featureId, tagId);

    expect(db.listFeatureTags(featureId)).toEqual([]);
  });

  test("listFeatureTags returns empty array when no tags assigned", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "feat", title: "F", lane: "backlog" });

    expect(db.listFeatureTags(featureId)).toEqual([]);
  });

  test("feature_tags cascade on feature delete", async () => {
    const db = await createDb();
    const tagId = db.createTag({ name: "cleanup" });
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureA = db.createFeature({ projectId, slug: "feat-a", title: "A", lane: "backlog" });
    const featureB = db.createFeature({ projectId, slug: "feat-b", title: "B", lane: "backlog" });

    // Both features share the same tag
    db.addFeatureTag(featureA, tagId);
    db.addFeatureTag(featureB, tagId);

    // Delete one feature — tag should survive because featureB still references it
    expect(db.deleteFeature(featureA)).toBe(true);
    expect(db.listTags()).toHaveLength(1);

    // Delete the other feature — tag should be orphaned and cleaned up
    expect(db.deleteFeature(featureB)).toBe(true);
    expect(db.listTags()).toHaveLength(0);
  });

  test("feature can have multiple tags", async () => {
    const db = await createDb();
    const tagA = db.createTag({ name: "bug", color: "#ff0000" });
    const tagB = db.createTag({ name: "urgent", color: "#ff8800" });
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "feat", title: "F", lane: "backlog" });

    db.addFeatureTag(featureId, tagA);
    db.addFeatureTag(featureId, tagB);

    const tags = db.listFeatureTags(featureId);
    expect(tags).toHaveLength(2);
    expect(tags.map((t) => t.name).sort()).toEqual(["bug", "urgent"]);
  });
});

describe("listAllFeatures", () => {
  test("returns all features for a project ordered by lane then priority", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });

    db.createFeature({ projectId, slug: "feat-low", title: "Low", lane: "backlog", priority: 1 });
    db.createFeature({ projectId, slug: "feat-high", title: "High", lane: "backlog", priority: 10 });
    db.createFeature({ projectId, slug: "feat-ready", title: "Ready", lane: "ready", priority: 5 });

    const all = db.listAllFeatures(projectId, undefined);
    expect(all).toHaveLength(3);
    // backlog comes before ready in lane order, high priority first within backlog
    expect(all[0].slug).toBe("feat-high");
    expect(all[1].slug).toBe("feat-low");
    expect(all[2].slug).toBe("feat-ready");
  });

  test("returns empty array for project with no features", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "empty", repoPath: "/empty" });
    expect(db.listAllFeatures(projectId, undefined)).toEqual([]);
  });

  test("does not return features from other projects", async () => {
    const db = await createDb();
    const projA = db.createProject({ name: "projA", repoPath: "/a" });
    const projB = db.createProject({ name: "projB", repoPath: "/b" });

    db.createFeature({ projectId: projA, slug: "a1", title: "A1", lane: "backlog" });
    db.createFeature({ projectId: projB, slug: "b1", title: "B1", lane: "backlog" });

    const resultA = db.listAllFeatures(projA, undefined);
    expect(resultA).toHaveLength(1);
    expect(resultA[0].slug).toBe("a1");
  });

  test("includes lock info from feature_locks join", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });
    const featureId = db.createFeature({ projectId, slug: "locked", title: "Locked", lane: "in-progress" });

    db.lockFeature(featureId, "session-1");

    const all = db.listAllFeatures(projectId, undefined);
    expect(all).toHaveLength(1);
    expect(all[0].locked_at).not.toBeNull();
    expect(all[0].last_heartbeat).not.toBeNull();
  });

  test("findNullSlugFeatures returns only features with null slug", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "proj", repoPath: "/proj" });

    // Create features with null slug (empty string → null) and with slug
    db.createFeature({ projectId, slug: "", title: "No Slug", lane: "backlog" });
    db.createFeature({ projectId, slug: "", title: "Also No Slug", lane: "design" });
    db.createFeature({ projectId, slug: "has-slug", title: "Has Slug", lane: "backlog" });

    const nulls = db.findNullSlugFeatures(projectId);
    expect(nulls).toHaveLength(2);
    expect(nulls.map((f) => f.title).sort()).toEqual(["Also No Slug", "No Slug"]);
  });

  test("findNullSlugFeatures excludes features from other projects", async () => {
    const db = await createDb();
    const projA = db.createProject({ name: "projA", repoPath: "/a" });
    const projB = db.createProject({ name: "projB", repoPath: "/b" });

    db.createFeature({ projectId: projA, slug: "", title: "A null", lane: "backlog" });
    db.createFeature({ projectId: projB, slug: "", title: "B null", lane: "backlog" });

    expect(db.findNullSlugFeatures(projA)).toHaveLength(1);
    expect(db.findNullSlugFeatures(projA)[0].title).toBe("A null");
  });
});

describe("findAvailableFeatures with projectId=undefined", () => {
  test("returns unlocked features across all projects", async () => {
    const db = await createDb();
    const projA = db.createProject({ name: "projA", repoPath: "/a" });
    const projB = db.createProject({ name: "projB", repoPath: "/b" });

    db.createFeature({ projectId: projA, slug: "feat-a", title: "Feature A", lane: "ready", priority: 10 });
    db.createFeature({ projectId: projB, slug: "feat-b", title: "Feature B", lane: "ready", priority: 5 });

    const results = db.findAvailableFeatures(undefined, ["ready"]);
    expect(results).toHaveLength(2);
    // Ordered by priority DESC
    expect(results[0].title).toBe("Feature A");
    expect(results[1].title).toBe("Feature B");
  });

  test("excludes locked features from any project", async () => {
    const db = await createDb();
    const projA = db.createProject({ name: "projA", repoPath: "/a" });
    const projB = db.createProject({ name: "projB", repoPath: "/b" });

    const featA = db.createFeature({ projectId: projA, slug: "feat-a", title: "Feature A", lane: "ready" });
    db.createFeature({ projectId: projB, slug: "feat-b", title: "Feature B", lane: "ready" });

    // Lock feature A
    db.lockFeature(featA, "session-1");

    const results = db.findAvailableFeatures(undefined, ["ready"]);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Feature B");
  });

  test("returns empty array when lanes don't match", async () => {
    const db = await createDb();
    const projA = db.createProject({ name: "projA", repoPath: "/a" });
    db.createFeature({ projectId: projA, slug: "feat-a", title: "Feature A", lane: "backlog" });

    const results = db.findAvailableFeatures(undefined, ["ready"]);
    expect(results).toHaveLength(0);
  });

  describe("feature metadata columns (plan_doc, state_file, assigned_session)", () => {
    test("createFeature stores plan_doc, state_file, assigned_session", async () => {
      const db = await createDb();
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "feat-with-meta",
        title: "Feature With Metadata",
        planDoc: "docs/plans/2026-05-17-feature.md",
        stateFile: ".pi/featyard-state-feat-with-meta.json",
        assignedSession: "session-abc",
      });
      const feature = db.getFeature(featureId);
      expect(feature).not.toBeNull();
      expect(feature?.plan_doc).toBe("docs/plans/2026-05-17-feature.md");
      expect(feature?.state_file).toBe(".pi/featyard-state-feat-with-meta.json");
      expect(feature?.assigned_session).toBe("session-abc");
    });

    test("updateFeature can set plan_doc, state_file, assigned_session", async () => {
      const db = await createDb();
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      const featureId = db.createFeature({ projectId, slug: "feat-meta", title: "Meta Feature" });
      db.updateFeature({
        featureId,
        planDoc: "docs/plans/plan.md",
        stateFile: ".pi/state.json",
        assignedSession: "session-xyz",
      });
      const feature = db.getFeature(featureId);
      expect(feature?.plan_doc).toBe("docs/plans/plan.md");
      expect(feature?.state_file).toBe(".pi/state.json");
      expect(feature?.assigned_session).toBe("session-xyz");
    });

    test("updateFeature can clear assigned_session", async () => {
      const db = await createDb();
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "feat-clear",
        title: "Clear Session",
        assignedSession: "session-old",
      });
      db.updateFeature({ featureId, assignedSession: null });
      const feature = db.getFeature(featureId);
      expect(feature?.assigned_session).toBeNull();
    });

    test("idx_features_assigned index allows lookup by assigned_session", async () => {
      const db = await createDb();
      const projectId = db.createProject({ name: "test", repoPath: "/test" });
      db.createFeature({
        projectId,
        slug: "feat-1",
        title: "F1",
        assignedSession: "session-lookup",
      });
      db.createFeature({
        projectId,
        slug: "feat-2",
        title: "F2",
        assignedSession: "session-other",
      });
      const results = db.findFeaturesBySession("session-lookup");
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("feat-1");
    });
  });

  describe("repo_path normalization", () => {
    test("createProject normalizes backslashes to forward slashes", async () => {
      const db = await createDb();
      const id = db.createProject({ name: "Windows", repoPath: "C:\\Users\\ADMIN\\project" });
      const project = db.listProjects().find((p) => p.id === id);
      expect(project?.repo_path).toBe("c:/users/admin/project");
    });

    test("findProjectByRepoPath normalizes before lookup", async () => {
      const db = await createDb();
      db.createProject({ name: "Test", repoPath: "/home/user/project" });
      const found = db.findProjectByRepoPath("/home/user/project/");
      expect(found).not.toBeNull();
      expect(found?.name).toBe("Test");
    });

    test("trailing slash stripped on create and lookup", async () => {
      const db = await createDb();
      db.createProject({ name: "Trailing", repoPath: "/home/user/project/" });
      const found = db.findProjectByRepoPath("/home/user/project");
      expect(found).not.toBeNull();
      expect(found?.name).toBe("Trailing");
    });
  });

  describe("edge cases (R15)", () => {
    test("moveFeature throws for non-existent feature ID", async () => {
      const db = await createDb();
      expect(() => db.moveFeature({ featureId: 99999, toLane: "ready", changedBy: "user" })).toThrow(
        "Feature 99999 not found",
      );
    });

    test("createProject rejects duplicate repo_path", async () => {
      const db = await createDb();
      db.createProject({ name: "Project A", repoPath: "/home/user/project" });
      expect(() => db.createProject({ name: "Project B", repoPath: "/home/user/project" })).toThrow();
    });

    test("getProject returns null for non-existent ID", async () => {
      const db = await createDb();
      expect(db.getProject(99999)).toBeNull();
    });

    test("listFeatures returns empty array for lane with no features", async () => {
      const db = await createDb();
      const projectId = db.createProject({ name: "Empty Lane", repoPath: "/test" });
      db.createFeature({ projectId, slug: "test-feature", title: "In backlog", lane: "backlog" });
      const ready = db.listFeatures(projectId, "ready", undefined);
      expect(ready).toEqual([]);
    });
  });
});

describe("getLanePriorityBounds", () => {
  test("returns null min/max for empty lane", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const bounds = db.getLanePriorityBounds(projectId, "backlog");
    expect(bounds).toEqual({ min: null, max: null });
  });

  test("returns min and max priority for lane", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 10 });
    db.createFeature({ projectId, slug: "c", title: "C", lane: "backlog", priority: 50 });
    const bounds = db.getLanePriorityBounds(projectId, "backlog");
    expect(bounds).toEqual({ min: 10, max: 50 });
  });

  test("ignores features from other lanes", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "ready", priority: 100 });
    const bounds = db.getLanePriorityBounds(projectId, "backlog");
    expect(bounds).toEqual({ min: 30, max: 30 });
  });

  test("ignores features from other projects", async () => {
    const db = await createDb();
    const projectId1 = db.createProject({ name: "P1", repoPath: "/p1" });
    const projectId2 = db.createProject({ name: "P2", repoPath: "/p2" });
    db.createFeature({ projectId: projectId1, slug: "a", title: "A", lane: "backlog", priority: 30 });
    db.createFeature({ projectId: projectId2, slug: "b", title: "B", lane: "backlog", priority: 100 });
    const bounds = db.getLanePriorityBounds(projectId1, "backlog");
    expect(bounds).toEqual({ min: 30, max: 30 });
  });
});

describe("getFeaturesByIds", () => {
  test("returns empty array for empty input", async () => {
    const db = await createDb();
    expect(db.getFeaturesByIds([])).toEqual([]);
  });

  test("returns matching feature for single ID", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog" });
    const features = db.getFeaturesByIds([id]);
    expect(features).toHaveLength(1);
    expect(features[0].id).toBe(id);
    expect(features[0].title).toBe("A");
  });

  test("returns multiple features for multiple IDs", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog" });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "ready" });
    const id3 = db.createFeature({ projectId, slug: "c", title: "C", lane: "done" });
    const features = db.getFeaturesByIds([id1, id2, id3]);
    expect(features).toHaveLength(3);
    const titles = features.map((f) => f.title).sort();
    expect(titles).toEqual(["A", "B", "C"]);
  });

  test("returns empty for non-existent IDs", async () => {
    const db = await createDb();
    expect(db.getFeaturesByIds([99999, 99998])).toEqual([]);
  });

  test("returns single feature for duplicate IDs", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog" });
    const features = db.getFeaturesByIds([id, id, id]);
    // SQL IN with duplicate values returns one row per match
    expect(features).toHaveLength(1);
    expect(features[0].id).toBe(id);
  });
});

describe("fifoPriority", () => {
  test("returns 0 for empty lane (null bounds)", async () => {
    expect(fifoPriority({ min: null, max: null })).toBe(0);
  });

  test("returns min - 10 for positive priorities", async () => {
    expect(fifoPriority({ min: 50, max: 100 })).toBe(40);
  });

  test("returns min - 10 for negative priorities", async () => {
    expect(fifoPriority({ min: -20, max: 0 })).toBe(-30);
  });

  test("returns min - 10 when min equals max (single card)", async () => {
    expect(fifoPriority({ min: 30, max: 30 })).toBe(20);
  });
});

describe("topPriority", () => {
  test("returns PRIORITY_SPACING (10) for empty lane (null bounds)", async () => {
    expect(topPriority({ min: null, max: null })).toBe(10);
  });

  test("returns max + 10 for positive priorities", async () => {
    expect(topPriority({ min: 50, max: 100 })).toBe(110);
  });

  test("returns max + 10 for negative priorities", async () => {
    expect(topPriority({ min: -30, max: -10 })).toBe(0);
  });

  test("returns max + 10 when min equals max (single card)", async () => {
    expect(topPriority({ min: 30, max: 30 })).toBe(40);
  });
});

describe("KanbanDatabase assignFifoPriority", () => {
  test("assigns 0 on empty lane", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    // Create in a different lane so backlog is empty
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "ready" });
    db.moveFeature({ featureId: id, toLane: "backlog", changedBy: "test" });
    const _bounds = db.getLanePriorityBounds(projectId, "backlog");
    // The moved card is now in backlog with its old priority, so use precomputed empty bounds
    const priority = db.assignFifoPriority(id, projectId, "backlog", { min: null, max: null });
    expect(priority).toBe(0);
    expect(db.getFeature(id)?.priority).toBe(0);
  });

  test("assigns min - 10 with existing cards", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 30 });
    // Create the target feature in backlog — bounds will include it at priority 0
    // Use precomputedBounds to simulate the real server flow (bounds before card enters lane)
    const id = db.createFeature({ projectId, slug: "c", title: "C", lane: "ready" });
    const boundsBefore = db.getLanePriorityBounds(projectId, "backlog");
    db.moveFeature({ featureId: id, toLane: "backlog", changedBy: "test" });
    const priority = db.assignFifoPriority(id, projectId, "backlog", boundsBefore);
    expect(priority).toBe(20);
    expect(db.getFeature(id)?.priority).toBe(20);
  });

  test("accepts precomputedBounds", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog" });
    const priority = db.assignFifoPriority(id, projectId, "backlog", { min: 100, max: 200 });
    expect(priority).toBe(90);
    expect(db.getFeature(id)?.priority).toBe(90);
  });

  test("computes bounds internally when precomputedBounds omitted", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 30 });
    // Feature already in the lane — no precomputedBounds, so it computes bounds including itself
    const id = db.createFeature({ projectId, slug: "c", title: "C", lane: "backlog" });
    const priority = db.assignFifoPriority(id, projectId, "backlog", undefined);
    // Bounds: min=0 (card C), max=50 (card A). FIFO = min - 10 = -10
    expect(priority).toBe(-10);
    expect(db.getFeature(id)?.priority).toBe(-10);
  });
});

describe("KanbanDatabase assignTopPriority", () => {
  test("assigns 10 on empty lane", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    // Create in a different lane so backlog is empty
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "ready" });
    db.moveFeature({ featureId: id, toLane: "backlog", changedBy: "test" });
    // Use precomputed empty bounds
    const priority = db.assignTopPriority(id, projectId, "backlog", { min: null, max: null });
    expect(priority).toBe(10);
    expect(db.getFeature(id)?.priority).toBe(10);
  });

  test("assigns max + 10 with existing cards", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 30 });
    // Use precomputedBounds to simulate the real server flow
    const id = db.createFeature({ projectId, slug: "c", title: "C", lane: "ready" });
    const boundsBefore = db.getLanePriorityBounds(projectId, "backlog");
    db.moveFeature({ featureId: id, toLane: "backlog", changedBy: "test" });
    const priority = db.assignTopPriority(id, projectId, "backlog", boundsBefore);
    expect(priority).toBe(60);
    expect(db.getFeature(id)?.priority).toBe(60);
  });

  test("accepts precomputedBounds", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog" });
    const priority = db.assignTopPriority(id, projectId, "backlog", { min: 10, max: 100 });
    expect(priority).toBe(110);
    expect(db.getFeature(id)?.priority).toBe(110);
  });

  test("computes bounds internally when precomputedBounds omitted", async () => {
    const db = await createDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 30 });
    // Feature already in the lane — no precomputedBounds, so it computes bounds including itself
    const id = db.createFeature({ projectId, slug: "c", title: "C", lane: "backlog" });
    const priority = db.assignTopPriority(id, projectId, "backlog", undefined);
    // Bounds: min=0 (card C), max=50 (card A). Top = max + 10 = 60
    expect(priority).toBe(60);
    expect(db.getFeature(id)?.priority).toBe(60);
  });
});

test("updateFeature updates design_doc", async () => {
  const db = await createDb();
  const projectId = db.createProject({ name: "test", repoPath: "/test" });
  const featureId = db.createFeature({
    projectId,
    slug: "test-feature",
    title: "Test Feature",
  });

  db.updateFeature({
    featureId,
    designDoc: "docs/featyard/designs/test-feature-design.md",
  });

  const feature = db.getFeature(featureId);
  expect(feature).not.toBeNull();
  expect(feature?.design_doc).toBe("docs/featyard/designs/test-feature-design.md");
});

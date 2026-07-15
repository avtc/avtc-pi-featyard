// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import { ensureKanbanFeature } from "../../src/kanban/ensure-feature.js";
import { createFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

async function createTestDb() {
  return KanbanDatabase.createInMemory();
}

describe("ensureKanbanFeature", () => {
  const cleanup: KanbanDatabase[] = [];

  afterEach(() => {
    for (const db of cleanup) db.close();
    cleanup.length = 0;
  });

  it("creates kanban feature in backlog and sets featureId", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    // Set up project matching cwd
    const cwd = withTempCwd();
    const _projectId = db.createProject({ name: "Test", repoPath: cwd });

    const state = createFeatureState(
      "2026-05-16-new-feature",
      "docs/featyard/designs/2026-05-16-new-feature-design.md",
    );
    saveFeatureState(state, null);

    await ensureKanbanFeature(db, state, null, null, "design");
    expect(state.featureId).not.toBeNull();
    expect(typeof state.featureId).toBe("number");

    // Verify feature created in design lane (has design artifact from createFeatureState)
    const feature = db.findFeatureById(state.featureId as NonNullable<typeof state.featureId>);
    expect(feature).not.toBeNull();
    expect(feature?.slug).toBe("2026-05-16-new-feature");
    expect(feature?.lane).toBe("design");
  });

  it("auto-creates project if none exists for cwd", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    const cwd = withTempCwd();
    // No project created — should auto-create

    const state = createFeatureState(
      "2026-05-16-auto-project",
      "docs/featyard/designs/2026-05-16-auto-project-design.md",
    );
    saveFeatureState(state, null);

    await ensureKanbanFeature(db, state, null, null, "design");
    expect(state.featureId).not.toBeNull();

    // Verify project was auto-created
    const project = db.findProjectByRepoPath(cwd);
    expect(project).not.toBeNull();
    expect(project?.name).toBe(path.basename(cwd));
  });

  it("no-ops when state already has featureId", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    withTempCwd();
    const state = createFeatureState(
      "2026-05-16-already-has",
      "docs/featyard/designs/2026-05-16-already-has-design.md",
    );
    state.featureId = 42;
    saveFeatureState(state, null);

    await ensureKanbanFeature(db, state, null, null, "design");
    expect(state.featureId).toBe(42); // unchanged
  });

  it("uses resolvedCwd for project lookup instead of process.cwd", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    // Simulate worktree: cwd is worktree path, project registered with main repo path
    const mainRepoPath = path.join(os.tmpdir(), `main-repo-${Date.now()}`);
    const worktreePath = withTempCwd(); // cwd is now the worktree
    db.createProject({ name: "MainRepo", repoPath: mainRepoPath });

    const state = createFeatureState(
      "2026-05-16-worktree-feature",
      "docs/featyard/designs/2026-05-16-worktree-feature-design.md",
    );
    saveFeatureState(state, null);

    // Without resolvedCwd, would create a new project for worktreePath
    await ensureKanbanFeature(db, state, mainRepoPath, null, "design");
    expect(state.featureId).not.toBeNull();

    // Should have used the existing project, not created a duplicate
    const worktreeProject = db.findProjectByRepoPath(worktreePath);
    expect(worktreeProject).toBeNull(); // no duplicate project for worktree

    const mainProject = db.findProjectByRepoPath(mainRepoPath);
    expect(mainProject).not.toBeNull();
    expect(mainProject?.name).toBe("MainRepo");
  });

  it("no-ops when kanban feature already exists by slug", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    const cwd = withTempCwd();
    const projectId = db.createProject({ name: "Test", repoPath: cwd });
    const existingId = db.createFeature({
      projectId,
      slug: "2026-05-16-existing",
      title: "Existing Feature",
      lane: "ready",
    });

    const state = createFeatureState("2026-05-16-existing", "docs/featyard/designs/2026-05-16-existing-design.md");
    saveFeatureState(state, null);

    await ensureKanbanFeature(db, state, null, null, "design");
    expect(state.featureId).toBe(existingId);

    // Should NOT have created a duplicate
    const features = db.listAllFeatures(projectId, undefined);
    expect(features.length).toBe(1);
  });

  it("populates state_file column on created feature", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    const cwd = withTempCwd();
    db.createProject({ name: "Test", repoPath: cwd });

    const state = createFeatureState("2026-05-16-state-file", "docs/featyard/designs/2026-05-16-state-file-design.md");
    saveFeatureState(state, null);

    await ensureKanbanFeature(db, state, null, null, "design");
    expect(state.featureId).not.toBeNull();

    const feature = db.findFeatureById(state.featureId as NonNullable<typeof state.featureId>);
    expect(feature).not.toBeNull();
    expect(feature?.state_file).not.toBeNull();
    expect(feature?.state_file).toContain("2026-05-16-state-file.json");
  });

  it("mutates the input state in place (sets featureId)", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    const cwd = withTempCwd();
    db.createProject({ name: "Test", repoPath: cwd });

    const state = createFeatureState("2026-05-16-mutate", "docs/featyard/designs/2026-05-16-mutate-design.md");
    saveFeatureState(state, null);

    // ensureKanbanFeature mutates state in place and returns nothing.
    await ensureKanbanFeature(db, state, null, null, "design");
    expect(state.featureId).not.toBeNull();
  });

  it("creates feature in design lane when design artifact exists", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    const cwd = withTempCwd();
    db.createProject({ name: "Test", repoPath: cwd });

    const state = createFeatureState("2026-05-24-test-feature", "/path/to/design.md");
    saveFeatureState(state, null);

    await ensureKanbanFeature(db, state, cwd, "session:test-feature", "design");

    expect(state.featureId).not.toBeNull();
    const feature = db.findFeatureById(state.featureId as NonNullable<typeof state.featureId>);
    expect(feature?.lane).toBe("design");
    expect(feature?.locked_at).not.toBeNull();
    expect(feature?.locked_by_session).toBe("session:test-feature");
    expect(feature?.assigned_session).toBe("session:test-feature");
  });

  it("creates feature in backlog lane when no design artifact", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    const cwd = withTempCwd();
    db.createProject({ name: "Test", repoPath: cwd });

    // Construct a state without design by creating one and clearing the doc
    const state = createFeatureState("2026-05-24-no-design", "/path/to/design.md");
    state.design.doc = null;
    saveFeatureState(state, null);

    // No design artifact → the feature stays in backlog (targetLane='backlog';
    // lane derivation from design.doc was removed — the caller picks the lane).
    await ensureKanbanFeature(db, state, cwd, "session:no-design", "backlog");

    expect(state.featureId).not.toBeNull();
    const feature = db.findFeatureById(state.featureId as NonNullable<typeof state.featureId>);
    expect(feature?.lane).toBe("backlog");
    // Lock IS applied when sessionId is provided, even in backlog
    expect(feature?.locked_at).not.toBeNull();
    expect(feature?.locked_by_session).toBe("session:no-design");
  });

  it("moves existing backlog feature to design when design artifact exists", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    const cwd = withTempCwd();
    const projectId = db.createProject({ name: "Test", repoPath: cwd });

    // Pre-create feature in backlog
    const featureId = db.createFeature({
      projectId,
      slug: "2026-05-24-move-feature",
      title: "Move Feature",
      description: "Test",
      lane: "backlog",
    });

    const state = createFeatureState("2026-05-24-move-feature", "/path/to/design.md");
    state.featureId = null;
    saveFeatureState(state, null);

    await ensureKanbanFeature(db, state, cwd, "session:move-feature", "design");

    expect(state.featureId).toBe(featureId);
    const feature = db.findFeatureById(featureId);
    expect(feature?.lane).toBe("design");
    expect(feature?.locked_at).not.toBeNull();
    expect(feature?.locked_by_session).toBe("session:move-feature");
  });

  it("locks existing feature already in design lane without moving", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    const cwd = withTempCwd();
    const projectId = db.createProject({ name: "Test", repoPath: cwd });

    // Pre-create feature already in design lane (e.g. from a previous design-doc write)
    const featureId = db.createFeature({
      projectId,
      slug: "2026-05-24-already-design",
      title: "Already Design",
      description: "Test",
      lane: "design",
    });

    const state = createFeatureState("2026-05-24-already-design", "/path/to/design.md");
    state.featureId = null;
    saveFeatureState(state, null);

    await ensureKanbanFeature(db, state, cwd, "session:already-design", "design");

    expect(state.featureId).toBe(featureId);
    const feature = db.findFeatureById(featureId);
    expect(feature?.lane).toBe("design"); // stays in design, no move
    expect(feature?.locked_at).not.toBeNull();
    expect(feature?.locked_by_session).toBe("session:already-design");
    expect(feature?.assigned_session).toBe("session:already-design");
  });

  it("does not lock when sessionId is not provided", async () => {
    const db = await createTestDb();
    cleanup.push(db);

    const cwd = withTempCwd();
    db.createProject({ name: "Test", repoPath: cwd });

    const state = createFeatureState("2026-05-24-no-lock", "/path/to/design.md");
    saveFeatureState(state, null);

    await ensureKanbanFeature(db, state, cwd, null, "design");

    expect(state.featureId).not.toBeNull();
    const feature = db.findFeatureById(state.featureId as NonNullable<typeof state.featureId>);
    expect(feature?.lane).toBe("design");
    expect(feature?.locked_at).toBeNull();
  });
});

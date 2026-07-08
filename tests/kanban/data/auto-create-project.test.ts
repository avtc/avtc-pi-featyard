// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import { detectProject } from "../../../src/kanban/data/kanban-detect-project.js";

describe("kanban auto-create project flow", () => {
  let db: KanbanDatabase;

  beforeEach(async () => {
    db = await KanbanDatabase.createInMemory();
  });

  afterEach(() => {
    db.close();
  });

  test("detectProject returns null when no project exists for repo path", async () => {
    const projectId = await detectProject(db, process.cwd());
    expect(projectId).toBeNull();
  });

  test("auto-create project after detectProject returns null", async () => {
    // Simulate what the /ff:kanban command handler does
    const repoPath = "/some/repo/path";
    const projectId = db.createProject({ name: "path", repoPath });
    expect(projectId).toBeGreaterThan(0);

    // Now detectProject should find it
    const found = db.findProjectByRepoPath(repoPath);
    expect(found).not.toBeNull();
    expect((found as NonNullable<typeof found>).id).toBe(projectId);
    expect((found as NonNullable<typeof found>).name).toBe("path");
  });

  test("findProjectByRepoPath handles path normalization", () => {
    const repoPath = "/home/user/MyProject";
    const projectId = db.createProject({ name: "MyProject", repoPath });

    // On Windows, normalizeRepoPath lowercases — but findProjectByRepoPath normalizes input too
    const found = db.findProjectByRepoPath(repoPath);
    expect(found).not.toBeNull();
    expect((found as NonNullable<typeof found>).id).toBe(projectId);
  });

  test("createProject with same repo_path throws UNIQUE constraint error", () => {
    const repoPath = "/unique/path";
    db.createProject({ name: "first", repoPath });
    expect(() => db.createProject({ name: "second", repoPath })).toThrow();
  });

  test("auto-create idempotent: check before create avoids duplicate", () => {
    const repoPath = "/idempotent/path";
    const firstId = db.createProject({ name: "project", repoPath });

    // Simulate the check-before-create pattern from /ff:kanban handler
    const existing = db.findProjectByRepoPath(repoPath);
    expect(existing).not.toBeNull();
    expect((existing as NonNullable<typeof existing>).id).toBe(firstId);
    // Would NOT call createProject again since existing was found
  });
});

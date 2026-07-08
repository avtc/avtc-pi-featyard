// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, it } from "vitest";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";

describe("KanbanDatabase slug nullable + findFeatureById", () => {
  const instances: KanbanDatabase[] = [];

  afterEach(async () => {
    for (const db of instances) db.close();
    instances.length = 0;
  });

  async function createTestDb() {
    const db = await KanbanDatabase.createInMemory();
    instances.push(db);
    return db;
  }

  it("allows creating a feature with null slug", async () => {
    const db = await createTestDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({
      projectId,
      slug: null as unknown as string,
      title: "Add dark mode",
      description: "Support a dark theme",
    });
    expect(featureId).toBeGreaterThan(0);

    const feature = db.getFeature(featureId);
    expect(feature).not.toBeNull();
    expect((feature as NonNullable<typeof feature>).title).toBe("Add dark mode");
    expect((feature as NonNullable<typeof feature>).slug).toBeNull();
  });

  it("allows creating a feature with empty string slug (treated as null)", async () => {
    const db = await createTestDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({
      projectId,
      slug: "",
      title: "Add light mode",
    });
    const feature = db.getFeature(featureId);
    expect((feature as NonNullable<typeof feature>).slug).toBeNull();
  });

  it("findFeatureById returns feature by integer id", async () => {
    const db = await createTestDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({
      projectId,
      slug: null as unknown as string,
      title: "Find by ID test",
    });

    const feature = db.findFeatureById(featureId);
    expect(feature).not.toBeNull();
    expect((feature as NonNullable<typeof feature>).id).toBe(featureId);
    expect((feature as NonNullable<typeof feature>).title).toBe("Find by ID test");
  });

  it("findFeatureById returns null for non-existent id", async () => {
    const db = await createTestDb();
    const feature = db.findFeatureById(99999);
    expect(feature).toBeNull();
  });

  it("updateFeatureSlug sets slug on a previously null-slug feature", async () => {
    const db = await createTestDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({
      projectId,
      slug: null as unknown as string,
      title: "Slug update test",
    });

    db.updateFeatureSlug(featureId, "2026-05-16-slug-update-test");

    const feature = db.getFeature(featureId);
    expect((feature as NonNullable<typeof feature>).slug).toBe("2026-05-16-slug-update-test");
  });

  it("multiple features in same project can have null slug", async () => {
    const db = await createTestDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: null as unknown as string, title: "Feature A" });
    const id2 = db.createFeature({ projectId, slug: null as unknown as string, title: "Feature B" });
    expect(id1).not.toBe(id2);

    const f1 = db.getFeature(id1);
    const f2 = db.getFeature(id2);
    expect((f1 as NonNullable<typeof f1>).slug).toBeNull();
    expect((f2 as NonNullable<typeof f2>).slug).toBeNull();
  });

  it("unique index still prevents duplicate non-null slugs within same project", async () => {
    const db = await createTestDb();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "my-slug", title: "Feature A" });

    expect(() => {
      db.createFeature({ projectId, slug: "my-slug", title: "Feature B" });
    }).toThrow();
  });

  it("same non-null slug allowed across different projects", async () => {
    const db = await createTestDb();
    const p1 = db.createProject({ name: "Project 1", repoPath: "/p1" });
    const p2 = db.createProject({ name: "Project 2", repoPath: "/p2" });
    const id1 = db.createFeature({ projectId: p1, slug: "shared-slug", title: "Feature A" });
    const id2 = db.createFeature({ projectId: p2, slug: "shared-slug", title: "Feature B" });
    expect(id1).not.toBe(id2);
  });
});

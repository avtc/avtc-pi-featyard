// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { fetchPort, setup } from "../helpers/server-test-helpers.js";

describe("GET /api/board/:projectId/export", () => {
  test("rejects unauthenticated request with 401", async () => {
    const { db, port } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "auth-test", repoPath: "/test" });

    const res = await fetchPort(port, `/api/board/${projectId}/export`, null, null); // no authToken
    expect(res.status).toBe(401);
  });

  test("rejects invalid auth token with 401", async () => {
    const { db, port } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "auth-test2", repoPath: "/test" });

    const res = await fetchPort(port, `/api/board/${projectId}/export`, null, "wrong-token");
    expect(res.status).toBe(401);
  });

  test("returns CSV with headers and features", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
    db.createFeature({ projectId, title: "My Task", slug: "2026-01-01-my-task", lane: "backlog", description: "desc" });

    const res = await fetchPort(port, `/api/board/${projectId}/export`, null, authToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("kanban-test-project-");

    const text = await res.text();
    expect(text).toContain("Title,Description,Lane,Priority,Slug,Created,Updated");
    expect(text).toContain("My Task");
    expect(text).toContain("backlog");
  });

  test("filters by lanes query param", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "test2", repoPath: "/test2" });
    db.createFeature({ projectId, title: "A", slug: "a", lane: "backlog" });
    db.createFeature({ projectId, title: "B", slug: "b", lane: "done" });

    const res = await fetchPort(port, `/api/board/${projectId}/export?lanes=backlog`, null, authToken);
    const text = await res.text();
    expect(text).toContain("A");
    expect(text).not.toContain("B");
  });

  test("silently ignores invalid lane names in lanes param, keeps valid ones", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "mixed-lanes", repoPath: "/test" });
    db.createFeature({ projectId, title: "Backlog Item", slug: "backlog-item", lane: "backlog" });
    db.createFeature({ projectId, title: "Done Item", slug: "done-item", lane: "done" });
    db.createFeature({ projectId, title: "In Progress Item", slug: "in-progress-item", lane: "in-progress" });

    // Mix valid and invalid lane names
    const res = await fetchPort(
      port,
      `/api/board/${projectId}/export?lanes=backlog,nonexistent,done,fake`,
      null,
      authToken,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    // Valid lanes (backlog, done) should be included
    expect(text).toContain("Backlog Item");
    expect(text).toContain("Done Item");
    // Invalid lanes are silently ignored, so in-progress is excluded
    expect(text).not.toContain("In Progress Item");
  });

  test("returns 400 for no valid lanes", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "test3", repoPath: "/test3" });

    const res = await fetchPort(port, `/api/board/${projectId}/export?lanes=invalid`, null, authToken);
    expect(res.status).toBe(400);
  });

  test("returns header-only CSV for empty board", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "empty", repoPath: "/empty" });

    const res = await fetchPort(port, `/api/board/${projectId}/export`, null, authToken);
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Title,Description,Lane,Priority,Slug,Created,Updated");
  });

  test("doneHideAfterMs hides old done features from export", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-export-donehide-test-",
      doneHideAfterMs: 1000,
    });
    const projectId = db.createProject({ name: "donehide", repoPath: "/test" });

    // Create a feature in backlog, then move to done with an old history timestamp
    const oldId = db.createFeature({ projectId, title: "Old Done", slug: "old-done", lane: "backlog" });
    db.moveFeature({ featureId: oldId, toLane: "done", changedBy: "test" });
    // Backdate the history entry to 2 seconds ago (beyond the 1000ms cutoff)
    const oldDate = new Date(Date.now() - 2000).toISOString();
    (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE feature_history SET created_at = ? WHERE feature_id = ? AND to_lane = 'done'")
      .run(oldDate, oldId);

    // Create a recent done feature that should still appear
    const recentId = db.createFeature({ projectId, title: "Recent Done", slug: "recent-done", lane: "backlog" });
    db.moveFeature({ featureId: recentId, toLane: "done", changedBy: "test" });

    // Also create a backlog feature — should always appear
    db.createFeature({ projectId, title: "Backlog Item", slug: "backlog-item", lane: "backlog" });

    const res = await fetchPort(port, `/api/board/${projectId}/export`, null, authToken);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Recent Done");
    expect(text).toContain("Backlog Item");
    expect(text).not.toContain("Old Done");
  });

  test("RFC 4180 quotes fields with commas, newlines, and double quotes", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "special", repoPath: "/special" });
    db.createFeature({
      projectId,
      title: "Has, comma",
      slug: "special",
      lane: "backlog",
      description: 'Line one\nLine two\nHas "quotes" and, commas',
    });

    const res = await fetchPort(port, `/api/board/${projectId}/export`, null, authToken);
    expect(res.status).toBe(200);
    const text = await res.text();
    // Title with comma should be quoted
    expect(text).toContain('"Has, comma"');
    // Description with newlines/quotes/commas should be quoted with escaped double quotes
    expect(text).toContain('"Line one\nLine two\nHas ""quotes"" and, commas"');
  });

  test("returns header-only CSV for non-existent projectId", async () => {
    const { port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });

    const res = await fetchPort(port, "/api/board/99999/export", null, authToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("kanban-unknown-");

    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Title,Description,Lane,Priority,Slug,Created,Updated");
  });

  test("sanitizes special characters in project name for filename", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "My Project/Feature: Test", repoPath: "/test" });
    db.createFeature({ projectId, title: "Task", slug: "task", lane: "backlog" });

    const res = await fetchPort(port, `/api/board/${projectId}/export`, null, authToken);
    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition");
    if (!disposition) throw new Error("missing content-disposition header");
    // Special chars should be replaced with underscores
    // "My Project/Feature: Test" → "My_Project_Feature__Test" (/→_, :→_, space→_)
    expect(disposition).toContain("kanban-My_Project_Feature__Test-");
    // Should NOT contain raw special chars
    expect(disposition).not.toMatch(/filename="kanban-[^\]]*[/:]/);
  });

  test("truncates long project name in filename", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const longName = "A".repeat(200);
    const projectId = db.createProject({ name: longName, repoPath: "/test" });
    db.createFeature({ projectId, title: "Task", slug: "task", lane: "backlog" });

    const res = await fetchPort(port, `/api/board/${projectId}/export`, null, authToken);
    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition");
    if (!disposition) throw new Error("missing content-disposition header");
    // filename should be truncated so total filename is reasonable
    const match = disposition.match(/filename="kanban-([^-]+)-/);
    expect(match).toBeTruthy();
    const namePart = match ? match[1] : "";
    expect(namePart.length).toBeLessThanOrEqual(100);
  });

  test("exports rows in LANE_ORDER regardless of insertion order", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-export-test-" });
    const projectId = db.createProject({ name: "lane-order", repoPath: "/test" });

    // Insert in reverse lane order
    db.createFeature({ projectId, title: "Done Task", slug: "done-task", lane: "done" });
    db.createFeature({ projectId, title: "In Progress Task", slug: "in-progress-task", lane: "in-progress" });
    db.createFeature({ projectId, title: "Backlog Task", slug: "backlog-task", lane: "backlog" });

    const res = await fetchPort(port, `/api/board/${projectId}/export`, null, authToken);
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.trim().split("\n");
    // Header + 3 data rows
    expect(lines).toHaveLength(4);

    // Data rows should follow LANE_ORDER: backlog, then in-progress, then done
    expect(lines[1]).toContain("Backlog Task");
    expect(lines[2]).toContain("In Progress Task");
    expect(lines[3]).toContain("Done Task");
  });
});

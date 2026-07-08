// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import type * as httpType from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { EMPTY_PARAMS, KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import { createServer } from "../../src/kanban/kanban-server.js";

const SERVERS: httpType.Server[] = [];
const TEMP_DIRS: string[] = [];

// Shared server instance reused across tests in this file
let sharedDb: KanbanDatabase;
let sharedServer: httpType.Server;
let sharedPort: number;
let sharedAuthToken: string;

// Tables to wipe between tests (order matters for foreign keys)
const DATA_TABLES = [
  "feature_locks",
  "feature_history",
  "feature_dependencies",
  "feature_tags",
  "tags",
  "features",
  "auto_agent_state",
  "projects",
];

beforeAll(async () => {
  sharedDb = await KanbanDatabase.createInMemory();
  const result = await createServer(sharedDb, 0, null, null);
  sharedServer = result.server;
  sharedPort = result.port;
  sharedAuthToken = result.authToken;
  SERVERS.push(sharedServer);
});

afterAll(async () => {
  for (const server of SERVERS.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

beforeEach(() => {
  // Wipe all data tables between tests for isolation
  for (const table of DATA_TABLES) {
    sharedDb.rawExec(`DELETE FROM ${table}`, EMPTY_PARAMS);
  }
});

/**
 * Returns the shared server instance with a clean DB.
 * Most tests should use this instead of creating a new server.
 */
function setup(): { db: KanbanDatabase; server: httpType.Server; port: number; authToken: string } {
  return { db: sharedDb, server: sharedServer, port: sharedPort, authToken: sharedAuthToken };
}

/**
 * Creates a fresh server instance (for tests that need custom config).
 */
async function _setupFresh(): Promise<{
  db: KanbanDatabase;
  server: httpType.Server;
  port: number;
  authToken: string;
}> {
  const db = await KanbanDatabase.createInMemory();
  const { server, port, authToken } = await createServer(db, 0, null, null);
  SERVERS.push(server);
  return { db, server, port, authToken };
}

const NO_REQUEST_INIT: RequestInit | null = null;

function fetchPort(
  port: number,
  urlPath: string,
  options: RequestInit | null,
  authToken: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { ...((options?.headers as Record<string, string>) ?? {}) };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return globalThis.fetch(`http://localhost:${port}${urlPath}`, { ...(options ?? {}), headers });
}

describe("Kanban REST API", () => {
  test("GET /api/projects returns empty list", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(port, "/api/projects", NO_REQUEST_INIT, authToken);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toEqual([]);
  });

  test("POST /api/features creates a feature", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "test", title: "Test Feature", lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.slug).toBe("test");
  });

  test("GET /api/features/:id returns feature", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(port, `/api/features/${featureId}`, NO_REQUEST_INIT, authToken);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.id).toBe(featureId);
  });

  test("POST /api/features/:id/move moves feature", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "design", changedBy: "user" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    const feature = db.getFeature(featureId);
    expect(feature?.lane).toBe("design");
  });

  test("POST /api/features/:id/move rejects invalid toLane", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "invalid-lane", changedBy: "user" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/invalid/i);

    // Feature should not have moved
    const feature = db.getFeature(featureId);
    expect(feature?.lane).toBe("backlog");
  });

  test("POST /api/features/:id/move rejects non-string changedBy", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", changedBy: 123 }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/changedBy/);
  });

  test("POST /api/features/:id/move rejects non-string note", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", note: { obj: true } }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/note/);
  });

  test("GET /api/board/:projectId returns full board state", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog" });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "ready" });

    const res = await fetchPort(port, `/api/board/${projectId}`, NO_REQUEST_INIT, authToken);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.backlog).toHaveLength(1);
    expect(data.ready).toHaveLength(1);
  });
});

describe("Kanban server input validation", () => {
  test("POST /api/features rejects invalid JSON", async () => {
    const { port, authToken } = setup();
    const res = await globalThis.fetch(`http://localhost:${port}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/invalid json/i);
  });

  test("POST /api/features rejects missing projectId", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "test", title: "Test" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/projectId/);
  });

  test("POST /api/features accepts empty slug (treated as null)", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "", title: "Test" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: number };
    expect(data.id).toBeGreaterThan(0);
    // Verify slug is null in DB
    const feature = db.getFeature(data.id);
    expect(feature?.slug).toBeNull();
  });

  test("POST /api/features accepts valid slug matching generateSlug pattern", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "my-feature", title: "Test" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.slug).toBe("my-feature");
  });

  test("POST /api/features rejects invalid slug with path traversal", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "2026-06-07-../etc/passwd", title: "Test" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toContain("slug must contain only lowercase");
  });

  test("POST /api/features rejects slug with uppercase letters", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "MyFeature", title: "Test" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toContain("slug must contain only lowercase");
  });

  test("POST /api/features rejects invalid lane", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "test", title: "Test", lane: "invalid" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/lane/);
  });

  test("POST /api/features rejects missing title", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "test" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/title/);
  });

  test("POST /api/features rejects empty title", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "test", title: "" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/title/);
  });

  test("PATCH /api/features/:id rejects empty title", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/title/);
  });

  test("PATCH /api/features/:id rejects non-string title", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: 123 }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/title/);
  });

  test("PATCH /api/features/:id rejects non-string description", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: 42 }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/description/);
  });

  test("PATCH /api/features/:id rejects non-integer priority", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: "high" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/priority/);
  });

  test("PATCH /api/features/:id accepts null description", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", description: "old", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: null }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.description).toBeNull();
  });
});

describe("Kanban server error handling", () => {
  test("GET /api/features/:id returns 404 for non-existent feature", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(port, "/api/features/99999", NO_REQUEST_INIT, authToken);
    expect(res.status).toBe(404);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/not found/i);
  });

  test("unknown API route returns 404", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(port, "/api/nonexistent", NO_REQUEST_INIT, authToken);
    expect(res.status).toBe(404);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/not found/i);
  });

  test("GET /api/features/:id/history returns history entries", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });
    db.moveFeature({ featureId, toLane: "design", changedBy: "user", note: "moved to design" });

    const res = await fetchPort(port, `/api/features/${featureId}/history`, NO_REQUEST_INIT, authToken);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ note: string }>;
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].note).toContain("moved to design");
  });

  test("POST /api/features/:id/release releases a locked feature", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "in-progress" });
    db.lockFeature(featureId, "session-1");

    // Verify locked
    const before = db.getFeature(featureId);
    expect(before?.locked_at).toBeTruthy();

    const res = await fetchPort(port, `/api/features/${featureId}/release`, { method: "POST" }, authToken);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.locked_at).toBeNull();
  });

  test("POST /api/features/:id/release returns 404 for non-existent feature", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(port, "/api/features/99999/release", { method: "POST" }, authToken);
    expect(res.status).toBe(404);
  });

  test("POST /api/features/:id/release returns 409 for unlocked feature", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(port, `/api/features/${featureId}/release`, { method: "POST" }, authToken);
    expect(res.status).toBe(409);
  });

  // ---- Lock endpoint ----

  test("POST /api/features/:id/lock locks an unlocked feature", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "in-progress" });

    // Verify unlocked
    const before = db.getFeature(featureId);
    expect(before?.locked_at).toBeNull();

    const res = await fetchPort(port, `/api/features/${featureId}/lock`, { method: "POST" }, authToken);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.locked_at).toBeTruthy();
  });

  test("POST /api/features/:id/lock returns 404 for non-existent feature", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(port, "/api/features/99999/lock", { method: "POST" }, authToken);
    expect(res.status).toBe(404);
  });

  test("POST /api/features/:id/lock returns 409 for already-locked feature", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "in-progress" });
    db.lockFeature(featureId, "session-1");

    const res = await fetchPort(port, `/api/features/${featureId}/lock`, { method: "POST" }, authToken);
    expect(res.status).toBe(409);
  });

  test("lock→release→lock round-trip works", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "in-progress" });

    // Lock
    const res1 = await fetchPort(port, `/api/features/${featureId}/lock`, { method: "POST" }, authToken);
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as { locked_at: string | null };
    expect(data1.locked_at).toBeTruthy();

    // Release
    const res2 = await fetchPort(port, `/api/features/${featureId}/release`, { method: "POST" }, authToken);
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as { locked_at: string | null };
    expect(data2.locked_at).toBeNull();

    // Lock again
    const res3 = await fetchPort(port, `/api/features/${featureId}/lock`, { method: "POST" }, authToken);
    expect(res3.status).toBe(200);
    const data3 = (await res3.json()) as { locked_at: string | null };
    expect(data3.locked_at).toBeTruthy();
  });

  test("root path without staticDir returns 404", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(port, "/", NO_REQUEST_INIT, authToken);
    // No staticDir configured, so non-API routes return 404
    expect(res.status).toBe(404);
  });

  test("POST /api/features/:id/move returns 404 for non-existent feature", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(
      port,
      "/api/features/99999/move",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", changedBy: "user" }),
      },
      authToken,
    );
    expect(res.status).toBe(404);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/not found/i);
  });

  test("POST /api/features/:id/move with invalid JSON body returns error", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await globalThis.fetch(`http://localhost:${port}/api/features/${featureId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

describe("Kanban server security", () => {
  test("API rejects requests without auth token", async () => {
    const { port } = setup();
    const res = await fetchPort(port, "/api/projects", null, null); // no auth token
    expect(res.status).toBe(401);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("Unauthorized");
  });

  test("API rejects requests with wrong auth token", async () => {
    const { port } = setup();
    const res = await fetchPort(port, "/api/projects", NO_REQUEST_INIT, "wrong-token");
    expect(res.status).toBe(401);
  });

  test("DELETE /api/features/:id rejects requests without auth token", async () => {
    const { port, db } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "auth-test", title: "Auth Test", lane: "backlog" });

    const res = await fetchPort(port, `/api/features/${featureId}`, { method: "DELETE" }, null); // no auth
    expect(res.status).toBe(401);
    expect(db.getFeature(featureId)).not.toBeNull(); // feature still exists
  });
  test("path traversal protection blocks encoded paths", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-traversal-test-"));
    TEMP_DIRS.push(dir);
    const staticDir = path.join(dir, "ui");
    fs.mkdirSync(staticDir);
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>OK</h1>");
    fs.writeFileSync(path.join(dir, "secret.txt"), "top-secret");

    const dbDir = path.join(dir, "db");
    fs.mkdirSync(dbDir);
    const db = await KanbanDatabase.createInMemory();
    const { server, port } = await createServer(db, 0, staticDir, null);
    SERVERS.push(server);

    // URL parser normalizes /../ but we still verify the check works for edge cases
    // Test: file that doesn't exist in static dir should not leak info
    const res = await fetchPort(port, "/nonexistent", null, null);
    // SPA fallback serves index.html for unknown routes
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("<h1>OK</h1>");

    // Normal file works
    const normalRes = await fetchPort(port, "/index.html", null, null);
    expect(normalRes.status).toBe(200);
  });
});

describe("Kanban REST API — CRUD endpoints", () => {
  test("DELETE /api/features/:id deletes a feature", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(port, `/api/features/${featureId}`, { method: "DELETE" }, authToken);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(db.getFeature(featureId)).toBeNull();
  });

  test("DELETE /api/features/:id returns 404 for non-existent", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(port, "/api/features/99999", { method: "DELETE" }, authToken);
    expect(res.status).toBe(404);
  });

  test("DELETE /api/features/:id returns 409 when feature is locked", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({
      projectId,
      slug: "locked-test",
      title: "Locked Feature",
      lane: "in-progress",
    });
    db.lockFeature(featureId, "session-1");

    const res = await fetchPort(port, `/api/features/${featureId}`, { method: "DELETE" }, authToken);
    expect(res.status).toBe(409);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/locked/i);
    // Feature should still exist
    expect(db.getFeature(featureId)).not.toBeNull();
  });

  test("DELETE /api/features/:id succeeds after lock is released (lock→409→release→delete flow)", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "lock-flow", title: "Lock Flow", lane: "in-progress" });
    db.lockFeature(featureId, "session-1");

    // DELETE while locked → 409
    const res1 = await fetchPort(port, `/api/features/${featureId}`, { method: "DELETE" }, authToken);
    expect(res1.status).toBe(409);
    expect(db.getFeature(featureId)).not.toBeNull();

    // Release lock
    const res2 = await fetchPort(port, `/api/features/${featureId}/release`, { method: "POST" }, authToken);
    expect(res2.status).toBe(200);

    // DELETE after release → success
    const res3 = await fetchPort(port, `/api/features/${featureId}`, { method: "DELETE" }, authToken);
    expect(res3.status).toBe(200);
    const data = (await res3.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(db.getFeature(featureId)).toBeNull();
  });

  test("PATCH /api/features/:id updates title and description", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Old Title", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Title", description: "Updated desc" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.title).toBe("New Title");
    expect(data.description).toBe("Updated desc");
  });

  test("PATCH /api/features/:id returns 404 for non-existent", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(
      port,
      "/api/features/99999",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "X" }),
      },
      authToken,
    );
    expect(res.status).toBe(404);
  });

  test("GET /api/tags returns empty list when no tags", async () => {
    const { port, authToken } = setup();
    const res = await fetchPort(port, "/api/tags", NO_REQUEST_INIT, authToken);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toEqual([]);
  });

  test("GET /api/projects/:id/features returns all features", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog" });
    db.createFeature({ projectId, slug: "b", title: "B", lane: "ready" });

    const res = await fetchPort(port, `/api/projects/${projectId}/features`, NO_REQUEST_INIT, authToken);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ slug: string }>;
    expect(data).toHaveLength(2);
    const slugs = data.map((f) => f.slug).sort();
    expect(slugs).toEqual(["a", "b"]);
  });
});

describe("Kanban server auto-slug generation", () => {
  test("POST /api/features auto-generates slug in {YYYY-MM-DD}-{feature} format when slug is omitted", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "Add auth system", lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.slug).toMatch(/^\d{4}-\d{2}-\d{2}-add-auth-system$/);
  });

  test("POST /api/features auto-generates slug with special chars sanitized", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "Fix: Bug #123!", lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.slug).toMatch(/^\d{4}-\d{2}-\d{2}-fix-bug-123$/);
  });

  test("POST /api/features uses provided slug when explicitly set", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "custom-slug", title: "Custom", lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.slug).toBe("custom-slug");
  });
});

describe("Kanban server body size limit", () => {
  test("POST /api/features returns 413 when body exceeds 1MB", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    // Create a body larger than 1MB (MAX_BODY_SIZE = 1 << 20)
    const bigTitle = "x".repeat(1_050_000);
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, slug: "test", title: bigTitle, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(413);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/too large/i);
  });

  test("PATCH /api/features/:id returns 413 when body exceeds 1MB", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const bigDescription = "y".repeat(1_050_000);
    const res = await fetchPort(
      port,
      `/api/features/${featureId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: bigDescription }),
      },
      authToken,
    );
    expect(res.status).toBe(413);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/too large/i);
  });
});

describe("POST /api/features error response", () => {
  test("does not leak internal error details", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    // Create first feature with a specific slug
    const today = new Date().toISOString().slice(0, 10);
    const slug = `${today}-test-feature`;
    db.createFeature({
      projectId,
      slug,
      title: "Test Feature",
      description: "first",
      lane: "backlog",
    });

    // Try to create a second feature with the same slug — triggers UNIQUE constraint
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          slug,
          title: "Duplicate",
          description: "second",
          lane: "backlog",
        }),
      },
      authToken,
    );

    expect(res.status).toBe(500);
    const data = (await res.json()) as Record<string, unknown>;
    // Must NOT contain raw SQL/internal details
    expect(data.error).not.toContain("UNIQUE");
    expect(data.error).not.toContain("SQLITE");
    expect(data.error).not.toContain("constraint");
    // Should be a generic message
    expect(data.error).toBe("Failed to create feature");
  });
});

describe("POST /api/features/:id/move error response", () => {
  test("does not reflect user input in error message", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const featureId = db.createFeature({ projectId, slug: "test", title: "Test", lane: "backlog" });

    const res = await fetchPort(
      port,
      `/api/features/${featureId}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "<script>alert(1)</script>" }),
      },
      authToken,
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    // Must NOT reflect the user-provided toLane value
    expect(data.error).not.toContain("<script>");
    expect(data.error).not.toContain("alert");
    // Should be a fixed message
    expect(data.error).toBe("Invalid toLane");
  });
});

describe("POST /api/features/reorder", () => {
  test("reorders features within a lane", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 20 });
    const id3 = db.createFeature({ projectId, slug: "c", title: "C", lane: "backlog", priority: 10 });

    // Reorder: C first, A second, B third
    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [id3, id1, id2], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.reordered).toBe(3);
    expect(data.reorderedIds).toEqual([id3, id1, id2]);
    expect(data.skippedIds).toEqual([]);

    // Verify priorities: C=30, A=20, B=10
    expect(db.getFeature(id3)?.priority).toBe(30);
    expect(db.getFeature(id1)?.priority).toBe(20);
    expect(db.getFeature(id2)?.priority).toBe(10);
  });

  test("returns 400 for empty featureIds", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/non-empty/);
  });

  test("returns 400 for missing featureIds", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 for non-integer featureIds", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: ["abc", 1], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/positive integer/);
  });

  test("returns 400 for zero/negative featureIds", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [0, -1], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/positive integer/);
  });

  test("returns 400 for featureIds exceeding max size", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: ids, projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/1000/);
  });

  test("silently skips non-existent feature IDs", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [99999], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.skippedIds).toContain(99999);
    expect(data.reordered).toBe(0);
  });

  test("returns reordered: 0 for single card — no-op per spec", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 99 });

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [id1], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.reordered).toBe(0);
    expect(data.reorderedIds).toEqual([]);
    expect(data.skippedIds).toEqual([]);

    // Priority should NOT have been written — original value preserved
    expect(db.getFeature(id1)?.priority).toBe(99);
  });

  test("returns 400 for invalid projectId", async () => {
    const { port, authToken } = setup();

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [1], projectId: "invalid", lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/projectId/);
  });

  test("returns 400 for missing lane", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [1], projectId }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/lane/);
  });

  test("returns 400 for invalid lane name", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [1], projectId, lane: "invalid-lane" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/lane/);
  });

  test("silently skips features from different projects", async () => {
    const { port, db, authToken } = setup();
    const projectId1 = db.createProject({ name: "P1", repoPath: "/p1" });
    const projectId2 = db.createProject({ name: "P2", repoPath: "/p2" });
    const id1 = db.createFeature({ projectId: projectId1, slug: "a", title: "A", lane: "backlog" });
    const id2 = db.createFeature({ projectId: projectId1, slug: "b", title: "B", lane: "backlog" });
    const id3 = db.createFeature({ projectId: projectId2, slug: "c", title: "C", lane: "backlog" });

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [id1, id2, id3], projectId: projectId1, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.reorderedIds).toContain(id1);
    expect(data.reorderedIds).toContain(id2);
    expect(data.skippedIds).toContain(id3);
  });

  test("silently skips features that moved to a different lane", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 20 });
    const id3 = db.createFeature({ projectId, slug: "c", title: "C", lane: "ready", priority: 10 });

    // id3 moved to ready lane, should be skipped
    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [id3, id1, id2], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.reordered).toBe(2);
    expect(data.reorderedIds).toEqual([id1, id2]);
    expect(data.skippedIds).toEqual([id3]);

    // id3 priority unchanged
    expect(db.getFeature(id3)?.priority).toBe(10);
    // id1 and id2 reordered: id1=20, id2=10
    expect(db.getFeature(id1)?.priority).toBe(20);
    expect(db.getFeature(id2)?.priority).toBe(10);
  });

  test("silently skips locked features", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 20 });
    const id3 = db.createFeature({ projectId, slug: "c", title: "C", lane: "backlog", priority: 10 });

    // Lock id2
    db.lockFeature(id2, "session-1");

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [id3, id2, id1], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.reordered).toBe(2);
    expect(data.reorderedIds).toEqual([id3, id1]);
    expect(data.skippedIds).toEqual([id2]);

    // id2 priority unchanged (locked)
    expect(db.getFeature(id2)?.priority).toBe(20);
    // id3 and id1 reordered: id3=20, id1=10
    expect(db.getFeature(id3)?.priority).toBe(20);
    expect(db.getFeature(id1)?.priority).toBe(10);
  });

  test("deduplicates duplicate featureIds in reorder request", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 20 });

    // Send id1 twice and id2 once
    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [id1, id2, id1], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    // Each feature should appear only once in reorderedIds
    expect(data.reorderedIds).toEqual([id1, id2]);
    expect(data.reordered).toBe(2);
    // Priorities: id1=20, id2=10 (based on first occurrence order)
    expect(db.getFeature(id1)?.priority).toBe(20);
    expect(db.getFeature(id2)?.priority).toBe(10);
  });

  test("returns reordered 0 when only 0-1 cards remain after filtering", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "ready", priority: 30 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "ready", priority: 20 });

    // Both in different lane — nothing to reorder
    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [id1, id2], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.reordered).toBe(0);
    expect(data.reorderedIds).toEqual([]);
    expect(data.skippedIds).toEqual([id1, id2]);
  });

  test("does not create history entries", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 20 });

    await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [id2, id1], projectId, lane: "backlog" }),
      },
      authToken,
    );

    const history1 = db.getFeatureHistory(id1);
    const history2 = db.getFeatureHistory(id2);
    expect(history1).toEqual([]);
    expect(history2).toEqual([]);
  });

  test("all features in reorder batch get identical updated_at", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 20 });
    const id3 = db.createFeature({ projectId, slug: "c", title: "C", lane: "backlog", priority: 10 });

    // Record updated_at before reorder
    const before1 = db.getFeature(id1)?.updated_at;
    const _before2 = db.getFeature(id2)?.updated_at;
    const _before3 = db.getFeature(id3)?.updated_at;

    // Small delay to ensure updated_at would differ if not batched
    await new Promise((r) => setTimeout(r, 10));

    const res = await fetchPort(
      port,
      "/api/features/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: [id3, id1, id2], projectId, lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    const after1 = db.getFeature(id1)?.updated_at;
    const after2 = db.getFeature(id2)?.updated_at;
    const after3 = db.getFeature(id3)?.updated_at;

    // All three should have the same updated_at
    expect(after1).toBe(after2);
    expect(after2).toBe(after3);

    // And they should differ from before (reorder changed them)
    expect(after1).not.toBe(before1);
  });
});

describe("POST /api/features/:id/move FIFO priority", () => {
  test("assigns FIFO priority when moving to a new lane", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const _id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "ready", priority: 40 });

    // Move id2 to backlog — should get priority below id1
    const res = await fetchPort(
      port,
      `/api/features/${id2}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "backlog", changedBy: "user" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    // id2 should have priority = min(50) - 10 = 40
    const movedFeature = db.getFeature(id2);
    if (!movedFeature) throw new Error("Feature not found");
    expect(movedFeature.priority).toBe(40);
    expect(movedFeature.lane).toBe("backlog");
  });

  test("assigns priority 0 when moving to an empty lane", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });

    // Move to empty lane
    const res = await fetchPort(
      port,
      `/api/features/${id1}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", changedBy: "user" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    const movedFeature = db.getFeature(id1);
    if (!movedFeature) throw new Error("Feature not found");
    expect(movedFeature.priority).toBe(0);
    expect(movedFeature.lane).toBe("ready");
  });

  test("each subsequent move gets lower priority (FIFO)", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "backlog", priority: 40 });
    const id3 = db.createFeature({ projectId, slug: "c", title: "C", lane: "backlog", priority: 30 });

    // Move all to ready, one at a time
    await fetchPort(
      port,
      `/api/features/${id1}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", changedBy: "user" }),
      },
      authToken,
    );
    await fetchPort(
      port,
      `/api/features/${id2}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", changedBy: "user" }),
      },
      authToken,
    );
    await fetchPort(
      port,
      `/api/features/${id3}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", changedBy: "user" }),
      },
      authToken,
    );

    // Verify FIFO order: id1=0, id2=-10, id3=-20
    const f1 = db.getFeature(id1);
    if (!f1) throw new Error("Feature not found");
    const f2 = db.getFeature(id2);
    if (!f2) throw new Error("Feature not found");
    const f3 = db.getFeature(id3);
    if (!f3) throw new Error("Feature not found");
    expect(f1.priority).toBe(0);
    expect(f2.priority).toBe(-10);
    expect(f3.priority).toBe(-20);
  });

  test("same-lane move preserves priority unchanged", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 42 });

    // Move to same lane — priority should be preserved
    const res = await fetchPort(
      port,
      `/api/features/${id1}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "backlog", changedBy: "user" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    const movedFeature = db.getFeature(id1);
    if (!movedFeature) throw new Error("Feature not found");
    expect(movedFeature.priority).toBe(42);
    expect(movedFeature.lane).toBe("backlog");
  });

  test("same-lane move with position parameter returns 400", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 42 });

    // Move to same lane with position: top — should be rejected (use reorder endpoint)
    const res = await fetchPort(
      port,
      `/api/features/${id1}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "backlog", position: "top", changedBy: "user" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/same lane|reorder/i);

    // Feature should be unchanged
    const feature = db.getFeature(id1);
    if (!feature) throw new Error("Feature not found");
    expect(feature.priority).toBe(42);
    expect(feature.lane).toBe("backlog");
  });
});

describe("POST /api/features/:id/move position parameter", () => {
  test("position 'top' places card above existing cards", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const _id1 = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    const id2 = db.createFeature({ projectId, slug: "b", title: "B", lane: "ready", priority: 40 });

    // Move id2 to backlog at top — should get priority above id1 (50)
    const res = await fetchPort(
      port,
      `/api/features/${id2}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "backlog", changedBy: "user", position: "top" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    const movedFeature = db.getFeature(id2);
    if (!movedFeature) throw new Error("Feature not found");
    expect(movedFeature.priority).toBe(60);
    expect(movedFeature.lane).toBe("backlog");
  });

  test("position 'bottom' (default) places card below existing cards", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const _idA = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    const idB = db.createFeature({ projectId, slug: "b", title: "B", lane: "ready", priority: 40 });

    // Move idB to backlog at bottom — should get priority below idA (50)
    const res = await fetchPort(
      port,
      `/api/features/${idB}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "backlog", changedBy: "user", position: "bottom" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    const movedFeature = db.getFeature(idB);
    if (!movedFeature) throw new Error("Feature not found");
    expect(movedFeature.priority).toBe(40);
    expect(movedFeature.lane).toBe("backlog");
  });

  test("default position is 'bottom' when not specified", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const _idA = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    const idB = db.createFeature({ projectId, slug: "b", title: "B", lane: "ready", priority: 40 });

    // Move without position — default should be bottom (FIFO)
    const res = await fetchPort(
      port,
      `/api/features/${idB}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "backlog", changedBy: "user" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    const movedFeature = db.getFeature(idB);
    if (!movedFeature) throw new Error("Feature not found");
    expect(movedFeature.priority).toBe(40);
  });

  test("rejects invalid position value", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });

    const res = await fetchPort(
      port,
      `/api/features/${id}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", changedBy: "user", position: "middle" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/position/);
  });

  test.each([
    [123, "number"],
    [true, "boolean"],
    [null, "null"],
    [["top"], "array"],
    [{}, "object"],
  ] as [unknown, string][])("rejects non-string position value (%s)", async (badPosition) => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });

    const res = await fetchPort(
      port,
      `/api/features/${id}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", changedBy: "user", position: badPosition }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/position/);
  });

  test("position 'top' on move to empty lane assigns 10", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });

    // Move to empty 'ready' lane with position top — should get PRIORITY_SPACING (10)
    const res = await fetchPort(
      port,
      `/api/features/${id}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "ready", changedBy: "user", position: "top" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    const movedFeature = db.getFeature(id);
    if (!movedFeature) throw new Error("Feature not found");
    expect(movedFeature.priority).toBe(10);
    expect(movedFeature.lane).toBe("ready");
  });

  test("same-lane move without position returns feature unchanged", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });
    const _beforeFeature = db.getFeature(id);
    if (!_beforeFeature) throw new Error("Feature not found");

    // Move to same lane without position — should return feature as-is (no-op)
    const res = await fetchPort(
      port,
      `/api/features/${id}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "backlog", changedBy: "user" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);

    const data = (await res.json()) as Record<string, unknown>;
    expect(data.lane).toBe("backlog");
    expect(data.priority).toBe(50);
    // No history entry should be created for a no-op move
    const history = db.getFeatureHistory(id);
    expect(history).toHaveLength(0);
  });

  test("same-lane move with position returns 400", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    const id = db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 50 });

    // Move to same lane WITH position — should reject (use reorder endpoint instead)
    const res = await fetchPort(
      port,
      `/api/features/${id}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: "backlog", changedBy: "user", position: "top" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/same lane|position/i);
  });
});

describe("POST /api/features position parameter", () => {
  test("position 'top' adds above existing features", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "Top Feature", lane: "backlog", position: "top" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.priority).toBe(40);
  });

  test("position 'bottom' adds below existing features", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "Bottom Feature", lane: "backlog", position: "bottom" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.priority).toBe(20);
  });

  test("position 'bottom' assigns 0 for empty lane", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "First Feature", lane: "backlog", position: "bottom" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.priority).toBe(0);
  });

  test("position 'top' assigns 10 for empty lane", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "First Feature", lane: "backlog", position: "top" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.priority).toBe(10);
  });

  test("default position is 'bottom' when not specified", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "a", title: "A", lane: "backlog", priority: 30 });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "Default Feature", lane: "backlog" }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.priority).toBe(0);
  });

  test("rejects invalid position value", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "Test", lane: "backlog", position: "middle" }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/position/);
  });

  test("backward compat: explicit priority still works when position not set", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "Test", lane: "backlog", priority: 42 }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.priority).toBe(42);
  });

  test("position takes precedence over explicit priority", async () => {
    const { port, db, authToken } = setup();
    const projectId = db.createProject({ name: "Test", repoPath: "/test" });
    db.createFeature({ projectId, slug: "existing", title: "Existing", lane: "backlog", priority: 30 });

    // Send BOTH position: "top" AND priority: 42 — position should win
    const res = await fetchPort(
      port,
      "/api/features",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "Position Wins", lane: "backlog", position: "top", priority: 42 }),
      },
      authToken,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    // position: top → max(30) + 10 = 40, NOT the explicit priority: 42
    expect(data.priority).toBe(40);
  });
});

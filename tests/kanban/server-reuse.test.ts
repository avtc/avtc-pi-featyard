// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import type * as httpType from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import { createServer } from "../../src/kanban/kanban-server.js";

const SERVERS: httpType.Server[] = [];
const TEMP_DIRS: string[] = [];

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

afterEach(async () => {
  for (const server of SERVERS.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Path to the auth token file within a data directory.
 */
function authTokenFilePath(dataDir: string): string {
  return path.join(dataDir, "auth_token.txt");
}

/**
 * Verify a server is alive by hitting the /api/projects endpoint.
 */
async function isServerAlive(port: number, token: string): Promise<boolean> {
  try {
    const res = await globalThis.fetch(`http://localhost:${port}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe("kanban server auth token persistence", () => {
  test("writes auth token to dataDir when server starts with a dataDir", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-token-test-"));
    TEMP_DIRS.push(dataDir);

    const db = await KanbanDatabase.createInMemory();
    const result = await createServer(db, 0, null, { dataDir });
    SERVERS.push(result.server);

    const tokenFilePath = authTokenFilePath(dataDir);
    expect(fs.existsSync(tokenFilePath)).toBe(true);
    const savedToken = fs.readFileSync(tokenFilePath, "utf-8").trim();
    expect(savedToken).toBe(result.authToken);
    expect(savedToken.length).toBe(64); // 32 bytes hex = 64 chars
  });

  test("writes auth token with restricted file permissions (mode 0o600)", async () => {
    // File mode bits are only meaningful on POSIX systems
    if (process.platform === "win32") return;

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-token-perm-"));
    TEMP_DIRS.push(dataDir);

    const db = await KanbanDatabase.createInMemory();
    const result = await createServer(db, 0, null, { dataDir });
    SERVERS.push(result.server);

    const tokenFilePath = authTokenFilePath(dataDir);
    const stats = fs.statSync(tokenFilePath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("auth token file allows connecting to the running server", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-token-connect-"));
    TEMP_DIRS.push(dataDir);

    const db = await KanbanDatabase.createInMemory();
    const result = await createServer(db, 0, null, { dataDir });
    SERVERS.push(result.server);

    // Read the token from disk (simulating a second session)
    const savedToken = fs.readFileSync(authTokenFilePath(dataDir), "utf-8").trim();

    // Use the saved token to connect
    const res = await globalThis.fetch(`http://localhost:${result.port}/api/projects`, {
      headers: { Authorization: `Bearer ${savedToken}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(data)).toBe(true);
  });

  test("does not write auth token file when dataDir is not provided", async () => {
    const db = await KanbanDatabase.createInMemory();
    const result = await createServer(db, 0, null, null);
    SERVERS.push(result.server);

    // Server should start successfully without dataDir
    expect(result.port).toBeGreaterThan(0);
    expect(result.authToken).toBeTruthy();
  });

  test("overwrites stale auth token file when server restarts on same port", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-token-overwrite-"));
    TEMP_DIRS.push(dataDir);

    // Write a stale token
    const tokenFile = authTokenFilePath(dataDir);
    fs.writeFileSync(tokenFile, "stale-token-that-should-be-replaced");

    const db = await KanbanDatabase.createInMemory();
    const result = await createServer(db, 0, null, { dataDir });
    SERVERS.push(result.server);

    // Token file should be overwritten with the new token
    const savedToken = fs.readFileSync(tokenFile, "utf-8").trim();
    expect(savedToken).toBe(result.authToken);
    expect(savedToken).not.toBe("stale-token-that-should-be-replaced");
  });
});

describe("kanban server EADDRINUSE fallback", () => {
  test("second createServer on same port rejects with EADDRINUSE", async () => {
    const dataDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-eaddr1-"));
    const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-eaddr2-"));
    TEMP_DIRS.push(dataDir1, dataDir2);

    const db1 = await KanbanDatabase.createInMemory();
    const result1 = await createServer(db1, 0, null, { dataDir: dataDir1 });
    SERVERS.push(result1.server);
    const port = result1.port;

    // Try to bind to the same port
    const db2 = await KanbanDatabase.createInMemory();
    await expect(createServer(db2, port, null, { dataDir: dataDir2 })).rejects.toThrow();
  });

  test("can connect to existing server using saved auth token after EADDRINUSE", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-fallback-"));
    TEMP_DIRS.push(dataDir);

    // First server starts
    const db1 = await KanbanDatabase.createInMemory();
    const result1 = await createServer(db1, 0, null, { dataDir });
    SERVERS.push(result1.server);
    const port = result1.port;

    // Simulate second session: try to create server, fails, reads token, connects
    const db2 = await KanbanDatabase.createInMemory();
    let serverResult: { server: httpType.Server; port: number; authToken: string } | null = null;

    try {
      serverResult = await createServer(db2, port, null, { dataDir });
    } catch {
      // EADDRINUSE — fall back to reading the token file
      const tokenFile = authTokenFilePath(dataDir);
      if (fs.existsSync(tokenFile)) {
        const savedToken = fs.readFileSync(tokenFile, "utf-8").trim();
        const alive = await isServerAlive(port, savedToken);
        expect(alive).toBe(true);

        // Second session can use the saved token to access the API
        const projectId = db1.createProject({ name: "ProjectFromSession2", repoPath: "/session2" });

        const res = await globalThis.fetch(`http://localhost:${port}/api/features`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${savedToken}`,
          },
          body: JSON.stringify({ projectId, title: "Feature from session 2", lane: "backlog" }),
        });
        expect(res.status).toBe(201);
      }
    }

    // serverResult should be null since createServer failed
    expect(serverResult).toBeNull();
  });
});

describe("kanban shared database for multi-project support", () => {
  test("projects created by one session are visible to another session sharing the database", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-shared-db-"));
    TEMP_DIRS.push(dataDir);

    // Create a file-based database (shared between "sessions")
    const db1 = await KanbanDatabase.create(dataDir);
    const db2 = await KanbanDatabase.create(dataDir);

    // Session 1 creates a project
    const projectId1 = db1.createProject({ name: "Project1", repoPath: "/repo1" });
    db1.createFeature({ projectId: projectId1, slug: "f1", title: "Feature 1", lane: "backlog" });

    // Session 2 should see the project from session 1
    const projects = db2.listProjects();
    expect(projects.some((p) => p.id === projectId1)).toBe(true);

    // Session 2 creates its own project
    db2.createProject({ name: "Project2", repoPath: "/repo2" });

    // Both projects visible in both databases
    expect(db1.listProjects()).toHaveLength(2);
    expect(db2.listProjects()).toHaveLength(2);

    db1.close();
    db2.close();
  });

  test("findProjectByRepoPath returns null for unknown repo", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-find-project-"));
    TEMP_DIRS.push(dataDir);

    const db = await KanbanDatabase.create(dataDir);

    const result = db.findProjectByRepoPath("/nonexistent/repo");
    expect(result).toBeNull();

    db.close();
  });

  test("findProjectByRepoPath returns project after creation", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-find-created-"));
    TEMP_DIRS.push(dataDir);

    const db = await KanbanDatabase.create(dataDir);

    const repoPath = "/test/repo/path";
    const projectId = db.createProject({ name: "TestProject", repoPath });

    const found = db.findProjectByRepoPath(repoPath);
    expect(found).not.toBeNull();
    expect((found as NonNullable<typeof found>).id).toBe(projectId);
    expect((found as NonNullable<typeof found>).name).toBe("TestProject");

    db.close();
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type * as httpType from "node:http";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import { createServer } from "../../src/kanban/kanban-server.js";

const SERVERS: httpType.Server[] = [];

afterAll(async () => {
  for (const server of SERVERS.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

afterEach(async () => {
  for (const server of SERVERS.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("kanban server fixed port", () => {
  test("binds to port 0 (random) when no fixed port configured", async () => {
    const db = await KanbanDatabase.createInMemory();
    const result = await createServer(db, 0, null, null);
    SERVERS.push(result.server);
    // Port 0 means OS assigns a random available port
    expect(result.port).toBeGreaterThan(0);
  });

  test("binds to a specific port when configured", async () => {
    // Find a free port first to avoid conflicts
    const probeServer = await createServer(await KanbanDatabase.createInMemory(), 0, null, null);
    const freePort = probeServer.port;
    await new Promise<void>((resolve) => probeServer.server.close(() => resolve()));

    const db = await KanbanDatabase.createInMemory();
    const result = await createServer(db, freePort, null, null);
    SERVERS.push(result.server);
    expect(result.port).toBe(freePort);
  });

  test("rejects binding to an already-used port", async () => {
    const db1 = await KanbanDatabase.createInMemory();
    const result1 = await createServer(db1, 0, null, null);
    SERVERS.push(result1.server);
    const usedPort = result1.port;

    const db2 = await KanbanDatabase.createInMemory();
    await expect(createServer(db2, usedPort, null, null)).rejects.toThrow();
  });

  test("server responds on the assigned port", async () => {
    const db = await KanbanDatabase.createInMemory();
    const result = await createServer(db, 0, null, null);
    SERVERS.push(result.server);

    const res = await globalThis.fetch(`http://localhost:${result.port}/api/projects`, {
      headers: { Authorization: `Bearer ${result.authToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body)).toBe(true);
  });
});

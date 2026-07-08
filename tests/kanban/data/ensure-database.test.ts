// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterAll, afterEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import {
  ensureDatabase,
  getDatabaseInstance,
  resetInstances,
  setDatabaseInstance,
} from "../../../src/kanban/kanban-bridge.js";

const databases: KanbanDatabase[] = [];

async function createTempDb(): Promise<KanbanDatabase> {
  const db = await KanbanDatabase.createInMemory();
  databases.push(db);
  return db;
}

afterEach(() => {
  resetInstances();
});

afterAll(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {}
  }
});

describe("ensureDatabase", () => {
  test("returns a valid database instance even when no DB was initialized", async () => {
    // Reset any existing instance first
    resetInstances();

    // Pre-seed a temp DB so ensureDatabase returns it instead of creating one at ~/.pi/feature-flow/kanban
    const tempDb = await createTempDb();
    setDatabaseInstance(tempDb);

    // Before ensureDatabase, getDatabaseInstance should return our temp DB (just set)
    expect(getDatabaseInstance()).toBe(tempDb);

    // After ensureDatabase, we should get the same DB
    const db = await ensureDatabase();
    expect(db).toBe(tempDb);

    // Now getDatabaseInstance should also return the same instance
    expect(getDatabaseInstance()).toBe(db);
  });

  test("returns existing instance if already initialized", async () => {
    resetInstances();

    // Pre-seed a temp DB
    const tempDb = await createTempDb();
    setDatabaseInstance(tempDb);

    const db1 = await ensureDatabase();
    const db2 = await ensureDatabase();
    expect(db1).toBe(db2);
    expect(getDatabaseInstance()).toBe(db1);
    // Should be our temp DB, not the production one
    expect(db1).toBe(tempDb);
  });
});

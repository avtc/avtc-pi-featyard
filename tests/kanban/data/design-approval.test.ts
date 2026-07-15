// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import { KanbanTools } from "../../../src/kanban/kanban-operations.js";

async function createDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-design-approval-"));
  const db = await KanbanDatabase.createInMemory();
  return { db, dir };
}

describe("designApprovalEnabled runtime behavior", () => {
  test("kanbanTake picks from design lane when lanes include design", async () => {
    const { db, dir } = await createDb();
    try {
      const tools = new KanbanTools(db);
      const projectId = db.createProject({ name: "Test", repoPath: "/test" });
      const featureId = db.createFeature({
        projectId,
        slug: "fy-design",
        title: "Design Feature",
        lane: "design",
        description: "A feature in design lane",
      });

      // kanbanTake with design in lanes should pick from design lane
      const result = tools.kanbanTake({
        projectId,
        sessionId: "session-1",
        lanes: ["design", "ready"],
      });

      expect(result).not.toBeNull();
      expect((result as NonNullable<typeof result>).id).toBe(featureId);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("kanbanTake skips design lane when only ready lanes specified (approval gate)", async () => {
    const { db, dir } = await createDb();
    try {
      const tools = new KanbanTools(db);
      const projectId = db.createProject({ name: "Test", repoPath: "/test" });
      db.createFeature({
        projectId,
        slug: "fy-design",
        title: "Design Feature",
        lane: "design",
        description: "A feature in design lane",
      });

      // Worker role only picks from ready — design-approval gate respected
      const result = tools.kanbanTake({
        projectId,
        sessionId: "session-1",
        lanes: ["ready"],
      });

      expect(result).toBeNull();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

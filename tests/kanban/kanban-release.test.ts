// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import kanbanExtension, { resetInstances, setDatabase } from "../../src/kanban/kanban-bridge.js";

let tempDir: string | null = null;

afterEach(() => {
  resetInstances();
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    tempDir = null;
  }
});

async function setupTestDb() {
  tempDir = mkdtempSync(join(tmpdir(), "kanban-release-test-"));
  const db = await KanbanDatabase.createInMemory();
  const projectId = db.createProject({ name: "test-project", repoPath: process.cwd() });

  setDatabase(db);
  return { db, projectId };
}

function createFakeApi(): {
  api: ExtensionAPI;
  registeredCommands: Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>;
} {
  const registeredCommands = new Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>();

  const api = {
    on() {},
    registerTool() {},
    registerCommand(name: string, definition: { description: string; handler: (...args: unknown[]) => Promise<void> }) {
      registeredCommands.set(name, definition);
    },
    appendEntry() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;

  return { api, registeredCommands };
}

describe("fy:kanban-release command handler", () => {
  test("releases a locked feature", async () => {
    const { db, projectId } = await setupTestDb();

    const { api, registeredCommands } = createFakeApi();
    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Create and lock a feature
    const featureId = db.createFeature({
      projectId,
      slug: "2026-05-17-locked-feature",
      title: "Locked Feature",
      lane: "in-progress",
    });
    db.lockFeature(featureId, "test-session");

    // Verify it's locked
    const before = db.getFeature(featureId);
    expect(before?.locked_at).toBeTruthy();

    // Release via command
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };

    const cmd = registeredCommands.get("fy:kanban-release");
    if (cmd) await cmd.handler(String(featureId), ctx as unknown as ExtensionCommandContext);

    // Verify lock released
    const after = db.getFeature(featureId);
    expect(after?.locked_at).toBeNull();

    // Verify notification
    expect(notifications.some((n) => n.message.includes("lock released"))).toBe(true);
  });

  test("shows usage warning for missing feature ID", async () => {
    await setupTestDb();

    const { api, registeredCommands } = createFakeApi();
    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };

    const cmd = registeredCommands.get("fy:kanban-release");
    if (cmd) await cmd.handler("", ctx as unknown as ExtensionCommandContext);

    expect(notifications.some((n) => n.message.includes("Usage"))).toBe(true);
  });

  test("shows usage warning for non-numeric feature ID", async () => {
    await setupTestDb();

    const { api, registeredCommands } = createFakeApi();
    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };

    const cmd = registeredCommands.get("fy:kanban-release");
    if (cmd) await cmd.handler("abc", ctx as unknown as ExtensionCommandContext);

    expect(notifications.some((n) => n.message.includes("Usage"))).toBe(true);
  });

  test("shows 'released' even for non-existent feature (DELETE is idempotent)", async () => {
    await setupTestDb();

    const { api, registeredCommands } = createFakeApi();
    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };

    const cmd = registeredCommands.get("fy:kanban-release");
    if (cmd) await cmd.handler("99999", ctx as unknown as ExtensionCommandContext);

    // DELETE on non-existent row succeeds silently
    expect(notifications.some((n) => n.message.includes("lock released"))).toBe(true);
  });
});

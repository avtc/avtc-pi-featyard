// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import kanbanExtension, { resetInstances, setDatabase } from "../../../src/kanban/kanban-bridge.js";

const ORIGINAL_CWD = process.cwd();
let tempDir: string | null = null;

afterEach(() => {
  resetInstances();
  if (process.cwd() !== ORIGINAL_CWD) {
    process.chdir(ORIGINAL_CWD);
  }
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    tempDir = null;
  }
});

function createFakeApi(): {
  api: ExtensionAPI;
  registeredCommands: Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>;
  eventListeners: Map<string, (...args: unknown[]) => Promise<void>>;
} {
  const registeredCommands = new Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>();
  const eventListeners = new Map<string, (...args: unknown[]) => Promise<void>>();

  const api = {
    on(event: string, handler: (...args: unknown[]) => Promise<void>) {
      eventListeners.set(event, handler);
    },
    registerTool() {},
    registerCommand(name: string, definition: { description: string; handler: (...args: unknown[]) => Promise<void> }) {
      registeredCommands.set(name, definition);
    },
    appendEntry() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;

  return { api, registeredCommands, eventListeners };
}

async function setupTestDb() {
  tempDir = mkdtempSync(join(tmpdir(), "kanban-hb-"));
  process.chdir(tempDir);
  const db = await KanbanDatabase.createInMemory();
  const projectId = db.createProject({ name: "test-project", repoPath: tempDir });
  // Add a feature in ready lane for the worker to pick
  const featureId = db.createFeature({ projectId, slug: "test-feature", title: "Test Feature", lane: "ready" });

  setDatabase(db);
  return { db, projectId, featureId };
}

describe("subagent stream heartbeat refresh", () => {
  test("tool_result event refreshes heartbeat for active auto-agent", async () => {
    const { db, featureId } = await setupTestDb();

    const { api, registeredCommands, eventListeners } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Start an auto-worker which picks a feature
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
    const workerCmd = registeredCommands.get("fy:auto-worker");
    await (workerCmd as NonNullable<typeof workerCmd>).handler("", ctx as unknown as ExtensionCommandContext);

    // Verify the feature was picked and locked
    const feature = db.getFeature(featureId);
    expect(feature).not.toBeNull();
    expect((feature as NonNullable<typeof feature>).lane).toBe("in-progress");
    expect((feature as NonNullable<typeof feature>).locked_at).not.toBeNull();

    // Record the initial heartbeat timestamp
    const initialHeartbeat = (feature as NonNullable<typeof feature>).last_heartbeat;
    expect(initialHeartbeat).not.toBeNull();

    // Wait a small amount so the heartbeat timestamp changes
    await new Promise((r) => setTimeout(r, 0));

    // Fire a tool_result event
    const toolResultHandler = eventListeners.get("tool_result");
    expect(toolResultHandler).toBeDefined();

    if (toolResultHandler) {
      await toolResultHandler(
        {
          toolCallId: "tc-1",
          toolName: "read",
          input: { path: "/some/file.ts" },
          content: [{ type: "text", text: "file contents" }],
        },
        {} as unknown as ExtensionContext,
      );
    }

    // Verify heartbeat was refreshed
    const featureAfter = db.getFeature(featureId);
    expect((featureAfter as NonNullable<typeof featureAfter>).last_heartbeat).not.toBe(initialHeartbeat);
  });

  test("tool_result does not refresh heartbeat when no auto-agent is active", async () => {
    const { db, featureId } = await setupTestDb();

    const { api, eventListeners } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Lock the feature manually (no auto-agent)
    db.lockFeature(featureId, "manual-session");
    const feature = db.getFeature(featureId);
    const initialHeartbeat = (feature as NonNullable<typeof feature>).last_heartbeat;

    await new Promise((r) => setTimeout(r, 0));

    // Fire a tool_result event
    const toolResultHandler = eventListeners.get("tool_result");
    if (toolResultHandler) {
      await toolResultHandler(
        {
          toolCallId: "tc-1",
          toolName: "read",
          input: { path: "/some/file.ts" },
          content: [{ type: "text", text: "contents" }],
        },
        {} as unknown as ExtensionContext,
      );
    }

    // Heartbeat should NOT have changed
    const featureAfter = db.getFeature(featureId);
    expect((featureAfter as NonNullable<typeof featureAfter>).last_heartbeat).toBe(initialHeartbeat);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
  delete process.env.PI_FF_FEATURE;
});

async function setupTestDb() {
  tempDir = mkdtempSync(join(tmpdir(), "kanban-session-slug-activate-"));
  process.chdir(tempDir);
  const db = await KanbanDatabase.createInMemory();
  const projectId = db.createProject({ name: "test-project", repoPath: tempDir });
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

describe("session-slug matching sets globalThis.__piKanban.activateFeature", () => {
  test("activate feature is available after session-slug matching early return", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Create a feature in design lane
    db.createFeature({
      projectId,
      slug: "matched-feature",
      title: "Matched Feature",
      lane: "design",
    });

    // Set env var so session-slug matching picks it up (early return path)
    process.env.PI_FF_FEATURE = "matched-feature";

    const ctx = {
      ui: {
        notify() {},
        onTerminalInput() {
          return () => {};
        },
      },
    };

    // Start designer — this will take the session-slug matching early return
    const startCmd = registeredCommands.get("ff:auto-designer");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Verify the feature was locked via session-slug matching
    const feature = db.findFeatureBySlug("matched-feature", projectId);
    expect(feature?.locked_at).not.toBeNull();

    // globalThis.__piKanban.activateFeature must be set even when startAutoAgent
    // takes the session-slug matching early return path.
    const doActivate = globalThis.__piKanban?.activateFeature;
    expect(doActivate).toBeDefined();
    expect(typeof doActivate).toBe("function");
  });

  test("activate feature is available after normal (non-session-slug) path", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Create a feature in design lane
    db.createFeature({
      projectId,
      slug: "normal-feature",
      title: "Normal Feature",
      lane: "design",
    });

    // No PI_FF_FEATURE set — normal path (no session-slug matching)

    const ctx = {
      ui: {
        notify() {},
        onTerminalInput() {
          return () => {};
        },
      },
    };

    // Start designer — this takes the normal path
    const startCmd = registeredCommands.get("ff:auto-designer");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // globalThis.__piKanban.activateFeature should also be set on the normal path
    const doActivate = globalThis.__piKanban?.activateFeature;
    expect(doActivate).toBeDefined();
    expect(typeof doActivate).toBe("function");
  });
});

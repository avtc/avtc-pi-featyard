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
  delete globalThis.__piCtx;
  delete process.env.PI_FY_FEATURE;
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

describe("auto-agent resume adopts the active feature", () => {
  test("/fy:auto-agent on a paused featureless agent re-adopts PI_FY_FEATURE before resuming", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kanban-resume-adopt-"));
    process.chdir(tempDir);
    const db = await KanbanDatabase.createInMemory();
    const projectId = db.createProject({ name: "test-project", repoPath: tempDir });
    setDatabase(db);

    if (!globalThis.__piCtx) {
      const { PiCtx } = await import("../../../src/shared/types.js");
      globalThis.__piCtx = new PiCtx();
    }

    // Active feature still in design, locked by the interactive session that
    // drove the review loop (the agent cannot take it at startup).
    const slug = "2026-10-06-resume-adopt";
    const featureId = db.createFeature({
      projectId,
      slug,
      title: "Resume Adopt",
      description: "Test",
      lane: "design",
    });
    db.lockFeature(featureId, "interactive-session");

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

    // 1st start: feature locked elsewhere → agent adopts nothing, polls featureless
    const startCmd = registeredCommands.get("fy:auto-agent");
    expect(startCmd).toBeDefined();
    await startCmd?.handler("", ctx as unknown as ExtensionCommandContext);

    const sm = globalThis.__piKanban?.autoAgent;
    expect(sm?.getState()).toBe("polling");
    expect(sm?.getCurrentFeatureId()).toBeNull();

    // Session replacement pauses the orphaned agent; the user later re-runs /fy:auto-agent
    sm?.pause();
    expect(sm?.getState()).toBe("paused");
    db.unlockFeature(featureId);
    process.env.PI_FY_FEATURE = slug;

    await startCmd?.handler("", ctx as unknown as ExtensionCommandContext);

    // Resume must adopt the active feature: working on it, lock re-acquired
    expect(sm?.getCurrentFeatureId()).toBe(featureId);
    expect(sm?.getState()).toBe("working");
    const feature = db.getFeature(featureId);
    expect(feature?.locked_at).not.toBeNull();
    expect(feature?.locked_by_session).toBe(sm?.sessionId);
    expect(notifications.find((n) => n.message.includes("locked existing feature"))).toBeDefined();
  });
});

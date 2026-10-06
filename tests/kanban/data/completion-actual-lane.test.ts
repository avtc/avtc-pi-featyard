// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import {
  NO_AUTO_AGENT_CALLBACK,
  setAutoAgentCallback,
} from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import type { Feature } from "../../../src/kanban/data/kanban-types.js";
import kanbanExtension, { resetInstances, setDatabase } from "../../../src/kanban/kanban-bridge.js";

const tempDirs: string[] = [];
const ORIGINAL_CWD = process.cwd();

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-completion-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetInstances();
  setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
  delete globalThis.__piCtx;
  if (process.cwd() !== ORIGINAL_CWD) {
    process.chdir(ORIGINAL_CWD);
  }
});

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("onFeatureCompletion actual lane check", () => {
  test("feature in design lane has correct initial state with lock", async () => {
    const tempDir = createTempDir();
    const db = await KanbanDatabase.createInMemory();
    const projectId = db.createProject({ name: "test", repoPath: tempDir });

    const featureId = db.createFeature({
      projectId,
      slug: "test-feature",
      title: "Test",
      description: "Test",
      lane: "design",
    });

    db.lockFeature(featureId, "agent-session-1");

    const feature = db.getFeature(featureId) as Feature;
    // Verify DB-level state: design lane + locked_by_session populated
    expect(feature.lane).toBe("design");
    expect(feature.locked_at).not.toBeNull();
    expect(feature.locked_by_session).toBe("agent-session-1");
  });

  test("feature moved to ready by user is re-picked on design completion, never moved back to design-approval", async () => {
    const tempDir = createTempDir();
    process.chdir(tempDir);
    const db = await KanbanDatabase.createInMemory();
    const projectId = db.createProject({ name: "test", repoPath: tempDir });
    setDatabase(db);

    // Initialize PiCtx — the kanban notify path routes through it
    if (!globalThis.__piCtx) {
      const { PiCtx } = await import("../../../src/shared/types.js");
      globalThis.__piCtx = new PiCtx();
    }

    const featureId = db.createFeature({
      projectId,
      slug: "test-feature",
      title: "Test",
      description: "Test",
      lane: "design",
    });

    // Fake extension API capturing registered commands + notifications
    const registeredCommands = new Map<
      string,
      { description: string; handler: (...args: unknown[]) => Promise<void> }
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const api = {
      on() {},
      registerTool() {},
      registerCommand(
        name: string,
        definition: { description: string; handler: (...args: unknown[]) => Promise<void> },
      ) {
        registeredCommands.set(name, definition);
      },
      appendEntry() {},
      sendUserMessage() {},
    } as unknown as ExtensionAPI;

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

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

    // Start the auto-agent — it picks the design feature and locks it
    const startCmd = registeredCommands.get("fy:auto-agent");
    expect(startCmd).toBeDefined();
    await startCmd?.handler("", ctx as unknown as ExtensionCommandContext);

    const sm = globalThis.__piKanban?.autoAgent;
    expect(sm?.getState()).toBe("working");
    expect(sm?.getCurrentFeatureId()).toBe(featureId);
    expect(db.getFeature(featureId)?.locked_at).not.toBeNull();

    // Simulate: user moved the feature to ready while the agent was working (pre-approval)
    db.moveFeature({
      featureId,
      toLane: "ready",
      changedBy: "user",
      note: "User pre-approved",
    });
    expect(db.getFeature(featureId)?.lane).toBe("ready");

    // Drive the production design-completion callback (what phase_ready invokes
    // in auto mode). The actual-lane check must see lane !== "design" and re-pick
    // the user-approved card instead of parking it at the approval gate.
    const callback = globalThis.__piKanban?.autoAgentCallback;
    expect(callback).toBeDefined();
    await callback?.onDesignComplete?.("test-feature");

    const feature = db.getFeature(featureId) as Feature;
    // Never dragged back to design-approval: the agent re-took the ready card
    // (kanbanTake moves ready → in-progress) and locked it for the plan phase
    expect(feature.lane).not.toBe("design-approval");
    expect(feature.lane).toBe("in-progress");
    expect(feature.locked_at).not.toBeNull();

    // The same feature is re-picked — the loop continues with fy-plan
    expect(sm?.getState()).toBe("working");
    expect(sm?.getCurrentFeatureId()).toBe(featureId);

    const notify = notifications.find((n) => n.message.includes("Activating next feature"));
    expect(notify).toBeDefined();
  });
});

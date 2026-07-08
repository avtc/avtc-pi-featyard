// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerSessionStart } from "../../../src/events/session/session-start.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import kanbanExtension, { resetInstances, setDatabase } from "../../../src/kanban/kanban-bridge.js";
import type { ISessionLifecycle } from "../../../src/shared/workflow-types.js";

/** Minimal lifecycle stub: the orphan-pause flow only exercises the kanban branch, so
 * the state branch (onSessionStart) is a noop. */
const STUB_LIFECYCLE: ISessionLifecycle = {
  async onSessionStart() {},
  async onSessionTree() {},
  performWorkflowReset() {},
};

const ORIGINAL_CWD = process.cwd();
let tempDir: string | null = null;

beforeEach(async () => {
  // Fresh PiCtx so __piCtx.notify binds to this test's notify capture.
  const { PiCtx } = await import("../../../src/shared/types.js");
  globalThis.__piCtx = new PiCtx();
});

afterEach(() => {
  resetInstances();
  if (globalThis.__piCtx) globalThis.__piCtx = undefined;
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

async function setupTestDb() {
  tempDir = mkdtempSync(join(tmpdir(), "kanban-ext-repl-"));
  process.chdir(tempDir);
  const db = await KanbanDatabase.createInMemory();
  const projectId = db.createProject({ name: "test-project", repoPath: tempDir });
  setDatabase(db);
  return { db, projectId };
}

function createFakeApi(): {
  api: ExtensionAPI;
  registeredCommands: Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>;
  eventHandlers: Map<string, (...args: unknown[]) => unknown>;
} {
  const registeredCommands = new Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>();
  const eventHandlers = new Map<string, (...args: unknown[]) => unknown>();

  const api = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      eventHandlers.set(event, handler);
    },
    registerTool() {},
    registerCommand(name: string, definition: { description: string; handler: (...args: unknown[]) => Promise<void> }) {
      registeredCommands.set(name, definition);
    },
    appendEntry() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;

  return { api, registeredCommands, eventHandlers };
}

/** A command ctx whose ui.notify feeds the captured array AND __piCtx (via session_start refresh). */
function makeCtx(notifications: Array<{ message: string; level: string }>): ExtensionCommandContext {
  return {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      onTerminalInput() {
        return () => {};
      },
    },
  } as unknown as ExtensionCommandContext;
}

/** Fire the captured session_start handler with a reason + ctx. */
async function fireSessionStart(
  eventHandlers: Map<string, (...args: unknown[]) => unknown>,
  reason: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const handler = eventHandlers.get("session_start");
  expect(handler).toBeDefined();
  await handler?.({ reason }, ctx);
}

async function startWorker(
  registeredCommands: Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>,
  notifications: Array<{ message: string; level: string }>,
): Promise<void> {
  const startCmd = registeredCommands.get("ff:auto-worker");
  expect(startCmd).toBeDefined();
  await (startCmd as { handler: (args: string, ctx: unknown) => Promise<void> }).handler("", makeCtx(notifications));
}

describe("external session replacement pauses orphaned auto-agent", () => {
  test("external /new pauses a working agent and notifies", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands, eventHandlers } = createFakeApi();
    await (kanbanExtension as (pi: ExtensionAPI) => Promise<void>)(api);
    registerSessionStart(api, STUB_LIFECYCLE);

    db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

    const notifications: Array<{ message: string; level: string }> = [];
    await startWorker(registeredCommands, notifications);

    const sm = globalThis.__piKanban?.autoAgent;
    expect(sm).toBeDefined();
    expect((sm as { getState: () => string }).getState()).toBe("working");

    // External session replacement (manual /new): flag not set → orphaned
    await fireSessionStart(eventHandlers, "new", makeCtx(notifications));

    expect((sm as { getState: () => string }).getState()).toBe("paused");
    const pauseNotify = notifications.find((n) => n.message.includes("Auto-worker paused after manual session change"));
    expect(pauseNotify).toBeDefined();
    expect(pauseNotify?.level).toBe("warning");
    // Re-run hint references the worker command
    expect(pauseNotify?.message).toContain("/ff:auto-worker");
  });

  test("external resume, fork, and reload each pause the agent", async () => {
    for (const reason of ["resume", "fork", "reload"]) {
      resetInstances();
      const { db, projectId } = await setupTestDb();
      const { api, registeredCommands, eventHandlers } = createFakeApi();
      await (kanbanExtension as (pi: ExtensionAPI) => Promise<void>)(api);
      registerSessionStart(api, STUB_LIFECYCLE);

      db.createFeature({ projectId, slug: `feat-${reason}`, title: `Feature ${reason}`, lane: "ready" });

      const notifications: Array<{ message: string; level: string }> = [];
      await startWorker(registeredCommands, notifications);
      const sm = globalThis.__piKanban?.autoAgent;
      expect((sm as { getState: () => string }).getState()).toBe("working");

      await fireSessionStart(eventHandlers, reason, makeCtx(notifications));
      expect((sm as { getState: () => string }).getState()).toBe("paused");
    }
  });

  test("auto-agent-initiated replacement (flag set) does NOT pause", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands, eventHandlers } = createFakeApi();
    await (kanbanExtension as (pi: ExtensionAPI) => Promise<void>)(api);
    registerSessionStart(api, STUB_LIFECYCLE);

    db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

    const notifications: Array<{ message: string; level: string }> = [];
    await startWorker(registeredCommands, notifications);
    const sm = globalThis.__piKanban?.autoAgent;
    expect((sm as { getState: () => string }).getState()).toBe("working");

    // Simulate the agent's own newSession window: flag held high during session_start
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgentInitiatingReplacement = true;
    await fireSessionStart(eventHandlers, "new", makeCtx(notifications));
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgentInitiatingReplacement = false;

    expect((sm as { getState: () => string }).getState()).toBe("working");
    const pauseNotify = notifications.find((n) => n.message.includes("paused after manual session change"));
    expect(pauseNotify).toBeUndefined();
  });

  test("startup reason does not pause (no agent running then, and reason is initial)", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands, eventHandlers } = createFakeApi();
    await (kanbanExtension as (pi: ExtensionAPI) => Promise<void>)(api);
    registerSessionStart(api, STUB_LIFECYCLE);

    db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

    const notifications: Array<{ message: string; level: string }> = [];
    await startWorker(registeredCommands, notifications);
    const sm = globalThis.__piKanban?.autoAgent;
    expect((sm as { getState: () => string }).getState()).toBe("working");

    await fireSessionStart(eventHandlers, "startup", makeCtx(notifications));
    expect((sm as { getState: () => string }).getState()).toBe("working");
    const pauseNotify = notifications.find((n) => n.message.includes("paused after manual session change"));
    expect(pauseNotify).toBeUndefined();
  });

  test("already-paused agent is not re-paused and emits no duplicate notification", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands, eventHandlers } = createFakeApi();
    await (kanbanExtension as (pi: ExtensionAPI) => Promise<void>)(api);
    registerSessionStart(api, STUB_LIFECYCLE);

    db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

    const notifications: Array<{ message: string; level: string }> = [];
    await startWorker(registeredCommands, notifications);
    const sm = globalThis.__piKanban?.autoAgent;
    expect((sm as { getState: () => string }).getState()).toBe("working");

    // First external replacement pauses
    await fireSessionStart(eventHandlers, "new", makeCtx(notifications));
    expect((sm as { getState: () => string }).getState()).toBe("paused");
    const firstCount = notifications.filter((n) => n.message.includes("paused after manual session change")).length;
    expect(firstCount).toBe(1);

    // Second external replacement: already paused → no-op, no new notification
    await fireSessionStart(eventHandlers, "new", makeCtx(notifications));
    expect((sm as { getState: () => string }).getState()).toBe("paused");
    const secondCount = notifications.filter((n) => n.message.includes("paused after manual session change")).length;
    expect(secondCount).toBe(1);
  });

  test("re-running start command resumes the paused agent (fresh command context path)", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands, eventHandlers } = createFakeApi();
    await (kanbanExtension as (pi: ExtensionAPI) => Promise<void>)(api);
    registerSessionStart(api, STUB_LIFECYCLE);

    db.createFeature({ projectId, slug: "feat-1", title: "Feature 1", lane: "ready" });

    const notifications: Array<{ message: string; level: string }> = [];
    await startWorker(registeredCommands, notifications);
    const sm = globalThis.__piKanban?.autoAgent;

    // Orphan + pause
    await fireSessionStart(eventHandlers, "new", makeCtx(notifications));
    expect((sm as { getState: () => string }).getState()).toBe("paused");

    // User re-runs /ff:auto-worker → tryResumePausedAgent unpauses + refreshes __piCtx with fresh ctx
    await startWorker(registeredCommands, notifications);
    expect((sm as { getState: () => string }).getState()).toBe("working");
    const resumeNotify = notifications.find((n) => n.message === "Auto-worker resumed");
    expect(resumeNotify).toBeDefined();
  });
});

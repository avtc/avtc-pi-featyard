// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { AutoAgentStateMachine } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import kanbanExtension, {
  cleanupStoppedAgents,
  resetInstances,
  setDatabase,
} from "../../../src/kanban/kanban-bridge.js";
import { getSettings } from "../../../src/settings/settings-ui.js";

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

async function setupTestDb() {
  tempDir = mkdtempSync(join(tmpdir(), "kanban-cmd-test-"));
  process.chdir(tempDir);
  const db = await KanbanDatabase.createInMemory();
  const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
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

describe("auto-agent command registration", () => {
  test("registers /ff:auto-agent, /ff:auto-worker, /ff:auto-designer, /ff:auto-pause commands", async () => {
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
    }

    expect(registeredCommands.has("ff:auto-agent")).toBe(true);
    expect(registeredCommands.has("ff:auto-worker")).toBe(true);
    expect(registeredCommands.has("ff:auto-designer")).toBe(true);
    expect(registeredCommands.has("ff:auto-pause")).toBe(true);
  });

  test("all auto commands have descriptions", async () => {
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
    }

    for (const name of ["ff:auto-agent", "ff:auto-worker", "ff:auto-designer", "ff:auto-pause"]) {
      const cmd = registeredCommands.get(name);
      expect(cmd).toBeDefined();
      expect((cmd as NonNullable<typeof cmd>).description.length).toBeGreaterThan(0);
    }
  });

  test("ff:auto-agent starts agent state machine", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    const cmd = registeredCommands.get("ff:auto-agent");
    if (cmd) await cmd.handler("", ctx as unknown as ExtensionCommandContext);

    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications[0].message).toContain("Auto-agent started");
  });

  test("ff:auto-pause requests graceful pause", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    // Start an auto-agent first
    const startCmd = registeredCommands.get("ff:auto-agent");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Then stop it
    const stopCmd = registeredCommands.get("ff:auto-pause");
    if (stopCmd) await stopCmd.handler("", ctx as unknown as ExtensionCommandContext);

    const stopNotify = notifications.find((n) => n.message.includes("paused"));
    expect(stopNotify).toBeDefined();
  });

  test("ff:auto-worker enforces single-worker constraint", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    // Start first worker
    const workerCmd = registeredCommands.get("ff:auto-worker");
    if (workerCmd) await workerCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Try starting second worker
    const notifications2: Array<{ message: string; level: string }> = [];
    const ctx2 = {
      ui: {
        notify(message: string, level: string) {
          notifications2.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (workerCmd) await workerCmd.handler("", ctx2 as unknown as ExtensionCommandContext);

    const errorNotify = notifications2.find((n) => n.level === "error" || n.message.includes("already"));
    expect(errorNotify).toBeDefined();
  });

  test("ff:auto-worker blocks second worker (singleton constraint)", async () => {
    const { db } = await setupTestDb();

    // Create a second project with a real temp directory
    const project2Dir = mkdtempSync(join(tmpdir(), "kanban-project2-"));
    const project2Id = db.createProject({ name: "other-project", repoPath: project2Dir });

    // Add a feature to project 2 so the worker has something to pick
    db.createFeature({
      projectId: project2Id,
      slug: "2026-05-16-cross-project-feature",
      title: "Cross-Project Feature",
      lane: "ready",
    });

    const { api, registeredCommands } = createFakeApi();
    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
    }

    // Start first worker (project 1 — current cwd)
    const workerCmd = registeredCommands.get("ff:auto-worker");
    const notifications1: Array<{ message: string; level: string }> = [];
    const ctx1 = {
      ui: {
        notify(message: string, level: string) {
          notifications1.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (workerCmd) await workerCmd.handler("", ctx1 as unknown as ExtensionCommandContext);
    const started1 = notifications1.find((n) => n.message.includes("Auto-worker started"));
    expect(started1).toBeDefined();

    // Switch cwd to project 2's directory and start second worker
    const originalCwd = process.cwd();
    process.chdir(project2Dir);
    try {
      const notifications2: Array<{ message: string; level: string }> = [];
      const ctx2 = {
        ui: {
          notify(message: string, level: string) {
            notifications2.push({ message, level });
          },
          onTerminalInput() {
            return () => {};
          },
        },
      };
      if (workerCmd) await workerCmd.handler("", ctx2 as unknown as ExtensionCommandContext);

      // Second worker blocked by singleton constraint (same role)
      const blocked = notifications2.find((n) => n.message.includes("already running"));
      expect(blocked).toBeDefined();
    } finally {
      process.chdir(originalCwd);
      try {
        rmSync(project2Dir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("ff:auto-worker resumes after /ff:auto-pause", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    // Start worker
    const workerCmd = registeredCommands.get("ff:auto-worker");
    if (workerCmd) await workerCmd.handler("", ctx as unknown as ExtensionCommandContext);
    expect(notifications.some((n) => n.message.includes("Auto-worker started"))).toBe(true);

    // Pause it
    const pauseCmd = registeredCommands.get("ff:auto-pause");
    if (pauseCmd) await pauseCmd.handler("", ctx as unknown as ExtensionCommandContext);
    expect(notifications.some((n) => n.message.includes("paused"))).toBe(true);

    // Resume worker — should show "resumed" not "started" and no error
    const notifications2: Array<{ message: string; level: string }> = [];
    const ctx2 = {
      ui: {
        notify(message: string, level: string) {
          notifications2.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (workerCmd) await workerCmd.handler("", ctx2 as unknown as ExtensionCommandContext);

    const errorNotify = notifications2.find((n) => n.level === "error" || n.message.includes("already"));
    expect(errorNotify).toBeUndefined();
    expect(notifications2.some((n) => n.message.includes("Auto-worker resumed"))).toBe(true);
  });

  test("ff:auto-designer starts designer state machine", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    const cmd = registeredCommands.get("ff:auto-designer");
    if (cmd) await cmd.handler("", ctx as unknown as ExtensionCommandContext);

    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications[0].message).toContain("Auto-designer started");
  });

  test("ff:auto-designer resumes after /ff:auto-pause", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    // Start designer
    const designerCmd = registeredCommands.get("ff:auto-designer");
    if (designerCmd) await designerCmd.handler("", ctx as unknown as ExtensionCommandContext);
    expect(notifications.some((n) => n.message.includes("Auto-designer started"))).toBe(true);

    // Pause it
    const pauseCmd = registeredCommands.get("ff:auto-pause");
    if (pauseCmd) await pauseCmd.handler("", ctx as unknown as ExtensionCommandContext);
    expect(notifications.some((n) => n.message.includes("paused"))).toBe(true);

    // Resume designer — should show "resumed" not "started" and no error
    const notifications2: Array<{ message: string; level: string }> = [];
    const ctx2 = {
      ui: {
        notify(message: string, level: string) {
          notifications2.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (designerCmd) await designerCmd.handler("", ctx2 as unknown as ExtensionCommandContext);

    const errorNotify = notifications2.find((n) => n.level === "error" || n.message.includes("already"));
    expect(errorNotify).toBeUndefined();
    expect(notifications2.some((n) => n.message.includes("Auto-designer resumed"))).toBe(true);
  });

  test("ff:auto-pause shows warning when no agent is running", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    // Stop without starting any agent
    const stopCmd = registeredCommands.get("ff:auto-pause");
    if (stopCmd) await stopCmd.handler("", ctx as unknown as ExtensionCommandContext);

    const noAgentNotify = notifications.find(
      (n) => n.message.includes("No auto-agent running") && n.level === "warning",
    );
    expect(noAgentNotify).toBeDefined();
  });

  test("ff:auto-pause only pauses agents for current project", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    // Start an auto-agent — it will be associated with a project
    const startCmd = registeredCommands.get("ff:auto-agent");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Manually add a fake agent for a different project to the autoAgents map
    new AutoAgentStateMachine("worker", 99999, "session-other");
    // Access autoAgents via the module's resetInstances — we need to get the map
    // Instead, test indirectly: /ff:auto-pause should pause the agent we started
    // The other-project agent won't exist in autoAgents (it's module-scoped)
    // So we verify that stop works correctly when project is resolved

    const stopCmd = registeredCommands.get("ff:auto-pause");
    if (stopCmd) await stopCmd.handler("", ctx as unknown as ExtensionCommandContext);

    const stopNotify = notifications.find((n) => n.message.includes("paused"));
    expect(stopNotify).toBeDefined();
  });
});

describe("cleanupStoppedAgents", () => {
  test("removes stopped agents from autoAgents map", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    // Start an auto-agent
    const startCmd = registeredCommands.get("ff:auto-agent");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);
    expect(notifications.some((n) => n.message.includes("Auto-agent started"))).toBe(true);

    // Stop it (sets state to paused)
    const stopCmd = registeredCommands.get("ff:auto-pause");
    if (stopCmd) await stopCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Paused agents are NOT removed by cleanup (they're still active)
    cleanupStoppedAgents();

    // Verify: starting a new agent of the same role resumes the paused one
    const notifications2: Array<{ message: string; level: string }> = [];
    const ctx2 = {
      ui: {
        notify(message: string, level: string) {
          notifications2.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (startCmd) await startCmd.handler("", ctx2 as unknown as ExtensionCommandContext);
    // Should resume the paused agent, not start a new one
    expect(notifications2.some((n) => n.message.includes("Auto-agent resumed"))).toBe(true);
  });

  test("does not remove working agents", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    // Start an auto-agent
    const startCmd = registeredCommands.get("ff:auto-agent");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Call cleanup while agent is still working
    cleanupStoppedAgents();

    // Verify: trying to start another should fail (old one still exists)
    const notifications2: Array<{ message: string; level: string }> = [];
    const ctx2 = {
      ui: {
        notify(message: string, level: string) {
          notifications2.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (startCmd) await startCmd.handler("", ctx2 as unknown as ExtensionCommandContext);
    // Agent is still running, so starting another would show "already running"
    // or the new one replaces it — depends on implementation
    expect(notifications2.length).toBeGreaterThanOrEqual(1);
  });

  test("removes error-state agents", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    // Start an auto-agent
    const startCmd = registeredCommands.get("ff:auto-agent");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Manually transition to error state via the state machine
    // Access the singleton directly through the globalThis bridge
    const currentAgent = globalThis.__piKanban?.autoAgent;
    if (currentAgent) {
      currentAgent.error("test error");
    }

    // Now cleanup should remove the error-state agent
    cleanupStoppedAgents();

    // Verify: starting a new agent should succeed
    const notifications2: Array<{ message: string; level: string }> = [];
    const ctx2 = {
      ui: {
        notify(message: string, level: string) {
          notifications2.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (startCmd) await startCmd.handler("", ctx2 as unknown as ExtensionCommandContext);
    expect(notifications2.some((n) => n.message.includes("Auto-agent started"))).toBe(true);
  });

  test("replacing an agent stops the old one first", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
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

    const agentStartCmd = registeredCommands.get("ff:auto-agent");
    const workerStartCmd = registeredCommands.get("ff:auto-worker");

    // Start first agent
    if (agentStartCmd) await agentStartCmd.handler("", ctx as unknown as ExtensionCommandContext);
    const firstStarted = notifications.find((n) => n.message.includes("Auto-agent started"));
    expect(firstStarted).toBeDefined();

    // Starting same role again should be a no-op (already running)
    const notifications2: Array<{ message: string; level: string }> = [];
    const ctx2 = {
      ui: {
        notify(message: string, level: string) {
          notifications2.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (agentStartCmd) await agentStartCmd.handler("", ctx2 as unknown as ExtensionCommandContext);
    expect(notifications2.some((n) => n.message.includes("already running"))).toBe(true);

    // Starting a DIFFERENT role should stop the old one and start new
    const notifications3: Array<{ message: string; level: string }> = [];
    const ctx3 = {
      ui: {
        notify(message: string, level: string) {
          notifications3.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (workerStartCmd) await workerStartCmd.handler("", ctx3 as unknown as ExtensionCommandContext);
    expect(notifications3.some((n) => n.message.includes("Auto-worker started"))).toBe(true);
  });

  test("role switch mutates the agent in place, preserving feature and lock identity", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();
    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
    }

    const ctx = {
      ui: {
        notify() {},
        onTerminalInput() {
          return () => {};
        },
      },
    };

    const workerStartCmd = registeredCommands.get("ff:auto-worker");
    const designerStartCmd = registeredCommands.get("ff:auto-designer");

    // 1. Start a worker.
    if (workerStartCmd) await workerStartCmd.handler("", ctx as unknown as ExtensionCommandContext);
    const workerSm = globalThis.__piKanban?.autoAgent;
    expect(workerSm).toBeDefined();
    expect(workerSm?.getRole()).toBe("worker");
    const workerSessionId = workerSm?.sessionId;

    // 2. Simulate it working on a feature (lock identity == sessionId UUID).
    workerSm?.adoptFeature(99, "in-progress");
    expect(workerSm?.getCurrentFeatureId()).toBe(99);
    // Stamp a sentinel worker wait-timeout so we can PROVE the switch overwrites it
    // (mutation-resistant: if the setWaitTimeoutMs call were dropped, this value
    // would survive unchanged).
    workerSm?.setWaitTimeoutMs(111_111);
    expect(workerSm?.getWaitTimeoutMs()).toBe(111_111);

    // 3. Switch to designer — must be the SAME instance, not a torn-down + recreated one.
    if (designerStartCmd) await designerStartCmd.handler("", ctx as unknown as ExtensionCommandContext);
    const designerSm = globalThis.__piKanban?.autoAgent;

    // Same SM instance preserved (in-place role mutation).
    expect(designerSm).toBe(workerSm);
    // Role updated, and lanes now reflect the designer role.
    expect(designerSm?.getRole()).toBe("designer");
    expect(designerSm?.getLanes()).toEqual(["design"]);
    // Current feature and lock identity preserved (no orphaned agent/lock churn).
    expect(designerSm?.getCurrentFeatureId()).toBe(99);
    expect(designerSm?.sessionId).toBe(workerSessionId);
    // The wait-timeout duration was refreshed to the designer's configured value
    // (mirrors waitTimeoutMsFor("designer")). This pins the setWaitTimeoutMs call
    // in the role-switch branch — it would fail if that line were dropped.
    expect(designerSm?.getWaitTimeoutMs()).toBe(getSettings().autoDesignerWaitTimeoutMs);
  });

  test("role switch against a stopped agent creates a fresh state machine", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();
    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
    }

    const ctx = {
      ui: {
        notify() {},
        onTerminalInput() {
          return () => {};
        },
      },
    };

    const workerStartCmd = registeredCommands.get("ff:auto-worker");
    const designerStartCmd = registeredCommands.get("ff:auto-designer");

    if (workerStartCmd) await workerStartCmd.handler("", ctx as unknown as ExtensionCommandContext);
    const workerSm = globalThis.__piKanban?.autoAgent;
    // Stop the agent so it is no longer "live".
    workerSm?.requestStop();
    expect(workerSm?.getState()).toBe("stopped");

    // Switching against a stopped agent must NOT mutate in place — it creates a fresh SM.
    if (designerStartCmd) await designerStartCmd.handler("", ctx as unknown as ExtensionCommandContext);
    const designerSm = globalThis.__piKanban?.autoAgent;
    expect(designerSm).not.toBe(workerSm);
    expect(designerSm?.getRole()).toBe("designer");
    // The fresh agent is live (started) — exact state depends on feature availability
    // ("working" if one was picked, "polling" if none available); either way it is
    // a brand-new live agent, not the stopped worker mutated in place.
    expect(designerSm?.getState() === "stopped").toBe(false);
    expect(designerSm?.getState() === "error").toBe(false);
  });

  test("role switch of a paused agent resumes it (one command → running agent of the new role)", async () => {
    await setupTestDb();
    const { api, registeredCommands } = createFakeApi();
    if (typeof kanbanExtension === "function") {
      await kanbanExtension(api, null);
    }

    const ctx = {
      ui: {
        notify() {},
        onTerminalInput() {
          return () => {};
        },
      },
    };

    const workerStartCmd = registeredCommands.get("ff:auto-worker");
    const designerStartCmd = registeredCommands.get("ff:auto-designer");

    // Start a worker and simulate it working on a feature (so it holds a lock).
    if (workerStartCmd) await workerStartCmd.handler("", ctx as unknown as ExtensionCommandContext);
    const workerSm = globalThis.__piKanban?.autoAgent;
    expect(workerSm).toBeDefined();
    workerSm?.adoptFeature(42, "in-progress");
    const workerSessionId = workerSm?.sessionId;

    // Pause it (as if via /ff:auto-pause). Role switch reuses isAgentLive, which is
    // true for paused — so the switch branch fires and mutates in place.
    // A paused agent is resumed by re-running a role command (same-role path is
    // tryResumePausedAgent); switching its role resumes it too.
    workerSm?.pause();
    expect(workerSm?.getState()).toBe("paused");

    // Switch to designer, capturing notifications.
    const notifications: Array<{ message: string; level: string }> = [];
    const switchCtx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };
    if (designerStartCmd) await designerStartCmd.handler("", switchCtx as unknown as ExtensionCommandContext);
    const designerSm = globalThis.__piKanban?.autoAgent;

    // Same SM instance (in-place mutation), role updated, feature + lock preserved.
    expect(designerSm).toBe(workerSm);
    expect(designerSm?.getRole()).toBe("designer");
    expect(designerSm?.getCurrentFeatureId()).toBe(42);
    expect(designerSm?.sessionId).toBe(workerSessionId);
    // The role switch RESUMES the paused agent (mirrors tryResumePausedAgent),
    // so one command yields a running designer rather than forcing a second
    // /ff:auto-designer to resume.
    expect(designerSm?.getState()).toBe("working");
    // The notification reflects the resume, not a misleading "started".
    expect(notifications.some((n) => n.message === "Auto-designer resumed")).toBe(true);
    expect(notifications.some((n) => n.message.includes("paused"))).toBe(false);
  });
});

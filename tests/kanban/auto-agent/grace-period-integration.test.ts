// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import kanbanExtension, {
  cleanupStoppedAgents,
  resetInstances,
  setDatabase,
} from "../../../src/kanban/kanban-bridge.js";
import { createKanbanTurnHandlers } from "../../../src/kanban/kanban-turn-handlers.js";
import { setSetting, setTestSettings } from "../../helpers/settings-test-helpers.js";

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
  tempDir = mkdtempSync(join(tmpdir(), "kanban-grace-test-"));
  process.chdir(tempDir);
  const db = await KanbanDatabase.createInMemory();
  const projectId = db.createProject({ name: "test-project", repoPath: tempDir });
  setDatabase(db);
  // Initialize PiCtx for stashSessionFns replacement
  if (!globalThis.__piCtx) {
    const { PiCtx } = await import("../../../src/shared/types.js");
    globalThis.__piCtx = new PiCtx();
  }
  return { db, projectId };
}

function createFakeApi(): {
  api: ExtensionAPI;
  registeredCommands: Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>;
  eventHandlers: Map<string, (...args: unknown[]) => void>;
} {
  const registeredCommands = new Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>();
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();

  const api = {
    on(event: string, handler: (...args: unknown[]) => void) {
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

describe("Grace period integration", () => {
  beforeEach(() => {
    setTestSettings(null);
  });
  test("onFeatureComplete creates GracePeriodManager for design→design-approval", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Create a design feature
    db.createFeature({
      projectId,
      slug: "test-design-feature",
      title: "Test Design Feature",
      lane: "design",
    });

    // Create a second feature for grace period to pick after expiry
    db.createFeature({
      projectId,
      slug: "test-design-feature-2",
      title: "Test Design Feature 2",
      lane: "design",
    });

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

    // Start designer agent
    const startCmd = registeredCommands.get("ff:auto-designer");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Verify agent is working (picked the feature)
    const sm = globalThis.__piKanban?.autoAgent;
    expect(sm).toBeDefined();
    expect(sm?.getState()).toBe("working");

    // Call the onFeatureComplete callback (simulates workflow-monitor completing the feature)
    const callback = globalThis.__piKanban?.autoAgentCallback;
    expect(callback).toBeDefined();
    await callback?.onFeatureComplete("test-design-feature");

    // Verify grace period manager was created
    const gpm = globalThis.__piKanban?.gracePeriod;
    expect(gpm).toBeDefined();
    expect(gpm?.isActive()).toBe(true);

    // Verify agent entered grace-period state
    expect(sm?.getState()).toBe("grace-period");

    // Verify notification was sent
    const graceNotify = notifications.find((n) => n.message.includes("30s"));
    expect(graceNotify).toBeDefined();
  });

  test("GracePeriodManager onExpired activates next feature", async () => {
    vi.useFakeTimers();

    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Create two design features
    db.createFeature({
      projectId,
      slug: "feat-1",
      title: "Feature 1",
      lane: "design",
    });
    db.createFeature({
      projectId,
      slug: "feat-2",
      title: "Feature 2",
      lane: "design",
    });

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

    // Start designer and let it pick feat-1
    const startCmd = registeredCommands.get("ff:auto-designer");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Complete feat-1 → enters grace period
    const callback = globalThis.__piKanban?.autoAgentCallback;
    await callback?.onFeatureComplete("feat-1");

    const _bridge = globalThis.__piKanban;
    const sm = _bridge ? _bridge.autoAgent : null;
    expect(sm?.getState()).toBe("grace-period");

    // Advance past grace period (30s) — onExpired fires
    await vi.advanceTimersByTimeAsync(31_000);

    // Verify agent is now working on feat-2
    expect(sm?.getState()).toBe("working");

    // Verify feat-2 was actually picked
    const feat2 = db.findFeatureBySlug("feat-2", projectId);
    expect(feat2).not.toBeNull();
    expect(sm?.getCurrentFeatureId()).toBe((feat2 as NonNullable<typeof feat2>).id);

    // Verify feat-1 was moved to design-approval
    const feat1 = db.findFeatureBySlug("feat-1", projectId);
    expect((feat1 as NonNullable<typeof feat1>).lane).toBe("design-approval");

    // Verify notification about grace period ending
    const expiredNotify = notifications.find((n) => n.message.includes("Grace period ended"));
    expect(expiredNotify).toBeDefined();

    vi.useRealTimers();
  });

  test("onTerminalInput handler resets grace period timer", async () => {
    vi.useFakeTimers();

    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Create two features
    db.createFeature({
      projectId,
      slug: "feat-1",
      title: "Feature 1",
      lane: "design",
    });
    db.createFeature({
      projectId,
      slug: "feat-2",
      title: "Feature 2",
      lane: "design",
    });

    let capturedHandler: TerminalInputHandler | null = null;
    const ctx = {
      ui: {
        notify() {},
        onTerminalInput(handler: TerminalInputHandler) {
          capturedHandler = handler;
          return () => {};
        },
      },
    };

    // Start designer
    const startCmd = registeredCommands.get("ff:auto-designer");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Complete feat-1 → enters grace period
    const callback = globalThis.__piKanban?.autoAgentCallback;
    await callback?.onFeatureComplete("feat-1");

    const gpm = globalThis.__piKanban?.gracePeriod;
    expect(gpm).toBeDefined();

    // Advance 20 seconds (10s remaining)
    vi.advanceTimersByTime(20_000);
    expect(gpm?.getRemainingSeconds()).toBe(10);

    // Simulate terminal input (user activity)
    if (capturedHandler) (capturedHandler as TerminalInputHandler)("");

    // Timer should have been reset to 30s
    expect(gpm?.getRemainingSeconds()).toBe(30);

    vi.useRealTimers();
  });

  test("turn_start/turn_end events pause/resume grace period", async () => {
    vi.useFakeTimers();

    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    db.createFeature({
      projectId,
      slug: "feat-1",
      title: "Feature 1",
      lane: "design",
    });
    db.createFeature({
      projectId,
      slug: "feat-2",
      title: "Feature 2",
      lane: "design",
    });

    const ctx = {
      ui: {
        notify() {},
        onTerminalInput() {
          return () => {};
        },
      },
    };

    // Start designer
    const startCmd = registeredCommands.get("ff:auto-designer");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Complete feat-1 → enters grace period
    const callback = globalThis.__piKanban?.autoAgentCallback;
    await callback?.onFeatureComplete("feat-1");

    const gpm = globalThis.__piKanban?.gracePeriod;
    expect(gpm).toBeDefined();

    // Advance 10 seconds
    vi.advanceTimersByTime(10_000);
    expect(gpm?.getRemainingSeconds()).toBe(20);

    // turn_start/turn_end handlers live in the kanban turn-handlers domain object
    // (registered via events/agent/ in the full extension). Test them directly.
    const turnHandlers = createKanbanTurnHandlers(() => {});

    // Simulate turn_start — should pause GPM
    turnHandlers.onTurnStart();

    // Advance 15 more seconds — should NOT count down (paused)
    vi.advanceTimersByTime(15_000);
    expect(gpm?.getRemainingSeconds()).toBe(20); // Still 20 (paused)

    // Simulate turn_end — should resume and reset timer
    turnHandlers.onTurnEnd({} as unknown as ExtensionCommandContext);

    // Timer should be reset to 30s by turn_end's onUserActivity
    expect(gpm?.getRemainingSeconds()).toBe(30);

    vi.useRealTimers();
  });

  test("cleanupStoppedAgents stops GracePeriodManager", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    db.createFeature({
      projectId,
      slug: "feat-1",
      title: "Feature 1",
      lane: "design",
    });
    db.createFeature({
      projectId,
      slug: "feat-2",
      title: "Feature 2",
      lane: "design",
    });

    const ctx = {
      ui: {
        notify() {},
        onTerminalInput() {
          return () => {};
        },
      },
    };

    // Start designer
    const startCmd = registeredCommands.get("ff:auto-designer");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Complete feat-1 → enters grace period
    const callback = globalThis.__piKanban?.autoAgentCallback;
    await callback?.onFeatureComplete("feat-1");

    const gpm = globalThis.__piKanban?.gracePeriod;
    expect(gpm).toBeDefined();
    expect(gpm?.isActive()).toBe(true);

    // Stop the agent
    const _bridge = globalThis.__piKanban;
    const sm = _bridge ? _bridge.autoAgent : null;
    sm?.requestStop();

    // Run cleanup
    cleanupStoppedAgents();

    // GPM should be stopped
    expect(gpm?.isActive()).toBe(false);
  });

  test("currentFeatureLane null guard falls back to polling", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    db.createFeature({
      projectId,
      slug: "feat-null-lane",
      title: "Feature",
      lane: "design",
    });

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
    const startCmd = registeredCommands.get("ff:auto-designer");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Force currentFeatureLane to null to test the guard
    const _bridge = globalThis.__piKanban;
    const sm = _bridge ? _bridge.autoAgent : null;
    (sm as unknown as Record<string, unknown>).currentFeatureLane = null;

    // Call onFeatureComplete — should not crash, should fall back to polling
    const callback = globalThis.__piKanban?.autoAgentCallback;
    await callback?.onFeatureComplete("feat-null-lane");

    // Should be in polling state (graceful fallback)
    expect(sm?.getState()).toBe("polling");
  });

  test("Point B: design→ready triggers newSession and polling (no design-approval)", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    // Disable design-approval so design features go directly to ready
    setTestSettings(null);
    setSetting("designApprovalEnabled", false);

    try {
      const extension = kanbanExtension;
      if (typeof extension === "function") {
        await extension(api, null);
      }

      // Create a single design feature (no next feature after it)
      db.createFeature({
        projectId,
        slug: "design-feat",
        title: "Design Feature",
        lane: "design",
      });

      const notifications: Array<{ message: string; level: string }> = [];
      let newSessionCalled = false;
      const ctx = {
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
          onTerminalInput() {
            return () => {};
          },
        },
        newSession: async (opts?: { withSession?: (ctx: unknown) => Promise<void> }) => {
          newSessionCalled = true;
          // Simulate withSession callback
          if (opts?.withSession) {
            await opts.withSession({ sessionFile: "/fake/new-session.md" });
          }
          return { cancelled: false };
        },
      };

      // Start designer agent
      const startCmd = registeredCommands.get("ff:auto-designer");
      if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

      // Verify agent is working
      const sm = globalThis.__piKanban?.autoAgent;
      expect(sm?.getState()).toBe("working");

      // Complete the design feature — should trigger Point B (design→ready, no next feature)
      const callback = globalThis.__piKanban?.autoAgentCallback;
      await callback?.onFeatureComplete("design-feat");

      // Verify feature moved to ready lane
      const feature = db.findFeatureBySlug("design-feat", projectId);
      expect(feature).toBeDefined();
      expect((feature as NonNullable<typeof feature>).lane).toBe("ready");

      // Verify newSession was called
      expect(newSessionCalled).toBe(true);

      // Verify notification mentions ready
      const readyNotify = notifications.find((n) => n.message.includes("ready"));
      expect(readyNotify).toBeDefined();

      // Verify notification mentions polling
      const pollNotify = notifications.find((n) => n.message.includes("polling") || n.message.includes("Polling"));
      expect(pollNotify).toBeDefined();
    } finally {
      // Restore settings
      setTestSettings(null);
      setSetting("designApprovalEnabled", true);
    }
  });

  test("Point B fallback: design→ready when newSession unavailable", async () => {
    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    // Disable design-approval
    setTestSettings(null);
    setSetting("designApprovalEnabled", false);

    try {
      const extension = kanbanExtension;
      if (typeof extension === "function") {
        await extension(api, null);
      }

      // Create a single design feature
      db.createFeature({
        projectId,
        slug: "design-feat-no-ns",
        title: "Design Feature No NewSession",
        lane: "design",
      });

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
        // No newSession — simulates non-interactive mode
      };

      // Start designer agent
      const startCmd = registeredCommands.get("ff:auto-designer");
      if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

      // Complete the feature — Point B with no newSession
      const callback = globalThis.__piKanban?.autoAgentCallback;
      await callback?.onFeatureComplete("design-feat-no-ns");

      // Verify feature moved to ready
      const feature = db.findFeatureBySlug("design-feat-no-ns", projectId);
      expect((feature as NonNullable<typeof feature>).lane).toBe("ready");

      // Verify fallback notification (no new session, just polling)
      const fallbackNotify = notifications.find((n) => n.message.includes("ready") && n.message.includes("polling"));
      expect(fallbackNotify).toBeDefined();
    } finally {
      // Restore settings
      setTestSettings(null);
      setSetting("designApprovalEnabled", true);
    }
  });

  test("onExpired guard prevents activation when agent is paused", async () => {
    vi.useFakeTimers();

    const { db, projectId } = await setupTestDb();
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    db.createFeature({
      projectId,
      slug: "feat-1",
      title: "Feature 1",
      lane: "design",
    });
    db.createFeature({
      projectId,
      slug: "feat-2",
      title: "Feature 2",
      lane: "design",
    });

    const ctx = {
      ui: {
        notify() {},
        onTerminalInput() {
          return () => {};
        },
      },
    };

    // Start designer and let it pick feat-1
    const startCmd = registeredCommands.get("ff:auto-designer");
    if (startCmd) await startCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Complete feat-1 → enters grace period
    const callback = globalThis.__piKanban?.autoAgentCallback;
    await callback?.onFeatureComplete("feat-1");

    const _bridge = globalThis.__piKanban;
    const sm = _bridge ? _bridge.autoAgent : null;
    expect(sm?.getState()).toBe("grace-period");

    // Pause the agent (simulates user /ff:auto-pause during grace period)
    // This changes state away from grace-period
    sm?.pause();
    expect(sm?.getState()).toBe("paused");

    // Advance past grace period — onExpired should fire but guard prevents activation
    await vi.advanceTimersByTimeAsync(31_000);

    // Agent should still be paused, NOT working on feat-2
    expect(sm?.getState()).toBe("paused");

    vi.useRealTimers();
  });
});

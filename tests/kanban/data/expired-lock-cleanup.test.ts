// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { interactiveSessionIdFor, KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import kanbanExtension, { resetInstances, setDatabase } from "../../../src/kanban/kanban-bridge.js";

let tempDir: string | null = null;
const originalCwd = process.cwd();

afterEach(async () => {
  resetInstances();
  process.chdir(originalCwd);
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    tempDir = null;
  }
});

async function setupTestDb() {
  tempDir = mkdtempSync(join(tmpdir(), "kanban-cleanup-test-"));
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
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;

  return { api, registeredCommands };
}

describe("expired lock cleanup on feature activation", () => {
  test("cleans up expired locks when auto-agent picks a feature", async () => {
    const { db, projectId } = await setupTestDb();

    const { api, registeredCommands } = createFakeApi();
    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Create a feature in ready lane
    db.createFeature({
      projectId,
      slug: "2026-05-17-ready-feature",
      title: "Ready Feature",
      lane: "ready",
    });

    // Create an expired lock on a different feature (simulating crashed agent)
    const expiredFeatureId = db.createFeature({
      projectId,
      slug: "2026-05-17-expired-feature",
      title: "Expired Feature",
      lane: "in-progress",
    });
    db.lockFeature(expiredFeatureId, "old-session");

    // Manually backdate the lock's last_heartbeat to simulate expiry
    const expiredTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.rawExec("UPDATE feature_locks SET last_heartbeat = ? WHERE feature_id = ?", [expiredTime, expiredFeatureId]);

    // Verify expired lock exists before activation
    const expiredBefore = db.getFeature(expiredFeatureId);
    expect(expiredBefore?.locked_at).toBeTruthy();

    // Start auto-worker — this triggers the full flow including activateFeature
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
      actions: {
        exec: () => Promise.reject(new Error("no git")), // triggers catch in resolveMainRepoPath
      },
    };

    const workerCmd = registeredCommands.get("ff:auto-worker");
    if (workerCmd) await workerCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // The auto-worker started
    const expiredAfter = db.getFeature(expiredFeatureId);
    expect(expiredAfter?.locked_at).toBeNull();
  });

  test("does not clean up fresh locks when auto-agent picks a feature", async () => {
    const { db, projectId } = await setupTestDb();

    const { api, registeredCommands } = createFakeApi();
    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    // Create a feature in ready lane
    db.createFeature({
      projectId,
      slug: "2026-05-17-ready-feature-2",
      title: "Ready Feature 2",
      lane: "ready",
    });

    // Create a fresh lock on another feature (should NOT be cleaned)
    const freshFeatureId = db.createFeature({
      projectId,
      slug: "2026-05-17-fresh-feature",
      title: "Fresh Feature",
      lane: "in-progress",
    });
    db.lockFeature(freshFeatureId, "active-session");

    const freshBefore = db.getFeature(freshFeatureId);
    expect(freshBefore?.locked_at).toBeTruthy();

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
      actions: {
        exec: () => Promise.reject(new Error("no git")),
      },
    };

    const workerCmd = registeredCommands.get("ff:auto-worker");
    if (workerCmd) await workerCmd.handler("", ctx as unknown as ExtensionCommandContext);

    // Fresh lock should still exist
    const freshAfter = db.getFeature(freshFeatureId);
    expect(freshAfter?.locked_at).toBeTruthy();
  });

  test("does not sweep interactive locks (session:slug) even when heartbeat is stale", async () => {
    const { db, projectId } = await setupTestDb();

    // Two features with backdated locks: one auto-agent (UUID), one interactive (session:slug).
    const agentFeatureId = db.createFeature({
      projectId,
      slug: "2026-05-17-agent-locked",
      title: "Agent Locked",
      lane: "in-progress",
    });
    const interactiveFeatureId = db.createFeature({
      projectId,
      slug: "2026-05-17-interactive-locked",
      title: "Interactive Locked",
      lane: "in-progress",
    });
    db.lockFeature(agentFeatureId, "11111111-1111-1111-1111-111111111111");
    db.lockFeature(interactiveFeatureId, "session:2026-05-17-interactive-locked");

    // Backdate both heartbeats well past the sweep threshold (31 min).
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.rawExec("UPDATE feature_locks SET last_heartbeat = ? WHERE feature_id IN (?, ?)", [
      stale,
      agentFeatureId,
      interactiveFeatureId,
    ]);

    // cleanupExpiredLocks should sweep the UUID (auto-agent) lock but NOT the
    // interactive (session:*) lock. Interactive locks persist until explicitly
    // released or reassigned, so a user who steps away (or whose pi crashes)
    // never has their feature stolen by another auto-agent.
    const removed = db.cleanupExpiredLocks(30 * 60 * 1000);
    expect(removed).toBe(1);

    expect(db.getFeature(agentFeatureId)?.locked_at).toBeNull();
    expect(db.getFeature(interactiveFeatureId)?.locked_at).toBeTruthy();
    expect(db.getFeature(interactiveFeatureId)?.locked_by_session).toBe("session:2026-05-17-interactive-locked");
  });

  test("a UUID lock reassigned to session:slug survives the sweeper end-to-end", async () => {
    const { db, projectId } = await setupTestDb();

    // Two features, both initially locked by auto-agents under UUID identities.
    const reassignedFeatureId = db.createFeature({
      projectId,
      slug: "2026-05-17-reassigned",
      title: "Reassigned",
      lane: "in-progress",
    });
    const controlFeatureId = db.createFeature({
      projectId,
      slug: "2026-05-17-uuid-control",
      title: "UUID Control",
      lane: "in-progress",
    });
    const agentUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const controlUuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    db.lockFeature(reassignedFeatureId, agentUuid);
    db.lockFeature(controlFeatureId, controlUuid);

    // /ff:auto-stop reassigns the agent-held lock to the interactive identity
    // (session:<slug>) so it persists without a heartbeat.
    const interactiveSession = interactiveSessionIdFor("2026-05-17-reassigned");
    expect(db.reassignLock(reassignedFeatureId, agentUuid, interactiveSession)).toBe(true);
    expect(db.getFeature(reassignedFeatureId)?.locked_by_session).toBe(interactiveSession);

    // Backdate BOTH heartbeats well past the sweep threshold (31 min).
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.rawExec("UPDATE feature_locks SET last_heartbeat = ? WHERE feature_id IN (?, ?)", [
      stale,
      reassignedFeatureId,
      controlFeatureId,
    ]);

    // Composed invariant (requirement #1): the reassigned session:<slug> lock
    // SURVIVES cleanupExpiredLocks while the UUID control lock is swept.
    const removed = db.cleanupExpiredLocks(30 * 60 * 1000);
    expect(removed).toBe(1);

    expect(db.getFeature(reassignedFeatureId)?.locked_at).toBeTruthy();
    expect(db.getFeature(reassignedFeatureId)?.locked_by_session).toBe(interactiveSession);
    expect(db.getFeature(controlFeatureId)?.locked_at).toBeNull();
  });
});

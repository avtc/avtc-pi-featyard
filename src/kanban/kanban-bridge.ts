// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoAgent } from "../commands/auto-agent-commands.js";
import {
  getSharedServer,
  NO_SHARED_SERVER,
  registerKanbanCommands,
  setSharedServer,
} from "../commands/kanban-commands.js";
import { log } from "../log.js";
import type { PiKanbanBridge } from "../shared/types.js";
import { registerAddToBacklogTool } from "../tools/add-to-backlog.js";
import { cleanupStoppedAgents as _cleanupStoppedAgents } from "./auto-agent/auto-agent-cleanup.js";
import { KanbanDatabase } from "./data/kanban-database.js";
import type { CapturedModelRef, KanbanContext } from "./kanban-context.js";
import { registerKanbanEvents } from "./kanban-events.js";
import { KanbanTools } from "./kanban-operations.js";

/** Shared model registry ref for generate-title/generate-topic (replaces globalThis.globalThis.__piKanban.model) */
export const _kanbanModelRef: CapturedModelRef = {};

// globalThis keys for cross-module-instance shared state.
// Pi loads each extension with jiti moduleCache:false, so a newSession()/switchSession()
// reloads extensions and creates a fresh module instance. Using globalThis.__piKanban ensures state
// survives extension reloads — the running agent's timers, heartbeat, database connections,
// and state are preserved across session boundaries.

/** Ensure the kanban bridge exists on globalThis */
function ensureBridge(): PiKanbanBridge {
  if (!globalThis.__piKanban) {
    globalThis.__piKanban = {
      autoAgent: null,
      autoAgentCallback: undefined,
      autoAgentInitiatingReplacement: undefined,
      database: null,
      tools: null,
      activateFeature: undefined,
      createGracePeriodManager: undefined,
      terminalInputUnsubscribe: null,
      gracePeriod: undefined,
    };
  }
  return globalThis.__piKanban;
}

const _bridge = ensureBridge();
const autoAgent = _bridge.autoAgent;

/** Request widget re-render from workflow-monitor. No-op if not available.
 *  Uses optional chaining because kanban may be loaded in tests without workflow-monitor.
 *  In production, workflow-monitor factory initializes __piWorkflowMonitor before kanban runs. */
function requestWidgetUpdate(): void {
  globalThis.__piWorkflowMonitor?.requestWidgetUpdate();
}

/** Remove stopped/error agent reference so it doesn't block new agents. */
export function cleanupStoppedAgents(): void {
  _cleanupStoppedAgents();
}

async function getDatabase(): Promise<KanbanDatabase> {
  const shared = globalThis.__piKanban?.database;
  if (shared) return shared;
  // In test environments, a missing shared DB means the test forgot to call
  // setDatabaseInstance() or setDatabase() — fail loudly instead of silently
  // creating a production database at ~/.pi/kanban/kanban.db.
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    throw new Error(
      "[kanban] getDatabase() called without a shared instance in test environment. " +
        "Call setDatabaseInstance(db) or setDatabase(db) before exercising this code path.",
    );
  }
  const dataDir = join(homedir(), ".pi", "featyard", "kanban");
  const instance = await KanbanDatabase.create(dataDir);
  ensureBridge();
  (globalThis.__piKanban as PiKanbanBridge).database = instance;
  return instance;
}

async function getTools(): Promise<KanbanTools> {
  const shared = globalThis.__piKanban?.tools;
  if (shared) return shared;
  const instance = new KanbanTools(await getDatabase());
  ensureBridge();
  (globalThis.__piKanban as PiKanbanBridge).tools = instance;
  return instance;
}

export function resetInstances(): void {
  const sharedDb = globalThis.__piKanban?.database;
  if (sharedDb) {
    try {
      sharedDb.close();
    } catch (e) {
      log.error("[kanban] failed to close database", e);
    }
  }
  const sharedServer = getSharedServer();
  if (sharedServer) {
    try {
      sharedServer.server.close();
    } catch (e) {
      log.error("[kanban] failed to close server", e);
    }
  }
  if (globalThis.__piKanban) {
    globalThis.__piKanban.database = null;
    globalThis.__piKanban.tools = null;
  }
  setSharedServer(NO_SHARED_SERVER);
  // Stop running agent (timers, heartbeat) before clearing the shared globalThis reference.
  // Tests call resetInstances() in afterEach for isolation between test cases.
  if (autoAgent) {
    autoAgent.stopHeartbeat();
    autoAgent.stopPollingTimer();
    autoAgent.stopWaitTimeout();
  }
  if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = null;
  if (globalThis.__piKanban) {
    globalThis.__piKanban.activateFeature = undefined;
    // Stop GPM timer before clearing reference to prevent stale setInterval
    const gpm = globalThis.__piKanban.gracePeriod as { stop?: () => void } | undefined;
    if (gpm) gpm.stop?.();
    globalThis.__piKanban.gracePeriod = undefined;
    globalThis.__piKanban.createGracePeriodManager = undefined;
    globalThis.__piKanban.terminalInputUnsubscribe = null;
  }
  // Note: workflow-monitor bridge (__piWorkflowMonitor) is NOT reset here —
  // kanban does not own that state. Tests needing both reset should call
  // workflow-monitor's resetInstances separately.
}

/** @internal Test helper to inject a mock database */
export function setDatabase(mockDb: KanbanDatabase | null): void {
  ensureBridge();
  (globalThis.__piKanban as PiKanbanBridge).database = mockDb;
}

/** @internal Get the current database instance (for cross-extension access) */
export function getDatabaseInstance(): KanbanDatabase | null {
  return globalThis.__piKanban?.database ?? null;
}

/** Ensure the kanban database is initialized and return it. Never returns null. */
export async function ensureDatabase(): Promise<KanbanDatabase> {
  return getDatabase();
}

/** @internal Set database instance (for testing) */
export function setDatabaseInstance(instance: KanbanDatabase): void {
  ensureBridge();
  (globalThis.__piKanban as PiKanbanBridge).database = instance;
}

/** @internal Set shared server info (for testing) */
export function setSharedServerInstance(info: { server: Server; port: number; authToken: string } | null): void {
  setSharedServer(info);
}

/** @internal Get shared server info (for testing) */
export function getSharedServerInstance(): { server: Server; port: number; authToken: string } | null {
  return getSharedServer();
}

export interface KanbanExtensionDeps {
  activateWorkflowForFeature: (
    slug: string,
    phase: import("../phases/phase-progression.js").Phase,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionContext | null,
  ) => Promise<void>;
  resumeWorkflowForFeature: (
    slug: string,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionContext | null,
  ) => Promise<import("../state/feature-state.js").FeatureState | null>;
  setWorkflowInitiatedNewSession: (message: string | null) => void;
}

/** Default log level for notifications */
export const DEFAULT_NOTIFY_LEVEL: "info" | "warning" | "error" = "info";

export default async function kanbanExtension(pi: ExtensionAPI, deps: KanbanExtensionDeps | null): Promise<void> {
  /** Notify via stashed globalThis function (for timer/callback contexts without ctx). */
  function notify(msg: string, level: "info" | "warning" | "error"): void {
    globalThis.__piCtx?.notify(msg, level);
  }

  const ctx: KanbanContext = {
    autoAgent,
    getDatabase,
    getTools,
    notify,
    requestWidgetUpdate,
    capturedModelRef: _kanbanModelRef,
    activateWorkflowForFeature: deps?.activateWorkflowForFeature ?? (() => Promise.resolve()),
    resumeWorkflowForFeature: deps?.resumeWorkflowForFeature ?? (() => Promise.resolve(null)),
    setWorkflowInitiatedNewSession: deps?.setWorkflowInitiatedNewSession ?? (() => {}),
  };

  // Register event handlers (session_start, turn_start, turn_end, model_select, tool_result)
  registerKanbanEvents(pi, ctx);

  // Register UI commands (/fy:kanban, /fy:kanban-release) + add_to_backlog tool
  registerKanbanCommands(pi, ctx);
  registerAddToBacklogTool(pi, ctx);

  // Register auto-agent commands (/fy:auto-agent, /fy:auto-worker, /fy:auto-designer, /fy:auto-pause)
  // + startAutoAgent + _activateFeature + polling/grace-period + callbacks
  await registerAutoAgent(pi, ctx);

  log.info("kanban extension registered");
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../../src/index.js";
import { GracePeriodManager } from "../../../src/kanban/auto-agent/auto-agent-grace-period.js";
import {
  AutoAgentStateMachine,
  getAutoAgentCallback,
  setAutoAgentCallback,
} from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { KanbanDatabase } from "../../../src/kanban/data/kanban-database.js";
import { resetInstances, setDatabase } from "../../../src/kanban/kanban-bridge.js";
import {
  createFakePi,
  fireAllHandlers,
  NO_DATABASE,
  writeFeatureStateFile,
} from "../../helpers/workflow-monitor-test-helpers.js";

describe("fy:auto-stop command", () => {
  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    // Clear any kanban bridge auto-agent left by a test
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = null;
    resetInstances();
  });

  test("clears auto-agent callback and injects skill for active feature", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Set up feature state with active feature in execute phase
    writeFeatureStateFile("test-feature", {
      featureSlug: "test-feature",
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {},
      },
    });

    // Use env var to activate the feature
    process.env.PI_FY_FEATURE = "test-feature";
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "reload" },
      {
        hasUI: true,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
        ui: { setWidget: () => {}, notify: vi.fn() },
      },
    );

    // Set up an auto-agent callback to verify it gets cleared
    const mockCallback = { onFeatureComplete: vi.fn(), onFeatureError: vi.fn() };
    setAutoAgentCallback(mockCallback);

    // Get the registered command handler
    const handler = fake.registeredCommands.get("fy:auto-stop");
    expect(handler).toBeDefined();

    const notify = vi.fn();
    const ctx = { hasUI: true, ui: { notify, setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    await (handler as (args: string[], ctx: ExtensionCommandContext) => Promise<void>)([], ctx);

    // Auto-agent callback should be cleared
    expect(getAutoAgentCallback()).toBeNull();

    // Should have notified user
    expect(notify).toHaveBeenCalled();

    // /fy:auto-stop intentionally does NOT re-dispatch the phase skill — control returns
    // to the user with no followup message.
    expect(fake.sentMessages.length).toBe(0);
  });

  test("notifies when no active feature", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const handler = fake.registeredCommands.get("fy:auto-stop");
    expect(handler).toBeDefined();

    const notify = vi.fn();
    const ctx = { hasUI: true, ui: { notify, setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    await (handler as (args: string[], ctx: ExtensionCommandContext) => Promise<void>)([], ctx);

    expect(notify).toHaveBeenCalled();
    expect(
      notify.mock.calls.some((c: unknown[]) => typeof c[0] === "string" && c[0].includes("No active feature")),
    ).toBe(true);
  });

  test("reassigns the agent-held lock to the interactive identity (session:slug) so it persists", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Active feature so the handler resolves a slug.
    writeFeatureStateFile("auto-stop-lock-feature", {
      featureSlug: "auto-stop-lock-feature",
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {},
      },
    });
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "reload" },
      {
        hasUI: true,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
        ui: { setWidget: () => {}, notify: vi.fn() },
      },
    );

    // In-memory kanban with a feature locked by the auto-agent's UUID.
    const db = await KanbanDatabase.createInMemory();
    setDatabase(db);
    const projectId = db.createProject({ name: "lock-project", repoPath: process.cwd() });
    const featureId = db.createFeature({
      projectId,
      slug: "auto-stop-lock-feature",
      title: "Lock Feature",
      lane: "in-progress",
    });
    const agentSessionId = "11111111-1111-1111-1111-111111111111";
    db.lockFeature(featureId, agentSessionId);
    db.updateFeature({ featureId, assignedSession: agentSessionId });

    // A running auto-agent working on that feature.
    const sm = new AutoAgentStateMachine("worker", projectId, agentSessionId);
    sm.start();
    sm.adoptFeature(featureId, "in-progress");
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = sm;

    const handler = fake.registeredCommands.get("fy:auto-stop");
    expect(handler).toBeDefined();
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    await (handler as (args: string[], ctx: ExtensionCommandContext) => Promise<void>)([], ctx);

    // SM is stopped and callback detached.
    expect(sm.getState()).toBe("stopped");
    expect(getAutoAgentCallback()).toBeNull();

    // Lock is NOT released — it is reassigned to the interactive identity so it
    // survives without a heartbeat (interactive locks are never swept).
    const feature = db.getFeature(featureId);
    expect(feature?.locked_at).toBeTruthy();
    expect(feature?.locked_by_session).toBe("session:auto-stop-lock-feature");
    expect(feature?.assigned_session).toBe("session:auto-stop-lock-feature");
  });

  test("when agent has no current feature, does not attempt lock reassignment and does not throw", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const db = await KanbanDatabase.createInMemory();
    setDatabase(db);
    const projectId = db.createProject({ name: "no-feature-project", repoPath: process.cwd() });
    db.createFeature({ projectId, slug: "no-feature", title: "No Feature", lane: "backlog" });

    // Agent is started but has NOT adopted a feature (e.g. polling state) -> currentFeatureId is null.
    const sm = new AutoAgentStateMachine("worker", projectId, "22222222-2222-2222-2222-222222222222");
    sm.start();
    expect(sm.getCurrentFeatureId()).toBeNull();
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = sm;

    const handler = fake.registeredCommands.get("fy:auto-stop");
    expect(handler).toBeDefined();
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    await (handler as (args: string[], ctx: ExtensionCommandContext) => Promise<void>)([], ctx);

    // SM is stopped; no lock existed to reassign, so nothing throws.
    expect(sm.getState()).toBe("stopped");
    expect(getAutoAgentCallback()).toBeNull();
  });

  test("when kanban database is unavailable, stops the agent gracefully without throwing", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const db = await KanbanDatabase.createInMemory();
    setDatabase(db);
    const projectId = db.createProject({ name: "db-missing-project", repoPath: process.cwd() });
    const featureId = db.createFeature({
      projectId,
      slug: "db-missing-feature",
      title: "Db Missing",
      lane: "in-progress",
    });
    const agentSessionId = "33333333-3333-3333-3333-333333333333";
    db.lockFeature(featureId, agentSessionId);

    // A running agent working on that feature.
    const sm = new AutoAgentStateMachine("worker", projectId, agentSessionId);
    sm.start();
    sm.adoptFeature(featureId, "in-progress");
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = sm;

    // Simulate the kanban database becoming unavailable (closed/cleared) before /fy:auto-stop.
    setDatabase(NO_DATABASE);
    expect(globalThis.__piKanban?.database).toBeNull();

    const handler = fake.registeredCommands.get("fy:auto-stop");
    expect(handler).toBeDefined();
    // Must not throw — the missing db is logged, not surfaced as a crash.
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    await expect(
      (handler as (args: string[], ctx: ExtensionCommandContext) => Promise<void>)([], ctx),
    ).resolves.toBeUndefined();

    expect(sm.getState()).toBe("stopped");
    expect(getAutoAgentCallback()).toBeNull();
  });

  test("when the feature was deleted concurrently, stops gracefully without reassigning the lock", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const db = await KanbanDatabase.createInMemory();
    setDatabase(db);
    const projectId = db.createProject({ name: "missing-feature-project", repoPath: process.cwd() });
    // NOTE: no feature row exists for ghostFeatureId (concurrent deletion). The
    // feature_locks table has an FK on feature_id, so we cannot lock a missing
    // feature — but that's irrelevant here: the !feature branch is reached BEFORE
    // any lock reassignment, so the DB lock state does not affect this path.
    const ghostFeatureId = 9999;
    const agentSessionId = "44444444-4444-4444-4444-444444444444";
    expect(db.getFeature(ghostFeatureId)).toBeNull();

    const sm = new AutoAgentStateMachine("worker", projectId, agentSessionId);
    sm.start();
    sm.adoptFeature(ghostFeatureId, "in-progress");
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = sm;

    const handler = fake.registeredCommands.get("fy:auto-stop");
    expect(handler).toBeDefined();
    // Must not throw — the missing feature is logged, not surfaced as a crash.
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    await expect(
      (handler as (args: string[], ctx: ExtensionCommandContext) => Promise<void>)([], ctx),
    ).resolves.toBeUndefined();

    expect(sm.getState()).toBe("stopped");
    expect(getAutoAgentCallback()).toBeNull();
  });

  test("when reassignLock is a no-op (lock not held by agent), skips updateFeature so assigned_session is unchanged", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const db = await KanbanDatabase.createInMemory();
    setDatabase(db);
    const projectId = db.createProject({ name: "noop-project", repoPath: process.cwd() });
    const featureId = db.createFeature({
      projectId,
      slug: "noop-feature",
      title: "Noop Feature",
      lane: "in-progress",
    });
    const agentSessionId = "44444444-4444-4444-4444-444444444444";
    // Feature is NOT locked by this agent (locked by a different session, or not at all),
    // so reassignLock(from=agentSessionId) returns false.
    db.lockFeature(featureId, "other-session-uuid");
    db.updateFeature({ featureId, assignedSession: "prior-assigned" });

    const sm = new AutoAgentStateMachine("worker", projectId, agentSessionId);
    sm.start();
    sm.adoptFeature(featureId, "in-progress");
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = sm;

    const handler = fake.registeredCommands.get("fy:auto-stop");
    expect(handler).toBeDefined();
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    await (handler as (args: string[], ctx: ExtensionCommandContext) => Promise<void>)([], ctx);

    expect(sm.getState()).toBe("stopped");
    expect(getAutoAgentCallback()).toBeNull();

    // updateFeature was skipped because reassignLock was a no-op: assigned_session is unchanged.
    const feature = db.getFeature(featureId);
    expect(feature?.assigned_session).toBe("prior-assigned");
  });

  test("stops the GracePeriodManager timer when stopped from grace-period state", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // A running agent that has entered its grace-period state, with an active GPM.
    const sm = new AutoAgentStateMachine("worker", 1, "55555555-5555-5555-5555-555555555555");
    sm.start();
    sm.enterGracePeriod();
    expect(sm.getState()).toBe("grace-period");
    if (globalThis.__piKanban) globalThis.__piKanban.autoAgent = sm;

    const gpm = new GracePeriodManager(
      async () => {},
      () => {},
      () => {},
      { durationMs: 30_000 },
    );
    gpm.start();
    expect(gpm.isActive()).toBe(true);
    if (globalThis.__piKanban) globalThis.__piKanban.gracePeriod = gpm;

    const handler = fake.registeredCommands.get("fy:auto-stop");
    expect(handler).toBeDefined();
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    await (handler as (args: string[], ctx: ExtensionCommandContext) => Promise<void>)([], ctx);

    // /fy:auto-stop transitions the agent to stopped AND clears the GPM interval
    // (requirement: clear timers from any state) — it must not keep ticking
    // widget updates for up to 30s after the user stopped the agent.
    expect(sm.getState()).toBe("stopped");
    expect(gpm.isActive()).toBe(false);
  });
});

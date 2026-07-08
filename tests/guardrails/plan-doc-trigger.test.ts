// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { resetInstances, setDatabaseInstance } from "../../src/kanban/kanban-bridge.js";
import { isPhaseActive, isPhaseDone } from "../../src/phases/phase-progression.js";
import { createFeatureStateForSubFeature, loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { initGitDir } from "../helpers/git-template.js";
import { createFakePi, getSingleHandler } from "../helpers/workflow-monitor-test-helpers.js";

afterEach(() => {
  _resetFeatureState();
});

describe("plan doc creates feature state file", () => {
  test("writing an implementation plan creates feature state file with design bypassed", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call") as (event: unknown, ctx: unknown) => void;

    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: ".ff/task-plans/2026-05-10-my-feature-task-plan.md" },
      },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(getActiveFeatureSlug()).toBe("2026-05-10-my-feature");

    const state = loadFeatureState("2026-05-10-my-feature", null);
    expect(state).not.toBeNull();
    expect(state?.completedAt).toBeNull();
    expect(state?.plan.doc).toBe(".ff/task-plans/2026-05-10-my-feature-task-plan.md");
    expect(
      isPhaseDone(
        { currentPhase: state?.workflow.currentPhase ?? null, completedAt: state?.completedAt ?? null },
        "design",
      ),
    ).toBe(true);
    expect(
      isPhaseActive(
        { currentPhase: state?.workflow.currentPhase ?? null, completedAt: state?.completedAt ?? null },
        "plan",
      ),
    ).toBe(true);
    expect(state?.plan.doc).toBe(".ff/task-plans/2026-05-10-my-feature-task-plan.md");
  });

  test("writing a plan doc sets PI_FF_FEATURE env var", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    delete process.env.PI_FF_FEATURE;

    const onToolCall = getSingleHandler(fake.handlers, "tool_call") as (event: unknown, ctx: unknown) => void;

    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: ".ff/task-plans/2026-05-10-cool-thing-task-plan.md" },
      },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(process.env.PI_FF_FEATURE).toBe("2026-05-10-cool-thing");
  });

  test("writing design doc after plan doc updates existing state", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call") as (event: unknown, ctx: unknown) => void;

    // Write plan doc first
    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: ".ff/task-plans/2026-05-10-multi-feature-task-plan.md" },
      },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // Write design doc for same feature
    await onToolCall(
      {
        toolCallId: "call-2",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-10-multi-feature-design.md" },
      },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const state = loadFeatureState("2026-05-10-multi-feature", null);
    expect(state).not.toBeNull();
    // SOTS: the in-memory record is the source of truth. A design-doc write on an
    // already-active feature mirrors the doc into the active record (persisted on
    // the next persist trigger); read it from the handler to verify it was recorded.
    const active = globalThis.__piWorkflowMonitor?.handler?.getActiveFeatureState();
    expect(active?.design.doc).toBe("docs/ff/designs/2026-05-10-multi-feature-design.md");
    expect(active?.plan.doc).toBe(".ff/task-plans/2026-05-10-multi-feature-task-plan.md");
  });
});

import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";

describe("plan doc isAlreadyActive — kanban sub-feature check", () => {
  test("creates sub-feature state when slug has kanban card", async () => {
    const db = await KanbanDatabase.createInMemory();

    setDatabaseInstance(db);

    try {
      const fake = createFakePi(); // changes process.cwd() to temp dir

      // Initialize a git repo in the temp CWD so detectProject can resolve it
      initGitDir(process.cwd());

      // Create project with the git repo path that detectProject will resolve
      const projectId = db.createProject({ name: "test", repoPath: process.cwd() });
      const subFeatureId = db.createFeature({
        projectId,
        slug: "2026-05-22-sub-feature",
        title: "Sub Feature",
        lane: "backlog",
      });

      workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
      const onToolCall = getSingleHandler(fake.handlers, "tool_call") as (event: unknown, ctx: unknown) => void;

      // First write: activate the main feature by writing its design doc
      await onToolCall(
        {
          toolCallId: "call-0",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );

      // Verify main feature is now active
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

      // Second write: plan doc for the sub-feature (different slug from active)
      await onToolCall(
        {
          toolCallId: "call-1",
          toolName: "write",
          input: { path: ".ff/task-plans/2026-05-22-sub-feature-task-plan.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );

      // Verify sub-feature state was created with plan artifact
      const subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      expect(subState?.plan.doc).toBe(".ff/task-plans/2026-05-22-sub-feature-task-plan.md");
      // Verify design artifact is NOT set (plan doc case passes "" to avoid it)
      expect(subState?.design.doc).toBeNull();
      expect(subState?.featureId).toBe(subFeatureId);
      // Active feature should still be main
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
      // Verify kanban feature columns were updated
      const updatedFeature = db.getFeature(subFeatureId);
      expect(updatedFeature?.state_file).toContain("2026-05-22-sub-feature");
      expect(updatedFeature?.plan_doc).toBe(".ff/task-plans/2026-05-22-sub-feature-task-plan.md");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("updates existing sub-feature state plan artifact when state already exists", async () => {
    const db = await KanbanDatabase.createInMemory();

    setDatabaseInstance(db);

    try {
      const fake = createFakePi();

      initGitDir(process.cwd());

      const projectId = db.createProject({ name: "test", repoPath: process.cwd() });
      const subFeatureId = db.createFeature({
        projectId,
        slug: "2026-05-22-sub-feature",
        title: "Sub Feature",
        lane: "backlog",
      });

      workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
      const onToolCall = getSingleHandler(fake.handlers, "tool_call") as (event: unknown, ctx: unknown) => void;

      // Activate the main feature
      await onToolCall(
        {
          toolCallId: "call-0",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

      // Pre-create sub-feature state (simulating a previous write that already created state)
      const createSub = createFeatureStateForSubFeature;

      const preExistingState = createSub("2026-05-22-sub-feature", "");
      preExistingState.featureId = subFeatureId;
      // plan artifact is null (no plan doc written yet)
      saveFeatureState(preExistingState, null);

      // Write plan doc for the sub-feature — should UPDATE existing state, not create new
      await onToolCall(
        {
          toolCallId: "call-1",
          toolName: "write",
          input: { path: ".ff/task-plans/2026-05-22-sub-feature-task-plan.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );

      // Verify existing state was updated (not replaced)
      const subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      expect(subState?.plan.doc).toBe(".ff/task-plans/2026-05-22-sub-feature-task-plan.md");
      expect(subState?.featureId).toBe(subFeatureId);
      // Active feature still main
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("silently skips when slug has no kanban card", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call") as (event: unknown, ctx: unknown) => void;

    // First write: activate the main feature
    await onToolCall(
      {
        toolCallId: "call-0",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
      },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

    try {
      // Second write: plan doc for a slug with NO kanban card
      await onToolCall(
        {
          toolCallId: "call-1",
          toolName: "write",
          input: { path: ".ff/task-plans/2026-05-22-hallucinated-task-plan.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );

      const hallucinatedState = loadFeatureState("2026-05-22-hallucinated", null);
      expect(hallucinatedState).toBeNull();
      // Active feature should still be main
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("silently skips when kanban DB is not available", async () => {
    // Don't set up any kanban DB — getDatabaseInstance() returns null

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call") as (event: unknown, ctx: unknown) => void;

    // Activate the main feature
    await onToolCall(
      { toolCallId: "call-0", toolName: "write", input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" } },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );
    expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

    try {
      // Write plan doc for a different slug — no kanban DB to check
      await onToolCall(
        {
          toolCallId: "call-1",
          toolName: "write",
          input: { path: ".ff/task-plans/2026-05-22-other-feature-task-plan.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );

      // No state created, no crash
      const otherState = loadFeatureState("2026-05-22-other-feature", null);
      expect(otherState).toBeNull();
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("silently skips when detectProject returns null (no git repo)", async () => {
    const db = await KanbanDatabase.createInMemory();

    // Create project with a path that won't match any git repo
    const projectId = db.createProject({ name: "test", repoPath: "/nonexistent/repo/path" });
    const _subFeatureId = db.createFeature({
      projectId,
      slug: "2026-05-22-sub-feature",
      title: "Sub Feature",
      lane: "backlog",
    });

    setDatabaseInstance(db);

    // Don't initialize a git repo — detectProject will return null
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call") as (event: unknown, ctx: unknown) => void;

    // Activate the main feature
    await onToolCall(
      { toolCallId: "call-0", toolName: "write", input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" } },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );
    expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

    try {
      // Write plan doc for sub-feature — detectProject returns null, so no sub-feature state
      await onToolCall(
        {
          toolCallId: "call-1",
          toolName: "write",
          input: { path: ".ff/task-plans/2026-05-22-sub-feature-task-plan.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );

      const subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).toBeNull();
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("does not overwrite existing plan artifact when writing plan doc twice", async () => {
    const db = await KanbanDatabase.createInMemory();

    setDatabaseInstance(db);

    try {
      const fake = createFakePi();

      initGitDir(process.cwd());

      const projectId = db.createProject({ name: "test", repoPath: process.cwd() });
      db.createFeature({ projectId, slug: "2026-05-22-main-feature", title: "Main", lane: "in-progress" });
      db.createFeature({ projectId, slug: "2026-05-22-sub-feature", title: "Sub", lane: "backlog" });

      workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
      const onToolCall = getSingleHandler(fake.handlers, "tool_call") as (event: unknown, ctx: unknown) => void;

      // Activate main feature
      await onToolCall(
        {
          toolCallId: "call-0",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

      // First write: plan doc for sub-feature
      await onToolCall(
        {
          toolCallId: "call-1",
          toolName: "write",
          input: { path: ".ff/task-plans/2026-05-22-sub-feature-task-plan.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );

      let subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      expect(subState?.plan.doc).toBe(".ff/task-plans/2026-05-22-sub-feature-task-plan.md");

      // Second write: plan doc again with a different path — should NOT overwrite
      await onToolCall(
        {
          toolCallId: "call-2",
          toolName: "write",
          input: { path: "docs/plans/2026-05-22-sub-feature-implementation-v2.md" },
        },
        { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
      );

      subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      // Should still be the first path — guard prevented overwrite
      expect(subState?.plan.doc).toBe(".ff/task-plans/2026-05-22-sub-feature-task-plan.md");
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });
});

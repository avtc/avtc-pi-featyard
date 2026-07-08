// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { resetInstances, setDatabaseInstance } from "../../src/kanban/kanban-bridge.js";
import { isPhasePending } from "../../src/phases/phase-progression.js";
import { createFeatureStateForSubFeature, loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { initGitDir } from "../helpers/git-template.js";
import { createFakePi, getSingleHandler, writeFeatureStateFile } from "../helpers/workflow-monitor-test-helpers.js";

afterEach(() => {
  _resetFeatureState();
});

describe("design doc creates feature state file", () => {
  test("writing a design doc creates feature state file and sets active slug", async () => {
    const fake = createFakePi();
    const tempDir = process.cwd(); // createFakePi already called withTempCwd()
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // Simulate writing a design doc
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-08-test-feature-design.md" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // Verify the active feature slug is set
    expect(getActiveFeatureSlug()).toBe("2026-05-08-test-feature");

    // Verify the state file was created
    const statePath = path.join(tempDir, ".ff", "feature-state", "2026-05-08-test-feature.json");
    expect(fs.existsSync(statePath)).toBe(true);

    // Verify the state file contents
    const state = loadFeatureState("2026-05-08-test-feature", null);
    expect(state).not.toBeNull();
    expect(state?.completedAt).toBeNull();
    expect(state?.featureSlug).toBe("2026-05-08-test-feature");
    expect(state?.workflow.designDoc).toBe("docs/ff/designs/2026-05-08-test-feature-design.md");
  });

  test("writing a design doc sets PI_FF_FEATURE env var", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Clean env
    delete process.env.PI_FF_FEATURE;

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-08-another-feature-design.md" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(process.env.PI_FF_FEATURE).toBe("2026-05-08-another-feature");
  });

  test("writing a non-design doc does not create feature state", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "src/foo.ts" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(getActiveFeatureSlug()).toBeNull();
  });
});

import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";

describe("design doc re-activates an existing feature with no active handler (regression)", () => {
  // Regression: G5.3 dropped the trailing re-activation block. Editing a design
  // doc when the handler has lost its active feature (e.g. after a reload that
  // didn't bind) must bring the feature back so it shows in the widget and
  // phase_ready can resolve the slug. Before the fix this left no active slug.
  test("editing a design doc re-activates an existing feature state", async () => {
    const fake = createFakePi();
    const slug = writeFeatureStateFile("2026-06-24-rpc-subagent-mode", {
      workflow: {
        currentPhase: "design",
        designDoc: "docs/ff/designs/2026-06-24-rpc-subagent-mode-design.md",
        planDoc: null,
      },
      design: {
        doc: "docs/ff/designs/2026-06-24-rpc-subagent-mode-design.md",
        reviewActive: false,
        reviewLoopCount: 0,
      },
      featureId: 115,
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // No active feature at this point (handler started fresh).
    expect(getActiveFeatureSlug()).toBeNull();

    // Edit the existing design doc (write tool).
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "write",
        input: { path: `docs/ff/designs/${slug}-design.md` },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // The existing feature must be re-activated.
    expect(getActiveFeatureSlug()).toBe(slug);
    expect(process.env.PI_FF_FEATURE).toBe(slug);

    // Re-activation reuses the existing durable record (featureId preserved).
    const state = loadFeatureState(slug, null);
    expect(state?.featureId).toBe(115);
  });
});

describe("design doc create links kanban featureId on the active + persisted state", () => {
  // Bug A: ensureKanbanFeature sets featureId on the state record (and saves it),
  // but the create branch previously discarded the linked record and activated the
  // original (featureId=null) one — so persistState wrote featureId=null over
  // the file, orphaning the kanban card. The kanban card WAS created (lane moved
  // to "design"), but the feature state never carried the link.
  test("writing a NEW design doc sets featureId on the active handler record + file", async () => {
    const db = await KanbanDatabase.createInMemory();
    setDatabaseInstance(db);
    const fake = createFakePi();
    initGitDir(process.cwd());
    db.createProject({ name: "test", repoPath: process.cwd() });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-06-24-rpc-probe-design.md" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/s.jsonl" },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    try {
      const slug = "2026-06-24-rpc-probe";
      expect(getActiveFeatureSlug()).toBe(slug);

      // The kanban card was created + moved to the design lane.
      const card = db.findFeatureBySlug(slug, undefined);
      expect(card).not.toBeNull();
      expect(card?.lane).toBe("design");

      // featureId must be carried on BOTH the active handler record and the file
      // (regression: previously null on both because the linked clone was discarded).
      const active = (
        globalThis as {
          __piWorkflowMonitor?: { handler?: { getActiveFeatureState: () => { featureId: number | null } | null } };
        }
      ).__piWorkflowMonitor?.handler?.getActiveFeatureState();
      expect(active?.featureId).toBe(card?.id);
      expect(loadFeatureState(slug, null)?.featureId).toBe(card?.id);
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });
});

describe("design doc isAlreadyActive — kanban sub-feature check", () => {
  test("creates sub-feature state when slug has kanban card", async () => {
    // Setup: create kanban DB with a registered sub-feature
    const db = await KanbanDatabase.createInMemory();

    // Make the kanban DB available to workflow-monitor

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
      const onToolCall = getSingleHandler(fake.handlers, "tool_call");

      // First write: activate the main feature by writing its design doc
      await onToolCall(
        {
          toolCallId: "call-0",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      // Verify main feature is now active
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

      // Second write: design doc for the sub-feature (different slug from active)
      await onToolCall(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-sub-feature-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      // Verify sub-feature state was created
      const subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      expect(subState?.featureSlug).toBe("2026-05-22-sub-feature");
      expect(
        isPhasePending(
          { currentPhase: subState?.workflow.currentPhase ?? null, completedAt: subState?.completedAt ?? null },
          "design",
        ),
      ).toBe(true);
      expect(subState?.design.doc).toBe("docs/ff/designs/2026-05-22-sub-feature-design.md");
      expect(subState?.featureId).toBe(subFeatureId);
      // Verify active feature is unchanged — agent stays on main feature
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
      // Verify kanban feature columns were updated
      const updatedFeature = db.getFeature(subFeatureId);
      expect(updatedFeature?.state_file).toContain("2026-05-22-sub-feature");
      expect(updatedFeature?.design_doc).toBe("docs/ff/designs/2026-05-22-sub-feature-design.md");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("updates existing sub-feature state design artifact when state already exists", async () => {
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
      const onToolCall = getSingleHandler(fake.handlers, "tool_call");

      // Activate the main feature
      await onToolCall(
        {
          toolCallId: "call-0",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

      // Pre-create sub-feature state (simulating a previous write that already created state)
      const createSub = createFeatureStateForSubFeature;

      const preExistingState = createSub("2026-05-22-sub-feature", "");
      preExistingState.featureId = subFeatureId;
      // design artifact is null (empty designDoc passed above)
      saveFeatureState(preExistingState, null);

      // Write design doc for the sub-feature — should UPDATE existing state, not create new
      await onToolCall(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-sub-feature-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      // Verify existing state was updated (not replaced)
      const subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      expect(subState?.design.doc).toBe("docs/ff/designs/2026-05-22-sub-feature-design.md");
      expect(subState?.featureId).toBe(subFeatureId);
      // Active feature still main
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("silently skips when slug has no kanban card (hallucinated filename)", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // First write: activate the main feature
    await onToolCall(
      {
        toolCallId: "call-0",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // Verify main feature is active
    expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

    try {
      // Second write: hallucinated filename with NO kanban card
      await onToolCall(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-hallucinated-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      // No state should be created for the hallucinated slug
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
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // Activate the main feature
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-0",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );
    expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

    try {
      // Write design doc for a different slug — no kanban DB to check
      await onToolCall(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-other-feature-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
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
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // Activate the main feature
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-0",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );
    expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

    try {
      // Write design doc for sub-feature — detectProject returns null, so no sub-feature state
      await onToolCall(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-sub-feature-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      const subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).toBeNull();
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("sequential writes: design doc then plan doc for sub-feature", async () => {
    const db = await KanbanDatabase.createInMemory();

    // Initialize git repo so detectProject resolves
    const fake = createFakePi();

    initGitDir(process.cwd());

    const projectId = db.createProject({ name: "test", repoPath: process.cwd() });
    const _mainFeatureId = db.createFeature({
      projectId,
      slug: "2026-05-22-main-feature",
      title: "Main Feature",
      lane: "in-progress",
    });
    const subFeatureId = db.createFeature({
      projectId,
      slug: "2026-05-22-sub-feature",
      title: "Sub Feature",
      lane: "backlog",
    });

    setDatabaseInstance(db);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // Step 1: Activate main feature
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-0",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );
    expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

    try {
      // Step 2: Write design doc for sub-feature → creates sub-feature state
      await onToolCall(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-sub-feature-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      let subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      expect(subState?.design.doc).toBe("docs/ff/designs/2026-05-22-sub-feature-design.md");
      expect(subState?.plan.doc).toBeNull();
      expect(subState?.featureId).toBe(subFeatureId);
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

      // Step 3: Write plan doc for same sub-feature → updates existing state
      await onToolCall(
        {
          toolCallId: "call-2",
          toolName: "write",
          input: { path: ".ff/task-plans/2026-05-22-sub-feature-task-plan.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      // Both artifacts preserved
      expect(subState?.design.doc).toBe("docs/ff/designs/2026-05-22-sub-feature-design.md");
      expect(subState?.plan.doc).toBe(".ff/task-plans/2026-05-22-sub-feature-task-plan.md");
      expect(subState?.featureId).toBe(subFeatureId);
      // Main feature still active
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("does not overwrite existing design artifact when writing design doc twice", async () => {
    const db = await KanbanDatabase.createInMemory();

    const fake = createFakePi();

    initGitDir(process.cwd());
    const projectId = db.createProject({ name: "test", repoPath: process.cwd() });
    db.createFeature({ projectId, slug: "2026-05-22-main-feature", title: "Main", lane: "in-progress" });
    db.createFeature({ projectId, slug: "2026-05-22-sub-feature", title: "Sub", lane: "backlog" });

    setDatabaseInstance(db);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // Activate main feature
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-0",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );
    expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

    try {
      // First write: design doc for sub-feature
      await onToolCall(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-sub-feature-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      let subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      expect(subState?.design.doc).toBe("docs/ff/designs/2026-05-22-sub-feature-design.md");

      // Second write: design doc again with a different path — should NOT overwrite
      await onToolCall(
        {
          type: "tool_call",
          toolCallId: "call-2",
          toolName: "write",
          input: { path: "docs/plans/2026-05-22-sub-feature-design-v2.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      // Should still be the first path — guard prevented overwrite
      expect(subState?.design.doc).toBe("docs/ff/designs/2026-05-22-sub-feature-design.md");
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("reverse sequential writes: plan doc then design doc for sub-feature", async () => {
    const db = await KanbanDatabase.createInMemory();

    const fake = createFakePi();

    initGitDir(process.cwd());
    const projectId = db.createProject({ name: "test", repoPath: process.cwd() });
    db.createFeature({ projectId, slug: "2026-05-22-main-feature", title: "Main Feature", lane: "in-progress" });
    db.createFeature({ projectId, slug: "2026-05-22-sub-feature", title: "Sub Feature", lane: "backlog" });

    setDatabaseInstance(db);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // Activate main feature
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "call-0",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-05-22-main-feature-design.md" },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );
    expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");

    try {
      // Step 1: Write plan doc for sub-feature → creates sub-feature state with plan artifact
      await onToolCall(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "write",
          input: { path: ".ff/task-plans/2026-05-22-sub-feature-task-plan.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      let subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      expect(subState?.plan.doc).toBe(".ff/task-plans/2026-05-22-sub-feature-task-plan.md");
      expect(subState?.design.doc).toBeNull();

      // Step 2: Write design doc for same sub-feature → updates existing state with design artifact
      await onToolCall(
        {
          toolCallId: "call-2",
          toolName: "write",
          input: { path: "docs/ff/designs/2026-05-22-sub-feature-design.md" },
        } as unknown as ExtensionEvent,
        {
          hasUI: false,
          sessionManager: { getBranch: () => [] },
          ui: { setWidget: () => {} },
        } as unknown as ExtensionContext,
      );

      subState = loadFeatureState("2026-05-22-sub-feature", null);
      expect(subState).not.toBeNull();
      // Both artifacts preserved
      expect(subState?.design.doc).toBe("docs/ff/designs/2026-05-22-sub-feature-design.md");
      expect(subState?.plan.doc).toBe(".ff/task-plans/2026-05-22-sub-feature-task-plan.md");
      expect(getActiveFeatureSlug()).toBe("2026-05-22-main-feature");
    } finally {
      resetInstances();
      delete process.env.PI_FF_FEATURE;
    }
  });
});

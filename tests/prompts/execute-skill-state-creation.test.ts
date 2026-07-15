// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import { resetInstances, setDatabaseInstance } from "../../src/kanban/kanban-bridge.js";
import { isPhaseActive, isPhaseDone } from "../../src/phases/phase-progression.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import { initGitDir } from "../helpers/git-template.js";
import {
  createFakePi,
  disableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  withTempCwd,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("state creation from execution skill invocation", () => {
  beforeEach(() => {
    withTempCwd();
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    disableSubagentMode();
  });

  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
  });

  const subagentCtx = {
    hasUI: false,
    sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/s.jsonl" },
    ui: {
      setWidget: () => {},
      select: async () => "Skip all and continue",
      setEditorText: () => {},
      notify: () => {},
    },
  } as unknown as ExtensionContext;

  test("creates state file when /skill:fy-implement invoked with plan doc path and no active feature", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Trigger session_start — no env var, no state files, so activeFeatureSlug stays null
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user" as const, hasUI: false } as unknown as ExtensionEvent,
      subagentCtx,
    );

    // No active feature yet
    expect(getActiveFeatureSlug()).toBeNull();

    // Invoke fy-implement with a plan doc path
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput(
      {
        text: "/skill:fy-implement .featyard/task-plans/2026-05-10-my-feature-task-plan.md",
      } as unknown as ExtensionEvent,
      subagentCtx,
    );

    // Should have created state
    expect(getActiveFeatureSlug()).toBe("2026-05-10-my-feature");
    expect(process.env.PI_FY_FEATURE).toBe("2026-05-10-my-feature");

    // State file should exist on disk
    const state = loadFeatureState("2026-05-10-my-feature", null);
    expect(state).toBeDefined();
    // implement pointer → design + plan derived done
    const v = { currentPhase: state?.workflow.currentPhase ?? null, completedAt: state?.completedAt ?? null };
    expect(isPhaseDone(v, "design")).toBe(true);
    expect(isPhaseDone(v, "plan")).toBe(true);
    expect(state?.plan.doc).toContain("2026-05-10-my-feature-task-plan.md");
  });

  test("does not create state when skill invoked without plan doc path", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user" as const, hasUI: false } as unknown as ExtensionEvent,
      subagentCtx,
    );

    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:fy-implement" } as unknown as ExtensionEvent, subagentCtx);

    // No plan path in message — no state created
    expect(getActiveFeatureSlug()).toBeNull();
  });

  test("loads existing state and preserves workflow phase when state file already exists", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Write state file in the temp cwd that createFakePi set up
    const slug = "2026-05-10-existing";
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const existingState = {
      featureSlug: slug,
      activeFeatureSlug: slug,
      git: { branch: "feature/existing", baseCommitSha: null, worktreePath: null, baseBranch: null },
      createdAt: "2026-05-10T10:00:00.000Z",
      updatedAt: "2026-05-10T10:00:00.000Z",
      completedAt: null,
      workflow: {
        currentPhase: "implement",
        designDoc: "docs/featyard/designs/2026-05-10-existing-design.md",
        planDoc: ".featyard/task-plans/2026-05-10-existing-task-plan.md",
      },
      tdd: { stage: "idle", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
      verification: { passed: false, waived: false },
      design: { doc: "docs/featyard/designs/2026-05-10-existing-design.md", reviewActive: false, reviewLoopCount: 0 },
      plan: {
        doc: ".featyard/task-plans/2026-05-10-existing-task-plan.md",
        verifyLoopCount: 0,
        reviewActive: false,
        reviewLoopCount: 0,
      },
      implement: { tasks: [] },
      verify: { verifyLoopCount: 0 },
      review: { reviewLoopCount: 0, reviewHistory: [] },
      sessionFiles: [],
      featureId: null,
    };
    fs.writeFileSync(path.join(".featyard", "feature-state", `${slug}.json`), JSON.stringify(existingState, null, 2));
    process.env.PI_FY_FEATURE = slug;

    // session_start uses env var to load state (subagent path)
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user" as const, hasUI: false } as unknown as ExtensionEvent,
      subagentCtx,
    );

    // Feature should be active from env var binding
    expect(getActiveFeatureSlug()).toBe(slug);

    const onInput = getSingleHandler(fake.handlers, "input");
    onInput(
      { text: `/skill:fy-implement .featyard/task-plans/${slug}-task-plan.md` } as unknown as ExtensionEvent,
      subagentCtx,
    );

    expect(getActiveFeatureSlug()).toBe(slug);

    // Should preserve the existing workflow phase pointer
    const state = loadFeatureState(slug, null);
    expect(state?.workflow.currentPhase).toBe("implement");
  });
});

describe("fy-plan / fy-design skill invocation with design doc path", () => {
  beforeEach(() => {
    withTempCwd();
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    disableSubagentMode();
  });

  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    resetInstances();
  });

  const planCtx = {
    hasUI: false,
    sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/s.jsonl" },
    ui: {
      setWidget: () => {},
      select: async () => "Skip all and continue",
      setEditorText: () => {},
      notify: () => {},
    },
  } as unknown as ExtensionContext;

  test("fy-plan with design doc path creates state and advances to plan (design derived done)", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user" as const, hasUI: false }, planCtx);
    expect(getActiveFeatureSlug()).toBeNull();

    const onInput = getSingleHandler(fake.handlers, "input");
    await onInput(
      {
        source: "user" as const,
        text: "/skill:fy-plan docs/featyard/designs/2026-06-24-rpc-subagent-mode-design.md",
      } as unknown as ExtensionEvent,
      planCtx,
    );

    expect(getActiveFeatureSlug()).toBe("2026-06-24-rpc-subagent-mode");
    expect(process.env.PI_FY_FEATURE).toBe("2026-06-24-rpc-subagent-mode");

    const state = loadFeatureState("2026-06-24-rpc-subagent-mode", null);
    expect(state).toBeDefined();
    const v = { currentPhase: state?.workflow.currentPhase ?? null, completedAt: state?.completedAt ?? null };
    // pointer at plan → design derived done, plan in-progress
    expect(isPhaseDone(v, "design")).toBe(true);
    expect(isPhaseActive(v, "plan")).toBe(true);
    expect(state?.design.doc).toContain("2026-06-24-rpc-subagent-mode-design.md");
  });

  test("fy-plan with design doc path activates an existing feature state", async () => {
    const fake = createFakePi();
    const slug = "2026-06-24-rpc-subagent-mode";
    // Pre-create state (e.g. left on disk after a reload that lost handler state)
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    fs.writeFileSync(
      path.join(".featyard", "feature-state", `${slug}.json`),
      JSON.stringify(
        {
          featureSlug: slug,
          git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
          createdAt: "2026-06-24T20:10:20.000Z",
          updatedAt: "2026-06-24T20:10:20.000Z",
          completedAt: null,
          workflow: { currentPhase: "design", designDoc: `docs/featyard/designs/${slug}-design.md`, planDoc: null },
          design: { doc: `docs/featyard/designs/${slug}-design.md`, reviewActive: false, reviewLoopCount: 0 },
          plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
          implement: { tasks: [] },
          verify: { verifyLoopCount: 0 },
          review: { reviewLoopCount: 0, reviewHistory: [] },
          sessionFiles: [],
          featureId: 115,
        },
        null,
        2,
      ),
    );

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { source: "user" as const, hasUI: false }, planCtx);
    expect(getActiveFeatureSlug()).toBeNull();

    const onInput = getSingleHandler(fake.handlers, "input");
    await onInput(
      {
        source: "user" as const,
        text: `/skill:fy-plan docs/featyard/designs/${slug}-design.md`,
      } as unknown as ExtensionEvent,
      planCtx,
    );

    // Existing feature re-activated; featureId preserved (no new state created).
    expect(getActiveFeatureSlug()).toBe(slug);
    expect(loadFeatureState(slug, null)?.featureId).toBe(115);
  });

  test("fy-design with design doc path creates state at design phase", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user" as const, hasUI: false }, planCtx);

    const onInput = getSingleHandler(fake.handlers, "input");
    await onInput(
      {
        source: "user" as const,
        text: "/skill:fy-design docs/featyard/designs/2026-05-10-my-feature-design.md",
      } as unknown as ExtensionEvent,
      planCtx,
    );

    expect(getActiveFeatureSlug()).toBe("2026-05-10-my-feature");
    const state = loadFeatureState("2026-05-10-my-feature", null);
    const v = { currentPhase: state?.workflow.currentPhase ?? null, completedAt: state?.completedAt ?? null };
    expect(isPhaseActive(v, "design")).toBe(true);
  });

  test("fy-plan without a design doc path does not activate", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user" as const, hasUI: false }, planCtx);

    const onInput = getSingleHandler(fake.handlers, "input");
    await onInput({ source: "user" as const, text: "/skill:fy-plan" } as unknown as ExtensionEvent, planCtx);

    expect(getActiveFeatureSlug()).toBeNull();
  });

  test("fy-plan create path links the feature to kanban", async () => {
    const db = await KanbanDatabase.createInMemory();
    setDatabaseInstance(db);
    const fake = createFakePi();
    initGitDir(process.cwd());

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { source: "user" as const, hasUI: false }, planCtx);

    const onInput = getSingleHandler(fake.handlers, "input");
    await onInput(
      {
        source: "user" as const,
        text: "/skill:fy-plan docs/featyard/designs/2026-06-24-rpc-subagent-mode-design.md",
      } as unknown as ExtensionEvent,
      planCtx,
    );

    expect(getActiveFeatureSlug()).toBe("2026-06-24-rpc-subagent-mode");
    // A kanban card was created (featureId set on state + DB has the feature).
    const state = loadFeatureState("2026-06-24-rpc-subagent-mode", null);
    expect(state?.featureId).not.toBeNull();
    const card = state?.featureId != null ? db.getFeature(state.featureId) : null;
    expect(card?.slug).toBe("2026-06-24-rpc-subagent-mode");
  });
});

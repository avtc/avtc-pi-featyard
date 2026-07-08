// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { createFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import {
  createFakePi,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("session-start feature selection", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  // --- Startup always fresh-starts (no feature list prompt) ---

  test("reason=startup always fresh starts — no feature list, no prompt", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Create active feature state files (would have triggered prompt before)
    const state1 = createFeatureState("2026-01-01-first", "docs/ff/designs/2026-01-01-first-design.md");
    saveFeatureState(state1, null);
    const state2 = createFeatureState("2026-02-01-second", "docs/ff/designs/2026-02-01-second-design.md");
    saveFeatureState(state2, null);

    let selectCalled = false;
    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          selectCalled = true;
          return "";
        },
        setEditorText: () => {},
      },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "startup" }, mockCtx);

    // No prompt — startup always fresh starts
    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBeNull();
  });

  // --- reason=new with env var loads feature ---

  test("reason=new with env var loads the bound feature without prompt", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const state1 = createFeatureState("2026-01-01-old", "docs/ff/designs/2026-01-01-old-design.md");
    saveFeatureState(state1, null);
    const state2 = createFeatureState("2026-02-01-new", "docs/ff/designs/2026-02-01-new-design.md");
    saveFeatureState(state2, null);

    // Env var is set by the root session before creating new session
    process.env.PI_FF_FEATURE = "2026-02-01-new";
    // Workflow-initiated flag should also be set by /ff:next or task-tracker
    if (globalThis.__piWorkflowMonitor) globalThis.__piWorkflowMonitor.workflowInitiatedNewSession = true;

    let selectCalled = false;
    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          selectCalled = true;
          return "";
        },
        setEditorText: () => {},
      },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    expect(selectCalled).toBe(false);
    // Should load the env-var-bound feature
    expect(getActiveFeatureSlug()).toBe("2026-02-01-new");
  });

  test("reason=new without env var fresh starts (no feature list, no prompt)", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Create feature state file but no env var set
    const state = createFeatureState("2026-05-01-active", "docs/ff/designs/2026-05-01-active-design.md");
    saveFeatureState(state, null);

    let selectCalled = false;
    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          selectCalled = true;
          return "";
        },
        setEditorText: () => {},
      },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    // No prompt — fresh start only
    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBeNull();
    expect(process.env.PI_FF_FEATURE).toBeUndefined();
  });

  test("subagent with PI_FF_FEATURE env loads that feature", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const state = createFeatureState("2026-04-01-sub", "docs/ff/designs/2026-04-01-sub-design.md");
    state.workflow.currentPhase = "implement";
    saveFeatureState(state, null);

    process.env.PI_FF_FEATURE = "2026-04-01-sub";

    const mockCtx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    expect(getActiveFeatureSlug()).toBe("2026-04-01-sub");

    delete process.env.PI_FF_FEATURE;
  });

  test("subagent without env var does NOT load any feature", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const state = createFeatureState("2026-04-01-subauto", "docs/ff/designs/2026-04-01-subauto-design.md");
    saveFeatureState(state, null);

    const mockCtx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    // No env var set — should fresh start
    expect(getActiveFeatureSlug()).toBeNull();
  });

  // --- /resume tests ---

  test("reason=resume clears state when no session entries", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Set env var to simulate stale state from previous session
    process.env.PI_FF_FEATURE = "2026-05-10-old-feature";

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "resume" },
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      },
    );

    // No session entries — state should be cleared
    expect(process.env.PI_FF_FEATURE).toBeUndefined();
    expect(getActiveFeatureSlug()).toBeNull();
  });

  test("reason=resume restores state from session entries without prompt", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Simulate session entries from the resumed session
    const branch = [
      {
        id: "entry-1",
        type: "custom",
        customType: "feature_flow_state",
        data: {
          featureState: {
            featureSlug: "2026-05-10-resumed-feature",
            git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
            createdAt: "2026-05-10T00:00:00.000Z",
            updatedAt: "2026-05-10T00:00:00.000Z",
            completedAt: null,
            workflow: { currentPhase: "implement", designDoc: null, planDoc: null },
            sessionFiles: [],
            featureId: null,
            design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
            plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
            implement: { tasks: [] },
            verify: { verifyLoopCount: 0 },
            review: { reviewLoopCount: 0, reviewHistory: [] },
          },
          guardrailsState: {
            tdd: { stage: "idle", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
            verification: "not-run",
          },
        },
      },
    ];

    let selectCalled = false;
    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => branch },
      ui: {
        setWidget: () => {},
        select: async () => {
          selectCalled = true;
          return "";
        },
        setEditorText: () => {},
      },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "resume" }, mockCtx);

    // Should restore from entries without showing any prompt
    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBe("2026-05-10-resumed-feature");
    expect(process.env.PI_FF_FEATURE).toBe("2026-05-10-resumed-feature");
  });

  // --- User-initiated /new tests ---

  test("reason=new without workflow flag and env var set shows continue-or-reset prompt — continue", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Set up active workflow via env var
    const state = createFeatureState("2026-05-10-active", "docs/ff/designs/2026-05-10-active-design.md");
    state.workflow.currentPhase = "implement";
    saveFeatureState(state, null);
    process.env.PI_FF_FEATURE = "2026-05-10-active";

    // User-initiated /new (no workflow flag set)
    let selectOptions: string[] = [];
    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async (_title: string, options: string[]) => {
          selectOptions = options;
          return options[0]; // Continue (first option)
        },
        setEditorText: () => {},
      },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    // Should show continue-or-reset prompt
    expect(selectOptions).toContain("Continue: 2026-05-10-active");
    expect(selectOptions).toContain("Reset workflow");
    // Choosing Continue should keep the feature loaded
    expect(getActiveFeatureSlug()).toBe("2026-05-10-active");
  });

  test("reason=new without workflow flag and env var set — reset chosen", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const state = createFeatureState("2026-05-10-reset-test", "docs/ff/designs/2026-05-10-reset-test-design.md");
    state.workflow.currentPhase = "implement";
    saveFeatureState(state, null);
    process.env.PI_FF_FEATURE = "2026-05-10-reset-test";

    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async (_title: string, _options: string[]) => {
          return "Reset workflow";
        },
        setEditorText: () => {},
      },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    expect(getActiveFeatureSlug()).toBeNull();
    expect(process.env.PI_FF_FEATURE).toBeUndefined();
  });

  test("reason=new with workflow flag skips prompt and loads feature", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const state = createFeatureState("2026-05-10-wf-new", "docs/ff/designs/2026-05-10-wf-new-design.md");
    state.workflow.currentPhase = "implement";
    saveFeatureState(state, null);
    process.env.PI_FF_FEATURE = "2026-05-10-wf-new";

    // Set the workflow-initiated flag
    if (globalThis.__piWorkflowMonitor) globalThis.__piWorkflowMonitor.workflowInitiatedNewSession = true;

    let selectCalled = false;
    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          selectCalled = true;
          return "";
        },
        setEditorText: () => {},
      },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    // No prompt — directly loads from env var
    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBe("2026-05-10-wf-new");
    // Flag should be consumed
    expect(globalThis.__piWorkflowMonitor?.workflowInitiatedNewSession).toBeUndefined();
  });

  test("reason=new without workflow flag and no env var loads normally without prompt", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // No env var set — no active workflow

    let selectCalled = false;
    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          selectCalled = true;
          return "";
        },
        setEditorText: () => {},
      },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    // No prompt — no active workflow to ask about
    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBeNull();
  });

  test("reason=new without workflow flag and hasUI=false skips prompt", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const state = createFeatureState("2026-05-10-sub-new", "docs/ff/designs/2026-05-10-sub-new-design.md");
    saveFeatureState(state, null);
    process.env.PI_FF_FEATURE = "2026-05-10-sub-new";

    const mockCtx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    // Subagent — loads from env var without prompt
    expect(getActiveFeatureSlug()).toBe("2026-05-10-sub-new");
  });
});

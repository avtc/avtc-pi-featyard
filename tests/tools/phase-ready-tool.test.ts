// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolCallEvent,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _clearActiveFeatureSlug, _resetFeatureState } from "../../src/index.js";
import { setAutoAgentCallback } from "../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { isPhaseDone } from "../../src/phases/phase-progression.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  BRAINSTORM_ACTIVE_STATE,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  getToolHandlers,
  NO_AUTO_AGENT_CALLBACK,
  NO_TODO_OVERRIDE,
  NO_UI_CTX,
  NOT_ALL_TODOS_DONE,
  setupPiCtx,
  TUI_MODE,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("phase_ready tool — stub registration", () => {
  beforeEach(() => {
    setTestSettings(null);
    enableSubagentMode();
  });

  afterEach(() => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FF_FEATURE;
  });

  test("returns unsupported when no active workflow", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    expect(phaseReady).toBeDefined();

    const result = await phaseReady.execute("tc-1", {}, undefined, undefined, {
      hasUI: false,
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext);
    expect((result.content[0] as unknown as { text: string }).text).toBe(
      "phase_ready is not supported — no active workflow.",
    );
  });

  test("returns unsupported when workflow exists but currentPhase is null", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    // Write feature state with currentPhase explicitly null (e.g., after reset)
    writeFeatureStateFile("2026-05-20-null-phase", {
      workflow: { currentPhase: null, designDoc: null, planDoc: null },
      featureId: null,
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-null-phase", {}, undefined, undefined, {
      hasUI: false,
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext);
    expect((result.content[0] as unknown as { text: string }).text).toBe(
      "phase_ready is not supported — no active workflow.",
    );
  });

  test("returns unsupported for non-design phases", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    // Explicitly set maxPlanReviewRounds=off to test the execution-handoff path
    setSetting("maxPlanReviewRounds", 0);
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    // Write feature state with plan phase active
    writeFeatureStateFile("2026-05-20-test-feature", {
      workflow: { currentPhase: "plan", designDoc: "docs/ff/designs/test-design.md", planDoc: null },
    });

    // Trigger session_start to load feature state
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, {
      hasUI: false,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-2", {}, undefined, undefined, {
      hasUI: false,
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext);
    // Plan interceptor dispatches ff-implement when maxPlanReviewRounds=off
    expect((result.content[0] as unknown as { text: string }).text).toBe("");
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain('<skill name="ff-implement"');
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("returns no-op for execute phase", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    writeFeatureStateFile("2026-05-20-exec-feature", {
      workflow: {
        currentPhase: "implement",
        designDoc: "docs/ff/designs/exec-design.md",
        planDoc: ".ff/task-plans/exec-task-plan.md",
      },
    });

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, {
      hasUI: false,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-3", {}, undefined, undefined, {
      hasUI: false,
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext);
    expect((result.content[0] as unknown as { text: string }).text).toBe("");
  });
});

describe("phase_ready tool — design non-auto mode", () => {
  beforeEach(() => {
    enableSubagentMode();
    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });
  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FF_FEATURE;
    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("non-auto mode: Proceed completes design, advances to plan, sends ff-plan", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    // Explicitly set maxPlanReviewRounds=off to test the direct-ff-plan path
    setSetting("maxPlanReviewRounds", 0);
    const _slug = writeFeatureStateFile("2026-05-20-proceed-test", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: {
        currentPhase: "design",
        designDoc: "docs/ff/designs/2026-05-20-proceed-test-design.md",
        planDoc: null,
      },
      design: { doc: "docs/ff/designs/2026-05-20-proceed-test-design.md", reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc on disk for artifact recovery
    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/2026-05-20-proceed-test-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Mock UI select to return "Proceed with implementation"
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const _result = await phaseReady.execute("tc-proceed", {}, undefined, undefined, ctx);

    // Verify UI select was called
    expect(selectFn).toHaveBeenCalled();

    // Verify design completed and plan active via persistState's appendEntry
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: {
        featureState: {
          workflow: { currentPhase: "design" | "plan" | "review" | "implement" | "verify" | "uat" | "finish" | null };
        };
      };
      phase: string;
    };
    expect(
      isPhaseDone({ currentPhase: lastEntry.data.featureState.workflow.currentPhase, completedAt: null }, "design"),
    ).toBe(true);
    expect(lastEntry.data.featureState.workflow.currentPhase).toBe("plan");

    // Verify ff-plan skill was sent
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("ff-plan");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("non-auto mode: Discuss returns empty result", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-discuss-test", BRAINSTORM_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Mock UI select to return "Discuss"
    const selectFn = vi.fn().mockResolvedValue("Discuss");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const result = await phaseReady.execute("tc-discuss", {}, undefined, undefined, ctx);

    // Verify no state changes, no messages sent
    expect(fake.sentMessages.length).toBe(0);
    // Tool result should be empty
    expect((result.content[0] as unknown as { text: string }).text).toBe("");
  });

  test("non-auto mode: phase_ready completes design and sends ff-plan skill", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-stage-test", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: "docs/ff/designs/2026-05-20-stage-test-design.md", planDoc: null },
      design: { doc: "docs/ff/designs/2026-05-20-stage-test-design.md", reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc on disk for artifact recovery
    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/2026-05-20-stage-test-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const _result = await phaseReady.execute("tc-stage", {}, undefined, undefined, ctx);

    // Brainstorm completed, plan active
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: {
        featureState: {
          workflow: { currentPhase: "design" | "plan" | "review" | "implement" | "verify" | "uat" | "finish" | null };
        };
      };
      phase: string;
    };
    expect(
      isPhaseDone({ currentPhase: lastEntry.data.featureState.workflow.currentPhase, completedAt: null }, "design"),
    ).toBe(true);
    expect(lastEntry.data.featureState.workflow.currentPhase).toBe("plan");

    // Writing-plans skill sent
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("ff-plan");
  });

  test("non-auto mode: no UI available is a no-op", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-no-ui-test", BRAINSTORM_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      "tc-no-ui",
      {},
      undefined,
      undefined,
      NO_UI_CTX as unknown as ExtensionContext,
    );

    // No state changes, no messages
    expect(fake.sentMessages.length).toBe(0);
    expect((result.content[0] as unknown as { text: string }).text).toBe("");
  });
  test("non-auto mode: issuesFound parameter is accepted without changing behavior", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-real-issues-test", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: {
        currentPhase: "design",
        designDoc: "docs/ff/designs/2026-05-20-real-issues-test-design.md",
        planDoc: null,
      },
      design: { doc: "docs/ff/designs/2026-05-20-real-issues-test-design.md", reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc on disk for artifact recovery
    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/2026-05-20-real-issues-test-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    // Pass issuesFound param — should be accepted without error
    disableSubagentMode();
    const _result = await phaseReady.execute("tc-real-issues", { issuesFound: 3 }, undefined, undefined, ctx);

    // Same behavior as without issuesFound: design completed, plan active
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: {
        featureState: {
          workflow: { currentPhase: "design" | "plan" | "review" | "implement" | "verify" | "uat" | "finish" | null };
        };
      };
      phase: string;
    };
    expect(
      isPhaseDone({ currentPhase: lastEntry.data.featureState.workflow.currentPhase, completedAt: null }, "design"),
    ).toBe(true);
    expect(lastEntry.data.featureState.workflow.currentPhase).toBe("plan");

    // Writing-plans skill sent
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("ff-plan");
  });
});

describe("phase_ready tool — design auto mode", () => {
  beforeEach(() => {
    enableSubagentMode();
    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });
  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FF_FEATURE;
    // Clean up auto-agent callback
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
  });

  test("auto-mode: completes design, calls onFeatureComplete, does not send skill", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = writeFeatureStateFile("2026-05-20-auto-test", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: "docs/ff/designs/2026-05-20-auto-test-design.md", planDoc: null },
      design: { doc: "docs/ff/designs/2026-05-20-auto-test-design.md", reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc on disk for artifact recovery
    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/2026-05-20-auto-test-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    // Set up auto-agent callback mock
    const onFeatureComplete = vi.fn();
    setAutoAgentCallback({
      onFeatureComplete,
      onFeatureError: async () => {},
      isActive: () => true,
    });

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Track call ordering: completeCurrent → persistState → updateWidget → onFeatureComplete
    // Note: completeCurrent is internal to completeBrainstormPhase and not directly tracked here.
    const callOrder: string[] = [];
    // Wrap appendEntry to track persistState calls
    const origAppendEntry = api.appendEntry.bind(api);
    api.appendEntry = (customType: string, data: unknown) => {
      callOrder.push("persistState");
      origAppendEntry(customType, data);
    };
    const setWidget = vi.fn(() => {
      callOrder.push("updateWidget");
    });
    const trackedOnFeatureComplete = vi.fn((...args: unknown[]) => {
      callOrder.push("onFeatureComplete");
      return onFeatureComplete(...args);
    });
    setAutoAgentCallback({
      onFeatureComplete: trackedOnFeatureComplete,
      onFeatureError: async () => {},
      isActive: () => true,
    });

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const _result = await phaseReady.execute("tc-auto", {}, undefined, undefined, ctx);

    // Verify call ordering: persistState → updateWidget → onFeatureComplete
    // (completeCurrent is not directly tracked but runs before persistState)
    expect(callOrder).toEqual(["persistState", "updateWidget", "onFeatureComplete"]);

    // Verify onFeatureComplete was called with the slug
    expect(onFeatureComplete).toHaveBeenCalledWith(slug);

    // Verify design completed via persistState's appendEntry
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: {
        featureState: {
          workflow: { currentPhase: "design" | "plan" | "review" | "implement" | "verify" | "uat" | "finish" | null };
        };
      };
      phase: string;
    };
    expect(
      isPhaseDone({ currentPhase: lastEntry.data.featureState.workflow.currentPhase, completedAt: null }, "design"),
    ).toBe(true);

    // Verify no ff-plan skill sent (auto-agent handles next feature)
    const skillMessages = fake.sentMessages.filter((m: unknown) =>
      (m as { message: string }).message.includes("ff-plan"),
    );
    expect(skillMessages.length).toBe(0);
  });

  test("auto-mode: onFeatureComplete throwing returns error message", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    const _slug = writeFeatureStateFile("2026-05-20-auto-throw", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: "docs/ff/designs/2026-05-20-auto-throw-design.md", planDoc: null },
      design: { doc: "docs/ff/designs/2026-05-20-auto-throw-design.md", reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc on disk for artifact recovery
    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/2026-05-20-auto-throw-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    // Set up auto-agent callback that throws synchronously (async rejection wouldn't be caught by try-catch)
    setAutoAgentCallback({
      onFeatureComplete: vi.fn().mockImplementation(() => {
        throw new Error("kanban connection lost");
      }),
      onFeatureError: async () => {},
      isActive: () => true,
    });

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const result = await phaseReady.execute("tc-auto-throw", {}, undefined, undefined, ctx);

    // Should return an error message from the catch block
    expect((result.content[0] as unknown as { text: string }).text).toContain("phase_ready failed");
    expect((result.content[0] as unknown as { text: string }).text).toContain("kanban connection lost");
  });
});

describe("phase_ready tool — edge cases", () => {
  beforeEach(() => {
    enableSubagentMode();
    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });
  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FF_FEATURE;
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
  });

  test("non-auto: ui.select returning undefined acts like Discuss", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-cancel-test", BRAINSTORM_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const selectFn = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const result = await phaseReady.execute("tc-cancel", {}, undefined, undefined, ctx);

    expect(fake.sentMessages.length).toBe(0);
    expect((result.content[0] as unknown as { text: string }).text).toBe("");
  });

  test("non-auto: no active feature slug returns error", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    // Don't write feature state — no active feature
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    // No session start — no feature loaded
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      "tc-no-slug",
      {},
      undefined,
      undefined,
      NO_UI_CTX as unknown as ExtensionContext,
    );

    expect((result.content[0] as unknown as { text: string }).text).toBe(
      "phase_ready is not supported — no active workflow.",
    );
  });

  test("non-auto: no design doc on disk still proceeds (best-effort)", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-no-artifact", BRAINSTORM_ACTIVE_STATE);

    // Do NOT create design doc on disk
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const _result = await phaseReady.execute("tc-no-artifact", {}, undefined, undefined, ctx);

    // Should still proceed — advanceWorkflowTo("plan") and send ff-plan
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("ff-plan");

    // Verify persisted state: design is derived-done (pointer advanced to plan) — the new
    // pointer model has no artifact gate, so phase_ready completes design best-effort.
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: {
        featureState: {
          workflow: { currentPhase: "design" | "plan" | "review" | "implement" | "verify" | "uat" | "finish" | null };
        };
      };
      phase: string;
    };
    expect(
      isPhaseDone({ currentPhase: lastEntry.data.featureState.workflow.currentPhase, completedAt: null }, "design"),
    ).toBe(true);
    expect(lastEntry.data.featureState.workflow.currentPhase).toBe("plan");
  });

  test("non-auto: error during execution returns error message", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-error-test", BRAINSTORM_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Sabotage setWidget in the guard — updateWidget is called inside phase_ready's try-catch
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: {
        setWidget: () => {
          throw new Error("widget render failed");
        },
        select: selectFn,
      },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const result = await phaseReady.execute("tc-error", {}, undefined, undefined, ctx);

    // Should return an error message from the catch block
    expect((result.content[0] as unknown as { text: string }).text).toContain("phase_ready failed");
  });

  test("auto-mode: no active feature slug returns error", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    setAutoAgentCallback({
      onFeatureComplete: vi.fn(),
      onFeatureError: async () => {},
      isActive: () => true,
    });

    // Write state and start session so workflow state has design phase
    writeFeatureStateFile("2026-05-20-auto-no-slug", BRAINSTORM_ACTIVE_STATE);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    // Clear slug so getActiveFeatureSlug() returns null
    // while workflow state still has currentPhase=design
    _clearActiveFeatureSlug();

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      "tc-auto-no-slug",
      {},
      undefined,
      undefined,
      NO_UI_CTX as unknown as ExtensionContext,
    );

    expect((result.content[0] as unknown as { text: string }).text).toBe(
      "phase_ready failed — no active feature slug.",
    );
  });
});

describe("phase_ready tool — remaining phase stubs", () => {
  const unsupportedPhases: Array<{
    phase: string;
    design: string;
    plan: string;
    execute: string;
    verify: string;
    review: string;
    uat: string;
    finish: string;
  }> = [
    {
      phase: "uat",
      design: "done",
      plan: "done",
      execute: "done",
      verify: "done",
      review: "done",
      uat: "in-progress",
      finish: "pending",
    },
  ];

  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(() => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FF_FEATURE;
  });

  test.each(unsupportedPhases)("returns unsupported for $phase phase", async ({ phase }) => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile(`2026-05-20-${phase}-stub`, {
      workflow: {
        currentPhase: phase,
        designDoc: "docs/ff/designs/test-design.md",
        planDoc: ".ff/task-plans/test-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      `tc-${phase}`,
      {},
      undefined,
      undefined,
      NO_UI_CTX as unknown as ExtensionContext,
    );
    expect((result.content[0] as unknown as { text: string }).text).toBe(`phase_ready is not supported for ${phase}.`);
  });

  test("returns no-op for review phase", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-review-stub", {
      workflow: {
        currentPhase: "review",
        designDoc: "docs/ff/designs/test-design.md",
        planDoc: ".ff/task-plans/test-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      "tc-review",
      {},
      undefined,
      undefined,
      NO_UI_CTX as unknown as ExtensionContext,
    );
    expect((result.content[0] as unknown as { text: string }).text).toBe("");
  });
});

// Mock theme that wraps text with class markers for assertions
const mockTheme = {
  fg: (cls: string, text: string) => `<${cls}>${text}</${cls}>`,
  bold: (text: string) => `<b>${text}</b>`,
} as Theme;

describe("phase_ready tool — renderCall", () => {
  test("renders without stage parameter", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = (phaseReady.renderCall as unknown as (...args: unknown[]) => unknown)(
      {},
      mockTheme,
      {} as unknown,
    ) as unknown;
    expect((result as unknown as { text: string }).text).toContain("<b>phase_ready</b>");
    expect((result as unknown as { text: string }).text).not.toContain("accent");
  });

  test("renders with issuesFound parameter", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = (phaseReady.renderCall as unknown as (...args: unknown[]) => unknown)(
      { issuesFound: 3 },
      mockTheme,
      {} as unknown,
    ) as unknown;
    expect((result as unknown as { text: string }).text).toContain("<b>phase_ready</b>");
    expect((result as unknown as { text: string }).text).toContain("<accent>3 issues</accent>");
  });
});

describe("phase_ready tool — renderResult", () => {
  test("renders success text (empty string)", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const toolResult: unknown = {
      content: [{ type: "text", text: "" }],
      details: null,
    };
    const result = (phaseReady.renderResult as unknown as (...args: unknown[]) => unknown)(
      toolResult as unknown,
      { expanded: true, isPartial: false } as unknown,
      mockTheme as unknown,
      {} as unknown,
    );
    expect((result as unknown as { text: string }).text).toContain("<success>✓ </success>");
  });

  test("renders error text", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const toolResult = {
      content: [{ type: "text" as const, text: "phase_ready is not supported for plan." }],
    };
    const result = (phaseReady.renderResult as unknown as (...args: unknown[]) => unknown)(
      toolResult as unknown,
      { expanded: true, isPartial: false } as unknown,
      mockTheme as unknown,
      {} as unknown,
    );
    expect((result as unknown as { text: string }).text).toContain("<error>✗ </error>");
    expect((result as unknown as { text: string }).text).toContain("not supported for plan");
  });

  test("renders when content has no text", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const toolResult = {
      content: [{ type: "image" as const, data: "abc" }],
    };
    const result = (phaseReady.renderResult as unknown as (...args: unknown[]) => unknown)(
      toolResult as unknown,
      { expanded: true, isPartial: false } as unknown,
      mockTheme as unknown,
      {} as unknown,
    );
    expect((result as unknown as { text: string }).text).toContain("done");
  });

  test("truncates long text to 80 chars with ellipsis", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const longText = "A".repeat(100);
    const toolResult = {
      content: [{ type: "text" as const, text: longText }],
    };
    const result = (phaseReady.renderResult as unknown as (...args: unknown[]) => unknown)(
      toolResult as unknown,
      { expanded: true, isPartial: false } as unknown,
      mockTheme as unknown,
      {} as unknown,
    );
    expect((result as unknown as { text: string }).text).toContain(`${"A".repeat(80)}…`);
    expect((result as unknown as { text: string }).text).not.toContain("A".repeat(81));
  });

  test("does not add ellipsis for exactly 80-char text", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const exactText = "A".repeat(80);
    const toolResult = {
      content: [{ type: "text" as const, text: exactText }],
    };
    const result = (phaseReady.renderResult as unknown as (...args: unknown[]) => unknown)(
      toolResult as unknown,
      { expanded: true, isPartial: false } as unknown,
      mockTheme as unknown,
      {} as unknown,
    );
    expect((result as unknown as { text: string }).text).toContain(exactText);
    expect((result as unknown as { text: string }).text).not.toContain("…");
  });

  test("does not add ellipsis for short text", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const toolResult = {
      content: [{ type: "text" as const, text: "short error" }],
    };
    const result = (phaseReady.renderResult as unknown as (...args: unknown[]) => unknown)(
      toolResult as unknown,
      { expanded: true, isPartial: false } as unknown,
      mockTheme as unknown,
      {} as unknown,
    );
    expect((result as unknown as { text: string }).text).toContain("short error");
    expect((result as unknown as { text: string }).text).not.toContain("…");
  });

  test("renders empty content array as success", async () => {
    const { registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const toolResult: unknown = { content: [], details: null };
    const result = (phaseReady.renderResult as unknown as (...args: unknown[]) => unknown)(
      toolResult as unknown,
      { expanded: true, isPartial: false } as unknown,
      mockTheme as unknown,
      {} as unknown,
    );
    expect((result as unknown as { text: string }).text).toContain("<success>✓ </success>");
    expect((result as unknown as { text: string }).text).toContain("done");
  });
});

describe("phase_ready tool — verify phase", () => {
  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FF_FEATURE;
    // Reset areAllTodosDone override
    const { _setAreAllTodosDoneOverride } = await import("../../src/integrations/todo-integration.js");
    _setAreAllTodosDoneOverride(NO_TODO_OVERRIDE);
    // Reset settings to defaults to prevent leakage between tests
  });

  /** Fire a passing test via tool_call + tool_result to set verifyTestsPassed flag */
  async function firePassingTest(
    onToolCall: (event: ToolCallEvent, ctx: ExtensionContext) => unknown,
    onToolResult: (event: ToolResultEvent, ctx: ExtensionContext) => unknown,
    ctx: ExtensionContext,
    toolCallId: string,
  ) {
    await onToolCall(
      {
        type: "tool_call",
        toolCallId,
        toolName: "bash",
        input: { command: "npx vitest run" },
      } as unknown as ToolCallEvent,
      ctx,
    );
    await onToolResult(
      {
        type: "tool_call",
        toolCallId,
        toolName: "bash",
        input: { command: "npx vitest run" },
        content: [{ type: "text", text: "\n ✓ test 1\n Tests: 1 passed\n" }],
        details: { exitCode: 0 },
      } as unknown as ToolResultEvent,
      ctx,
    );
  }

  test("completes verify phase after tests pass, advances to review, sends review skill", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-31-verify-ready", {
      workflow: {
        currentPhase: "verify",
        designDoc: "docs/ff/designs/2026-05-31-verify-ready-design.md",
        planDoc: ".ff/task-plans/2026-05-31-verify-ready-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const { onToolCall, onToolResult } = getToolHandlers(fake);
    const ctx = { hasUI: false, ui: { setWidget: () => {} } } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx);

    // Fire a passing test to set verifyTestsPassed flag
    await firePassingTest(onToolCall, onToolResult, ctx, "tc-test1");

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-verify-1", {}, undefined, undefined, ctx);

    // Returns empty text (success)
    expect((result.content[0] as unknown as { text: string }).text).toBe("");

    // Verify phase completed, review active
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: {
        featureState: {
          workflow: { currentPhase: "design" | "plan" | "review" | "implement" | "verify" | "uat" | "finish" | null };
        };
      };
      phase: string;
    };
    expect(
      isPhaseDone({ currentPhase: lastEntry.data.featureState.workflow.currentPhase, completedAt: null }, "verify"),
    ).toBe(true);
    expect(lastEntry.data.featureState.workflow.currentPhase).toBe("review");

    // Review skill sent as followUp
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toMatch(/^<skill name="ff-review"/);
    expect(fake.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  test("blocked when tests have not passed", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-31-verify-no-tests", {
      workflow: {
        currentPhase: "verify",
        designDoc: "docs/ff/designs/2026-05-31-verify-no-tests-design.md",
        planDoc: ".ff/task-plans/2026-05-31-verify-no-tests-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const ctx = { hasUI: false, ui: { setWidget: () => {} } } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx);

    // No test run — verifyTestsPassed flag is false
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-verify-no-tests", {}, undefined, undefined, ctx);

    expect((result.content[0] as unknown as { text: string }).text).toContain("Tests have not passed yet");
    expect(fake.sentMessages.length).toBe(0);
  });

  test("with maxFeatureReviewRounds dispatches ff-review skill", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("featureReviewMode", "general");
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-31-verify-review-loops", {
      workflow: {
        currentPhase: "verify",
        designDoc: "docs/ff/designs/2026-05-31-verify-review-loops-design.md",
        planDoc: ".ff/task-plans/2026-05-31-verify-review-loops-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const { onToolCall, onToolResult } = getToolHandlers(fake);
    const ctx = { hasUI: false, ui: { setWidget: () => {} } } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx);

    // Fire a passing test to set verifyTestsPassed flag
    await firePassingTest(onToolCall, onToolResult, ctx, "tc-test1");

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-verify-loops", {}, undefined, undefined, ctx);

    expect((result.content[0] as unknown as { text: string }).text).toBe("");
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toContain('<skill name="ff-review"');
    expect(fake.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  test("no active feature slug returns error", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-31-verify-no-slug", {
      workflow: {
        currentPhase: "verify",
        designDoc: "docs/ff/designs/2026-05-31-verify-no-slug-design.md",
        planDoc: ".ff/task-plans/2026-05-31-verify-no-slug-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX as unknown as ExtensionContext);

    _clearActiveFeatureSlug();

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-verify-no-slug", {}, undefined, undefined, {
      hasUI: false,
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext);

    expect((result.content[0] as unknown as { text: string }).text).toBe(
      "phase_ready failed — no active feature slug.",
    );
  });

  test("verify phase already complete — gate blocks (phase not active, no test flag set)", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-31-verify-already-complete", {
      workflow: {
        currentPhase: "verify",
        designDoc: "docs/ff/designs/2026-05-31-verify-already-complete-design.md",
        planDoc: ".ff/task-plans/2026-05-31-verify-already-complete-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const ctx = { hasUI: false, ui: { setWidget: () => {} } } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-verify-done", {}, undefined, undefined, ctx);

    // Phase is already complete so tool_result handler won't set verifyTestsPassed
    // (it checks currentPhase === 'verify'). Gate blocks with test-passed error.
    expect((result.content[0] as unknown as { text: string }).text).toContain("Tests have not passed yet");
    expect(fake.sentMessages.length).toBe(0);
  });

  test("todo gate: active todos block transition even when tests pass", async () => {
    const { _setAreAllTodosDoneOverride } = await import("../../src/integrations/todo-integration.js");
    _setAreAllTodosDoneOverride(NOT_ALL_TODOS_DONE);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-31-verify-todo-block", {
      workflow: {
        currentPhase: "verify",
        designDoc: "docs/ff/designs/2026-05-31-verify-todo-block-design.md",
        planDoc: ".ff/task-plans/2026-05-31-verify-todo-block-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const { onToolCall, onToolResult } = getToolHandlers(fake);
    // Active todo items in session branch
    const ctx = {
      hasUI: false,
      sessionManager: {
        getSessionFile: () => "/tmp/session.jsonl",
      },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx);

    // Fire a passing test to set verifyTestsPassed flag
    await firePassingTest(onToolCall, onToolResult, ctx, "tc-test1");

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-verify-todo-block", {}, undefined, undefined, ctx);

    // Todo gate blocks transition
    expect((result.content[0] as unknown as { text: string }).text).toContain("Not all todos are complete");
    expect(fake.sentMessages.length).toBe(0);
  });

  test("todo gate: all-done todos allow transition when tests pass", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-31-verify-todo-done", {
      workflow: {
        currentPhase: "verify",
        designDoc: "docs/ff/designs/2026-05-31-verify-todo-done-design.md",
        planDoc: ".ff/task-plans/2026-05-31-verify-todo-done-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const { onToolCall, onToolResult } = getToolHandlers(fake);
    // All todos completed/decomposed
    const ctx = {
      hasUI: false,
      sessionManager: {
        getSessionFile: () => "/tmp/session.jsonl",
      },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx);

    // Fire a passing test to set verifyTestsPassed flag
    await firePassingTest(onToolCall, onToolResult, ctx, "tc-test1");

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-verify-todo-done", {}, undefined, undefined, ctx);

    // All todos done — transition succeeds
    expect((result.content[0] as unknown as { text: string }).text).toBe("");
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toMatch(/^<skill name="ff-review"/);
  });

  test("todo gate: no todos (fail-open) allows transition when tests pass", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-31-verify-no-todos", {
      workflow: {
        currentPhase: "verify",
        designDoc: "docs/ff/designs/2026-05-31-verify-no-todos-design.md",
        planDoc: ".ff/task-plans/2026-05-31-verify-no-todos-task-plan.md",
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const { onToolCall, onToolResult } = getToolHandlers(fake);
    // Empty branch — no todos at all (fail-open)
    const ctx = {
      hasUI: false,
      sessionManager: {
        getSessionFile: () => "/tmp/session.jsonl",
      },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx);

    // Fire a passing test to set verifyTestsPassed flag
    await firePassingTest(onToolCall, onToolResult, ctx, "tc-test1");

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-verify-no-todos", {}, undefined, undefined, ctx);

    // No todos — fail-open allows transition
    expect((result.content[0] as unknown as { text: string }).text).toBe("");
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toMatch(/^<skill name="ff-review"/);
  });
});

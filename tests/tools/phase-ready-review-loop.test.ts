// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { setAutoAgentCallback } from "../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { isPhaseDone } from "../../src/phases/phase-progression.js";
import type { PiWorkflowMonitorBridge } from "../../src/shared/types.js";
import { getGuardrailsRef, getPhaseReadyRef } from "../../src/shared/workflow-refs.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  BRAINSTORM_ACTIVE_STATE,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  NO_AUTO_AGENT_CALLBACK,
  NO_UI_CTX,
  PLAN_ACTIVE_STATE,
  settleAndDrainPostTurnFollowUp,
  setupPiCtx,
  TUI_MODE,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("phase_ready review loop — design phase", () => {
  beforeEach(() => {
    setTestSettings(null);
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("design: issuesFound>0 loops and sends followUp", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-design-loop", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = await phaseReady.execute("tc-loop-1", { issuesFound: 3 }, undefined, undefined, NO_UI_CTX);

    // Should return empty success (looping)
    expect((result.content[0] as { text: string }).text).toBe("");

    // Should have incremented designReviewLoopCount in persisted state

    const state = loadFeatureState("2026-05-20-design-loop", null);
    expect(state?.design.reviewLoopCount).toBe(2);

    // Should have recorded review history for this iteration
    expect(state?.review.reviewHistory).toHaveLength(1);
    expect(state?.review.reviewHistory?.[0]).toMatchObject({ phase: "design", loopNumber: 0, issuesFound: 3 });

    // Should have sent a followUp message to run next iteration
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("design review iteration");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("design: records cannotFix and falsePositives passed via phase_ready (no longer hardcoded 0)", async () => {
    // The design/plan review skills track dismissed findings (false-positive / cannot-fix)
    // in the known-issues file. phase_ready now accepts cannotFix/falsePositives for
    // design/plan too, and handleReviewLoop records them instead of hardcoding 0 —
    // so the report shows real values per phase instead of 0s.
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-design-cf-fp", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute(
      "tc-cf-fp",
      { issuesFound: 4, cannotFix: 1, falsePositives: 2 },
      undefined,
      undefined,
      NO_UI_CTX,
    );

    const state = loadFeatureState("2026-05-20-design-cf-fp", null);
    expect(state?.review.reviewHistory?.[0]).toMatchObject({
      phase: "design",
      loopNumber: 0,
      issuesFound: 4,
      cannotFixIssues: 1,
      falsePositives: 2,
    });
  });

  test("design: looping followUp is numbered for the NEXT iteration (#2 after iteration #1)", async () => {
    // Regression: reviewLoopCount is incremented at iteration START, so after
    // iteration #1 (count=1) the next pass is #2. The followUp message must say
    // "#2", not re-emit "#1". Off-by-one here also corrupts the compaction note.
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-design-numbering", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = await phaseReady.execute("tc-numbering-1", { issuesFound: 1 }, undefined, undefined, NO_UI_CTX);

    expect((result.content[0] as { text: string }).text).toBe("");

    const state = loadFeatureState("2026-05-20-design-numbering", null);
    expect(state?.design.reviewLoopCount).toBe(2);

    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
    // Must reference the next iteration (#2), not re-emit the completed #1.
    expect((lastMessage as { message?: string }).message).toContain("design review iteration #2");
    expect((lastMessage as { message?: string }).message).not.toContain("design review iteration #1");
  });

  test("design: issuesFound=0 does NOT loop, falls through to existing logic", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const docPath = "docs/featyard/designs/2026-05-20-design-noloop-design.md";
    writeFeatureStateFile("2026-05-20-design-noloop", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: docPath, planDoc: null },
      design: { doc: docPath, reviewActive: false, reviewLoopCount: 1 },
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync(docPath, "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Mock UI select for design completion
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    };
    disableSubagentMode();
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    await phaseReady.execute(
      "tc-noloop-1",
      { issuesFound: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should have fallen through to existing design completion logic
    // UI select should have been called
    expect(selectFn).toHaveBeenCalled();

    // Should have recorded review history even for the final (non-looping) iteration

    const state = loadFeatureState("2026-05-20-design-noloop", null);
    expect(state?.review.reviewHistory).toHaveLength(1);
    expect(state?.review.reviewHistory?.[0]).toMatchObject({ phase: "design", loopNumber: 0, issuesFound: 0 });

    // Brainstorm completed, plan active
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: { featureState: { workflow: { currentPhase: string } } };
      phase: string;
    };
    expect(
      isPhaseDone(
        {
          currentPhase: lastEntry.data.featureState.workflow.currentPhase as
            | "design"
            | "plan"
            | "review"
            | "implement"
            | "verify"
            | "uat"
            | "finish"
            | null,
          completedAt: null,
        },
        "design",
      ),
    ).toBe(true);
    expect(lastEntry.data.featureState.workflow.currentPhase).toBe("plan");

    // Writing-plans skill sent
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("fy-plan");
  });

  test("design: without issuesFound defaults to 0, falls through to existing logic", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const docPath = "docs/featyard/designs/2026-05-20-design-undef-design.md";
    writeFeatureStateFile("2026-05-20-design-undef", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: docPath, planDoc: null },
      design: { doc: docPath, reviewActive: false, reviewLoopCount: 1 },
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync(docPath, "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Mock UI select for design completion
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    };
    disableSubagentMode();
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    // Call WITHOUT issuesFound — should default to 0 and fall through
    await phaseReady.execute("tc-undef-1", {}, undefined, undefined, ctx as unknown as ExtensionContext);

    // Should have fallen through to existing design completion logic
    expect(selectFn).toHaveBeenCalled();

    // Brainstorm completed, plan active
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: { featureState: { workflow: { currentPhase: string } } };
      phase: string;
    };
    expect(
      isPhaseDone(
        {
          currentPhase: lastEntry.data.featureState.workflow.currentPhase as
            | "design"
            | "plan"
            | "review"
            | "implement"
            | "verify"
            | "uat"
            | "finish"
            | null,
          completedAt: null,
        },
        "design",
      ),
    ).toBe(true);
    expect(lastEntry.data.featureState.workflow.currentPhase).toBe("plan");
  });

  test("design: maxPlanReviewRounds=off falls through immediately", async () => {
    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const docPath = "docs/featyard/designs/2026-05-20-design-off-design.md";
    writeFeatureStateFile("2026-05-20-design-off", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: docPath, planDoc: null },
      design: { doc: docPath, reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync(docPath, "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Mock UI select for design completion
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    };
    disableSubagentMode();
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    await phaseReady.execute("tc-off-1", { issuesFound: 5 }, undefined, undefined, ctx as unknown as ExtensionContext);

    // Should fall through to existing design completion (not loop)
    expect(selectFn).toHaveBeenCalled();
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: { featureState: { workflow: { currentPhase: string } } };
      phase: string;
    };
    expect(lastEntry.data.featureState.workflow.currentPhase).toBe("plan");
  });

  test("design: minReviewLoops enforcement — loops even with issuesFound=0", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 2);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-design-min", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First iteration: loopCount=0, issuesFound=0, but min=2 not met → should loop
    const result = await phaseReady.execute("tc-min-1", { issuesFound: 0 }, undefined, undefined, NO_UI_CTX);

    expect((result.content[0] as { text: string }).text).toBe("");

    const state = loadFeatureState("2026-05-20-design-min", null);
    expect(state?.design.reviewLoopCount).toBe(2);

    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("design review iteration");
  });

  test("design: missing featureState returns error", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const docPath = "docs/featyard/designs/2026-05-20-design-nullstate-design.md";
    writeFeatureStateFile("2026-05-20-design-nullstate", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: docPath, planDoc: null },
      design: { doc: docPath, reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync(docPath, "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    // SOTS: the handler holds the active feature in memory, so deleting the file
    // no longer makes it "missing". Clear the in-memory record instead to
    // exercise the no-active-feature defensive path (currentPhase is retained).
    const bridge = globalThis.__piWorkflowMonitor as PiWorkflowMonitorBridge;
    bridge?.handler?.setActiveFeatureState(null);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Mock UI select for design completion (fall-through path)
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    };
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const result = await phaseReady.execute(
      "tc-nullstate-1",
      { issuesFound: 2 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // No active feature → defensive error (slug missing in the SOTS model)
    expect((result.content[0] as { text: string }).text).toContain("no active feature slug");
  });
});

describe("phase_ready review loop — plan phase", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("plan: issuesFound>0 loops and sends followUp", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-loop", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = await phaseReady.execute("tc-plan-loop-1", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    // Should return empty success (looping)
    expect((result.content[0] as { text: string }).text).toBe("");

    // Should have incremented planReviewLoopCount (in-memory via loadFeatureState reads from disk)

    const state = loadFeatureState("2026-05-20-plan-loop", null);
    expect(state?.plan.reviewLoopCount).toBe(2);

    // Should have recorded review history for this iteration
    expect(state?.review.reviewHistory).toHaveLength(1);
    expect(state?.review.reviewHistory?.[0]).toMatchObject({ phase: "plan", loopNumber: 0, issuesFound: 2 });

    // Verify persisted state on disk (raw JSON, independent of loadFeatureState backward-compat logic)
    const statePath = path.join(".featyard", "feature-state", "2026-05-20-plan-loop.json");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(persisted.plan.reviewLoopCount).toBe(2);

    // Should have sent followUp
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("plan review iteration");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("plan: issuesFound=0 returns no-op (does NOT loop)", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-noloop", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = await phaseReady.execute("tc-plan-noloop-1", { issuesFound: 0 }, undefined, undefined, NO_UI_CTX);

    // Should return empty success (not looping)
    expect((result.content[0] as { text: string }).text).toBe("");

    // Should have recorded review history even for the final (non-looping) iteration

    const state = loadFeatureState("2026-05-20-plan-noloop", null);
    expect(state?.review.reviewHistory).toHaveLength(1);
    expect(state?.review.reviewHistory?.[0]).toMatchObject({ phase: "plan", loopNumber: 0, issuesFound: 0 });

    // Should have advanced plan → implement and dispatched the fy-implement skill
    const state2 = loadFeatureState("2026-05-20-plan-noloop", null);
    expect(state2?.workflow.currentPhase).toBe("implement");
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain('<skill name="fy-implement"');
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("plan: without issuesFound defaults to 0, returns no-op", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-undef", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Call WITHOUT issuesFound — should default to 0 and return no-op
    const result = await phaseReady.execute("tc-plan-undef-1", {}, undefined, undefined, NO_UI_CTX);

    // Should return empty success (not looping)
    expect((result.content[0] as { text: string }).text).toBe("");

    // Should have advanced plan → implement and dispatched the fy-implement skill
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain('<skill name="fy-implement"');
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("plan: stage=undefined (no review iteration) sends plan-review skill", async () => {
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-nostage", PLAN_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = await phaseReady.execute("tc-plan-nostage", {}, undefined, undefined, NO_UI_CTX);

    // Should send plan-review skill as followUp
    expect((result.content[0] as { text: string }).text).toBe("");
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("fy-plan-review");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("plan: maxPlanReviewRounds=off does not loop, returns no-op", async () => {
    setSetting("maxPlanReviewRounds", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-off", PLAN_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = await phaseReady.execute("tc-plan-off-1", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);

    // Should fall through — plan phase, not looping, dispatches fy-implement
    expect((result.content[0] as { text: string }).text).toBe("");
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain('<skill name="fy-implement"');
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("plan: minReviewLoops enforcement — loops even with issuesFound=0", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 2);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-min", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = await phaseReady.execute("tc-plan-min-1", { issuesFound: 0 }, undefined, undefined, NO_UI_CTX);

    expect((result.content[0] as { text: string }).text).toBe("");

    const state = loadFeatureState("2026-05-20-plan-min", null);
    expect(state?.plan.reviewLoopCount).toBe(2);

    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("plan review iteration");
  });

  test("design: loop limit exhaustion — does NOT loop when numeric limit reached with issuesFound>0", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const docPath = "docs/featyard/designs/2026-05-20-design-limit-design.md";
    writeFeatureStateFile("2026-05-20-design-limit", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: docPath, planDoc: null },
      design: { doc: docPath, reviewActive: false, reviewLoopCount: 3 },
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync(docPath, "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Even with issuesFound=5, should NOT loop because loopsCompleted=3 >= max=3
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const uiCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    };
    setupPiCtx(uiCtx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    await phaseReady.execute(
      "tc-limit-1",
      { issuesFound: 5 },
      undefined,
      undefined,
      uiCtx as unknown as ExtensionContext,
    );

    // Should NOT loop — limit reached, falls through to design completion
    expect(selectFn).toHaveBeenCalled();
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: { featureState: { workflow: { currentPhase: string } } };
      phase: string;
    };
    expect(
      isPhaseDone(
        {
          currentPhase: lastEntry.data.featureState.workflow.currentPhase as
            | "design"
            | "plan"
            | "review"
            | "implement"
            | "verify"
            | "uat"
            | "finish"
            | null,
          completedAt: null,
        },
        "design",
      ),
    ).toBe(true);
    expect(lastEntry.data.featureState.workflow.currentPhase).toBe("plan");
  });

  test("plan: loop limit exhaustion — does NOT loop when numeric limit reached with issuesFound>0", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-limit", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 3 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Even with issuesFound=5, should NOT loop because loopsCompleted=3 >= max=3
    const result = await phaseReady.execute("tc-plan-limit-1", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);

    // Should return no-op (not looping), dispatches fy-implement
    expect((result.content[0] as { text: string }).text).toBe("");
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain('<skill name="fy-implement"');
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("plan: missing featureState returns error", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-nullstate", PLAN_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    // SOTS: clear the in-memory active record to exercise the defensive path.
    const bridge = globalThis.__piWorkflowMonitor as PiWorkflowMonitorBridge;
    bridge?.handler?.setActiveFeatureState(null);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    const result = await phaseReady.execute("tc-plan-nullstate-1", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    // No active feature → defensive error (slug missing in the SOTS model)
    expect((result.content[0] as { text: string }).text).toContain("no active feature slug");
  });
});

describe("phase_ready — unsupported phases", () => {
  const unsupportedPhases = ["uat"];
  const noOpPhases = ["implement", "review"];

  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;

    setSetting("maxPlanReviewRounds", 0);
  });

  for (const phase of unsupportedPhases) {
    test(`${phase}: returns error (not supported)`, async () => {
      setSetting("maxPlanReviewRounds", 3);

      const { fake, registeredTools, api } = createPiWithToolCapture();
      const slug = `unsupported-${phase}-test`;
      writeFeatureStateFile(slug, {
        workflow: {
          phases: {
            design: "done",
            plan: "done",
            execute: phase === "implement" ? "in-progress" : "done",
            verify: phase === "verify" ? "in-progress" : phase === "implement" ? "pending" : "done",
            review: phase === "review" ? "in-progress" : ["implement", "verify"].includes(phase) ? "pending" : "done",
            uat: phase === "uat" ? "in-progress" : "pending",
            finish: "pending",
          },
          currentPhase: phase,
          artifacts: {
            design: "docs/featyard/designs/test-design.md",
            plan: "docs/plans/test-plan.md",
            implement: null,
            verify: null,
            review: null,
            uat: null,
            finish: null,
          },
        },
      });

      await workflowMonitorExtension(api as unknown as ExtensionAPI);

      await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

      const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

      const result = await phaseReady.execute(
        `tc-${phase}-unsupported`,
        { issuesFound: 1 },
        undefined,
        undefined,
        NO_UI_CTX,
      );

      // Should return error message — not supported for this phase
      expect((result.content[0] as { text: string }).text).toContain("not supported");
    });
  }

  for (const phase of noOpPhases) {
    test(`${phase}: returns no-op (empty)`, async () => {
      setSetting("maxPlanReviewRounds", 3);

      const { fake, registeredTools, api } = createPiWithToolCapture();
      const slug = `noop-${phase}-test`;
      writeFeatureStateFile(slug, {
        workflow: {
          phases: {
            design: "done",
            plan: "done",
            execute: phase === "implement" ? "in-progress" : "done",
            verify: phase === "verify" ? "in-progress" : phase === "implement" ? "pending" : "done",
            review: phase === "review" ? "in-progress" : ["implement", "verify"].includes(phase) ? "pending" : "done",
            uat: "pending",
            finish: "pending",
          },
          currentPhase: phase,
          artifacts: {
            design: "docs/featyard/designs/test-design.md",
            plan: "docs/plans/test-plan.md",
            implement: null,
            verify: null,
            review: null,
            uat: null,
            finish: null,
          },
        },
      });

      await workflowMonitorExtension(api as unknown as ExtensionAPI);

      await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

      const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

      const result = await phaseReady.execute(`tc-${phase}-noop`, { issuesFound: 1 }, undefined, undefined, NO_UI_CTX);

      expect((result.content[0] as { text: string }).text).toBe("");
    });
  }
});

describe("phase_ready — design/plan loop count independence", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("incrementing designReviewLoopCount does not affect planReviewLoopCount", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    // Start with both counters at 1 to verify independence (maxPlanReviewRounds=3 allows up to 3)
    writeFeatureStateFile("independence-test", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 2 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Trigger a design review loop (increments designReviewLoopCount)
    await phaseReady.execute("tc-indep-1", { issuesFound: 1 }, undefined, undefined, NO_UI_CTX);

    const state = loadFeatureState("independence-test", null);

    // designReviewLoopCount should have incremented from 1 to 2
    expect(state?.design.reviewLoopCount).toBe(2);
    // planReviewLoopCount should be unchanged at 2
    expect(state?.plan.reviewLoopCount).toBe(2);
  });

  test("incrementing planReviewLoopCount does not affect designReviewLoopCount", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("independence-test-2", {
      ...PLAN_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 5 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Trigger a plan review loop (increments planReviewLoopCount)
    await phaseReady.execute("tc-indep-2", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    const state = loadFeatureState("independence-test-2", null);

    // planReviewLoopCount should have incremented from 1 to 2
    expect(state?.plan.reviewLoopCount).toBe(2);
    // designReviewLoopCount should be unchanged at 5
    expect(state?.design.reviewLoopCount).toBe(5);
  });
});

describe("phase_ready — loop count is durable in feature state after increment", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_REVIEW_LOOP;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("design loop increment is durable in feature state", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("env-sync-design", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Before: designReviewLoopCount is 0 (the durable source of truth read by
    // subagent-integration review-subagent model routing + report paths).
    expect(loadFeatureState("env-sync-design", null)?.design.reviewLoopCount ?? null).toBe(0);

    // Trigger design review loop
    await phaseReady.execute("tc-env-1", { issuesFound: 1 }, undefined, undefined, NO_UI_CTX);

    // After: designReviewLoopCount incremented from 0 to 1 in feature state.
    expect(loadFeatureState("env-sync-design", null)?.design.reviewLoopCount).toBe(1);
  });

  test("plan first iteration publishes its count to feature state (parity with design)", async () => {
    // Regression: the first-iteration branch used to gate env/widget sync behind
    // syncOnFirstIteration, which was true for design but false for plan (an
    // accident preserved from duplicated code). So on plan review's FIRST pass,
    // startReviewIteration bumped plan.reviewLoopCount 0->1 but never published
    // it, leaving the count stale at 0. The only reader is subagent-integration
    // (review-subagent model routing), which now reads feature-state directly —
    // so the count must be incremented there.
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("env-sync-plan-first", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Before: planReviewLoopCount is 0
    expect(loadFeatureState("env-sync-plan-first", null)?.plan.reviewLoopCount ?? null).toBe(0);

    // Trigger plan review FIRST iteration (reviewLoopCount 0 -> 1)
    await phaseReady.execute("tc-env-plan-first", { issuesFound: 1 }, undefined, undefined, NO_UI_CTX);

    // After: must be 1 — the counter was published to feature state (parity with design).
    expect(loadFeatureState("env-sync-plan-first", null)?.plan.reviewLoopCount).toBe(1);
  });

  test("plan loop increment is durable in feature state", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("env-sync-plan", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Before: planReviewLoopCount is 1
    expect(loadFeatureState("env-sync-plan", null)?.plan.reviewLoopCount ?? null).toBe(1);

    // Trigger plan review loop
    await phaseReady.execute("tc-env-2", { issuesFound: 3 }, undefined, undefined, NO_UI_CTX);

    // After: planReviewLoopCount incremented from 1 to 2 in feature state.
    expect(loadFeatureState("env-sync-plan", null)?.plan.reviewLoopCount).toBe(2);
  });
});

describe("phase_ready interceptors — design phase", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("design: phase_ready without stage + maxPlanReviewRounds=on sends design-review skill", async () => {
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const docPath = "docs/featyard/designs/2026-05-20-design-intercept-design.md";
    writeFeatureStateFile("2026-05-20-design-intercept", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: docPath, planDoc: null },
      design: { doc: docPath, reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc for artifact
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync(docPath, "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Mock UI — user chooses "Proceed"
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    };
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    await phaseReady.execute("tc-intercept", {}, undefined, undefined, ctx as unknown as ExtensionContext);

    // Should send design-review skill as followUp
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("fy-design-review");
    expect((lastMessage as { message?: string }).message).toContain("**Feature:** `2026-05-20-design-intercept`");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");

    // Should have set designReviewLoopCount = 1 (started signal)

    const state = loadFeatureState("2026-05-20-design-intercept", null);
    expect(state?.design.reviewLoopCount).toBe(1);
    // Interceptor must NOT record reviewHistory — that happens on the review_iteration callback
    expect(state?.review.reviewHistory ?? []).toHaveLength(0);
  });

  test("design: interceptor does NOT re-trigger when designReviewLoopCount > 0", async () => {
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const docPath = "docs/featyard/designs/2026-05-20-design-reentry-design.md";
    writeFeatureStateFile("2026-05-20-design-reentry", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: docPath, planDoc: null },
      design: { doc: docPath, reviewActive: false, reviewLoopCount: 2 },
    });

    // Create design doc for artifact
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync(docPath, "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Mock UI — user chooses "Proceed"
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    };
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    await phaseReady.execute("tc-reentry", {}, undefined, undefined, ctx as unknown as ExtensionContext);

    // Should NOT send design-review — interceptor must be skipped
    const skillMessages = fake.sentMessages.filter(
      (m) =>
        typeof (m as { message?: string }).message === "string" &&
        (m as { message: string }).message.includes("fy-design-review"),
    );
    expect(skillMessages).toHaveLength(0);

    // Should have fallen through to design completion (select was called)
    expect(selectFn).toHaveBeenCalled();

    // Brainstorm should be completed
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1] as {
      data: { featureState: { workflow: { currentPhase: string } } };
      phase: string;
    };
    expect(
      isPhaseDone(
        {
          currentPhase: lastEntry.data.featureState.workflow.currentPhase as
            | "design"
            | "plan"
            | "review"
            | "implement"
            | "verify"
            | "uat"
            | "finish"
            | null,
          completedAt: null,
        },
        "design",
      ),
    ).toBe(true);
  });

  test("design: interceptor returns error when featureState is null", async () => {
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const docPath = "docs/featyard/designs/2026-05-20-design-null-state-design.md";
    writeFeatureStateFile("2026-05-20-design-null-state", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: docPath, planDoc: null },
      design: { doc: docPath, reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc for artifact
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync(docPath, "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // SOTS: clear the in-memory active record to simulate a null feature state
    // (deleting the file no longer makes the in-memory record missing).
    const bridge = globalThis.__piWorkflowMonitor as PiWorkflowMonitorBridge;
    bridge?.handler?.setActiveFeatureState(null);

    // Mock UI — user chooses "Proceed"
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    };
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    disableSubagentMode();
    const result = await phaseReady.execute(
      "tc-design-null",
      {},
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    expect((result.content[0] as { text: string }).text).toContain("no active feature slug");
  });

  test("design: review_iteration loop gate sends skill with context prefix", async () => {
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-design-loopgate", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    await phaseReady.execute("tc-loopgate", { issuesFound: 3 }, undefined, undefined, NO_UI_CTX);

    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("fy-design-review");
    expect((lastMessage as { message?: string }).message).toContain("**Feature:** `2026-05-20-design-loopgate`");
    expect((lastMessage as { message?: string }).message).toContain("Dispatch reviewer"); // review method substituted into {{PI_FY_REVIEW_METHOD}}
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("design: review_iteration clamps negative issuesFound to 0", async () => {
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-design-negative", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    await phaseReady.execute("tc-negative", { issuesFound: -1 }, undefined, undefined, NO_UI_CTX);

    // reviewHistory should clamp issuesFound to 0, not -1

    const state = loadFeatureState("2026-05-20-design-negative", null);
    expect(state?.review.reviewHistory).toBeDefined();
    expect(state?.review.reviewHistory?.length).toBeGreaterThan(0);
    const lastEntry = state?.review.reviewHistory?.[state?.review.reviewHistory?.length - 1];
    if (!lastEntry) throw new Error("no review history entry");
    expect(lastEntry.issuesFound).toBe(0);
  });

  test("design: subagent mode includes dispatch instruction in review method", async () => {
    setSetting("maxPlanReviewRounds", 3);
    // planReviewMode defaults to 'parallel-subagents'

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-design-subagent", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    await phaseReady.execute("tc-subagent", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    // FollowUp should contain subagent dispatch in review method
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("subagent");
    expect((lastMessage as { message?: string }).message).toContain("fy-design-reviewer");
    expect((lastMessage as { message?: string }).message).toContain("2026-05-20-design-subagent-design.md");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("design: in-session mode includes expanded design-review skill in review method", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("planReviewMode", "in-session");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-design-insession", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    await phaseReady.execute("tc-insession", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    // FollowUp should contain expanded design-review skill content (not subagent dispatch)
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("fy-design-review");
    expect((lastMessage as { message?: string }).message).not.toContain("Dispatch reviewer: subagent");
    expect((lastMessage as { message?: string }).message).not.toContain("fy-design-reviewer");
    expect((lastMessage as { message?: string }).message).toContain("**Feature:** `2026-05-20-design-insession`");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });
});

describe("phase_ready interceptors — plan phase", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("plan: phase_ready without stage + maxPlanReviewRounds=on sends plan-review skill", async () => {
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-intercept", PLAN_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    await phaseReady.execute("tc-plan-intercept", {}, undefined, undefined, NO_UI_CTX);

    // Should send plan-review skill as followUp
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("fy-plan-review");
    expect((lastMessage as { message?: string }).message).toContain("**Feature:** `2026-05-20-plan-intercept`");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");

    // Should have set planReviewLoopCount = 1

    const state = loadFeatureState("2026-05-20-plan-intercept", null);
    expect(state?.plan.reviewLoopCount).toBe(1);
    // Interceptor must NOT record reviewHistory — that happens on the review_iteration callback
    expect(state?.review.reviewHistory ?? []).toHaveLength(0);
  });

  test("plan: interceptor does NOT re-trigger when planReviewLoopCount > 0", async () => {
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-reentry", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 2 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    await phaseReady.execute("tc-plan-reentry", {}, undefined, undefined, NO_UI_CTX);

    // Should NOT send plan-review — interceptor must be skipped
    const skillMessages = fake.sentMessages.filter(
      (m) =>
        typeof (m as { message?: string }).message === "string" &&
        (m as { message: string }).message.includes("fy-plan-review"),
    );
    expect(skillMessages).toHaveLength(0);

    // Should have fallen through to execution: advanced plan → implement + dispatched fy-implement
    const state = loadFeatureState("2026-05-20-plan-reentry", null);
    expect(state?.workflow.currentPhase).toBe("implement");
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain('<skill name="fy-implement"');
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("plan: parallel-subagents mode includes dispatch instruction in review method", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("planReviewMode", "parallel-subagents");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-subagent", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    await phaseReady.execute("tc-plan-subagent", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    // FollowUp should contain plan-reviewer subagent dispatch
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("fy-plan-reviewer");
    expect((lastMessage as { message?: string }).message).toContain("Dispatch reviewer");
    expect((lastMessage as { message?: string }).message).toContain("fy-plan-review");
    expect((lastMessage as { message?: string }).message).toContain("**Feature:** `2026-05-20-plan-subagent`");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("plan: in-session mode includes inline review instructions in review method", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("planReviewMode", "in-session");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-insession", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    await phaseReady.execute("tc-plan-insession", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    // FollowUp should contain inline plan review instructions (not subagent dispatch)
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect((lastMessage as { message?: string }).message).toContain("Review the plan against the design");
    expect((lastMessage as { message?: string }).message).not.toContain("Dispatch reviewer: subagent");
    expect((lastMessage as { message?: string }).message).not.toContain("fy-plan-reviewer");
    expect((lastMessage as { message?: string }).message).toContain("**Feature:** `2026-05-20-plan-insession`");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("plan: interceptor returns error when featureState is null", async () => {
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-20-plan-null-state", PLAN_ACTIVE_STATE);

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // SOTS: clear the in-memory active record to simulate a null feature state
    const bridge = globalThis.__piWorkflowMonitor as PiWorkflowMonitorBridge;
    bridge?.handler?.setActiveFeatureState(null);

    const result = await phaseReady.execute("tc-plan-null", {}, undefined, undefined, NO_UI_CTX);

    expect((result.content[0] as { text: string }).text).toContain("no active feature slug");
  });
});

// The implement→verify transition is owned by task_ready_advance. phase_ready's
// implement branch is a defensive no-op — the machinery never runs from phase_ready.
describe("phase_ready — implement branch is a no-op (machinery relocated to task_ready_advance)", () => {
  const slug = "2026-07-03-phase-ready-implement-noop";

  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;
    setSetting("maxFeatureReviewRounds", 0);
  });

  test("phase_ready in implement does NOT run the implement→verify machinery", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute("tc-pr-impl", {}, undefined, undefined, NO_UI_CTX);

    // Defensive no-op — the machinery never runs from phase_ready (relocated to
    // task_ready_advance's last-task branch).
    expect((result.content[0] as { text: string }).text).toBe("");
    expect(fake.sentMessages.length).toBe(0);
    const state = loadFeatureState(slug, null);
    expect(state?.workflow.currentPhase).toBe("implement");
  });
});

describe("phase_ready — code review loop deduplication within same turn", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;

    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 0);
  });

  test("multiple phase_ready calls in same turn only trigger one review loop iteration", async () => {
    // Regression: when the agent calls phase_ready multiple times during its turn
    // (e.g. confused by the ✓ done response), each call should NOT independently
    // trigger a review-loop iteration. Only the first call should process;
    // subsequent calls in the same turn are no-ops.
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-04-review-dedup";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "review",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
      review: { reviewLoopCount: 1, reviewActive: false },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First call — should process normally
    const result1 = await phaseReady.execute("tc-dedup-1", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect((result1.content[0] as { text: string }).text).toBe("");

    // Second call in the same turn — should be a no-op (guard prevents double-processing)
    const result2 = await phaseReady.execute("tc-dedup-2", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect((result2.content[0] as { text: string }).text).toBe("");

    // Third call — also a no-op
    const result3 = await phaseReady.execute("tc-dedup-3", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect((result3.content[0] as { text: string }).text).toBe("");

    // reviewLoopCount should have incremented by exactly 1 (not 3)
    const state = loadFeatureState(slug, null);
    expect(state?.review.reviewLoopCount).toBe(2); // started at 1, incremented once

    // Only one review history entry should be recorded
    expect(state?.review.reviewHistory).toHaveLength(1);

    // The followUp is STAGED during the turn (not sent inline), so nothing sent yet.
    const sentDuringTurn = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    ).length;
    expect(sentDuringTurn).toBe(0);

    // Fire agent_end — exactly one followUp is drained (delivered once).
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    const followUpMessages = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    );
    expect(followUpMessages.length).toBe(1);
  });

  test("review: repeated calls across LLM turns within ONE agent turn dispatch one follow-up (turn_end does NOT reset)", async () => {
    // Regression for the real-world bug: agent calls phase_ready(10) twice in the
    // review phase with Thinking between the calls = two pi turns, ONE agent turn.
    // A turn_end-scoped guard reset between the calls → TWO fy-review follow-ups.
    // The agent-scoped guard (reset on agent_end) keeps the second call a no-op.
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-05-review-cross-turn";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "review",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
      review: { reviewLoopCount: 1, reviewActive: false },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Call 1 (turn 1): processes the review iteration, STAGES the fy-review followUp
    // (delivered at agent_end, not inline). Nothing sent yet.
    await phaseReady.execute("tc-rct-1", { issuesFound: 10 }, undefined, undefined, NO_UI_CTX);
    const followUpsAfter1 = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    ).length;
    expect(followUpsAfter1).toBe(0);

    // Simulate the agent's second LLM response (Thinking between calls).
    await fireAllHandlers(fake.handlers, "turn_end", {}, NO_UI_CTX);
    await fireAllHandlers(fake.handlers, "turn_start", {}, NO_UI_CTX);

    // Call 2 (turn 2, SAME agent turn): must be a no-op — turn_end did NOT reset.
    await phaseReady.execute("tc-rct-2", { issuesFound: 10 }, undefined, undefined, NO_UI_CTX);

    const followUpsAfter2 = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    ).length;
    expect(followUpsAfter2).toBe(0); // still nothing sent inline — no second staging either

    // Only one review-loop iteration processed.
    expect(loadFeatureState(slug, null)?.review.reviewHistory ?? []).toHaveLength(1);
  });

  test("agent_end resets the guard — next agent turn can process phase_ready again", async () => {
    setSetting("maxFeatureReviewRounds", 5);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-04-review-turn-reset";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "review",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
      review: { reviewLoopCount: 1, reviewActive: false },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First call in turn 1
    await phaseReady.execute("tc-turn-1a", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect(loadFeatureState(slug, null)?.review.reviewLoopCount).toBe(2);

    // Second call in turn 1 — should be a no-op
    await phaseReady.execute("tc-turn-1b", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect(loadFeatureState(slug, null)?.review.reviewLoopCount).toBe(2); // unchanged

    // Fire agent_end — resets the guard (agent turn boundary)
    const agentEndHandlers = fake.handlers.get("agent_end");
    expect(agentEndHandlers).toBeDefined();
    expect(agentEndHandlers?.length).toBeGreaterThan(0);
    for (const handler of agentEndHandlers ?? []) {
      await handler({} as ExtensionEvent, NO_UI_CTX);
    }

    // First call in turn 2 — should process again (guard was reset)
    await phaseReady.execute("tc-turn-2a", { issuesFound: 3 }, undefined, undefined, NO_UI_CTX);
    expect(loadFeatureState(slug, null)?.review.reviewLoopCount).toBe(3); // incremented
  });

  test("resetTracking resets the guard for programmatic access", async () => {
    setSetting("maxFeatureReviewRounds", 5);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-04-review-guard-reset";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "review",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
      review: { reviewLoopCount: 1, reviewActive: false },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First call — processes normally
    await phaseReady.execute("tc-reset-1", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect(loadFeatureState(slug, null)?.review.reviewLoopCount).toBe(2);

    // Second call — blocked by the once-per-agent-turn guard
    await phaseReady.execute("tc-reset-2", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect(loadFeatureState(slug, null)?.review.reviewLoopCount).toBe(2); // unchanged

    // Reset the unified phaseReadyPassed guard via the orchestrator ref
    const phaseReadyRef = getPhaseReadyRef();
    expect(phaseReadyRef).not.toBeNull();
    phaseReadyRef?.resetTracking();

    // Third call — should process again (guard was reset)
    await phaseReady.execute("tc-reset-3", { issuesFound: 3 }, undefined, undefined, NO_UI_CTX);
    expect(loadFeatureState(slug, null)?.review.reviewLoopCount).toBe(3); // incremented
  });
});

describe("phase_ready — design/plan review loop deduplication within same turn", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("design: multiple phase_ready calls in same turn only trigger one review loop iteration", async () => {
    setSetting("maxPlanReviewRounds", 5);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-04-design-dedup";
    writeFeatureStateFile(slug, {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First call — should process normally
    const result1 = await phaseReady.execute("tc-dedup-1", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect((result1.content[0] as { text: string }).text).toBe("");

    // Second call in the same turn — should be a no-op
    const result2 = await phaseReady.execute("tc-dedup-2", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect((result2.content[0] as { text: string }).text).toBe("");

    // Third call — also a no-op
    const result3 = await phaseReady.execute("tc-dedup-3", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect((result3.content[0] as { text: string }).text).toBe("");

    // designReviewLoopCount should have incremented by exactly 1 (not 3)
    const state = loadFeatureState(slug, null);
    expect(state?.design.reviewLoopCount).toBe(2); // started at 1, incremented once

    // The followUp is STAGED during the turn (not sent inline) — drained at agent_end.
    const sentDuringTurn = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    ).length;
    expect(sentDuringTurn).toBe(0);

    // Fire agent_end — exactly one followUp drained.
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    const followUpMessages = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    );
    expect(followUpMessages.length).toBe(1);
  });

  test("plan: multiple phase_ready calls in same turn only trigger one review loop iteration", async () => {
    setSetting("maxPlanReviewRounds", 5);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-04-plan-dedup";
    writeFeatureStateFile(slug, {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First call — should process normally
    const result1 = await phaseReady.execute("tc-plan-1", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect((result1.content[0] as { text: string }).text).toBe("");

    // Second call in the same turn — should be a no-op
    const result2 = await phaseReady.execute("tc-plan-2", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect((result2.content[0] as { text: string }).text).toBe("");

    // planReviewLoopCount should have incremented by exactly 1 (not 2)
    const state = loadFeatureState(slug, null);
    expect(state?.plan.reviewLoopCount).toBe(2); // started at 1, incremented once

    // The followUp is STAGED during the turn (not sent inline) — drained at agent_end.
    const sentDuringTurn = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    ).length;
    expect(sentDuringTurn).toBe(0);

    // Fire agent_end — exactly one followUp drained.
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    const followUpMessages = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    );
    expect(followUpMessages.length).toBe(1);
  });

  test("agent_end resets the design guard — next agent turn can process phase_ready again", async () => {
    setSetting("maxPlanReviewRounds", 5);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-04-design-turn-reset";
    writeFeatureStateFile(slug, {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First call in turn 1
    await phaseReady.execute("tc-design-1a", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect(loadFeatureState(slug, null)?.design.reviewLoopCount).toBe(2);

    // Second call in turn 1 — should be a no-op
    await phaseReady.execute("tc-design-1b", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect(loadFeatureState(slug, null)?.design.reviewLoopCount).toBe(2); // unchanged

    // The followUp is STAGED during the turn (not sent inline) — the core fix for
    // the in-loop-followUp bug: an inline followUp drained inside the same agent
    // cycle, so turn-2's phase_ready arrived before agent_end reset the guard and
    // was deduped. Assert nothing was sent yet.
    const sentBeforeAgentEnd = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    ).length;
    expect(sentBeforeAgentEnd).toBe(0);

    // Fire agent_end — resets the per-cycle guard (the followUp is NOT drained
    // here anymore; it drains at agent_settled).
    const agentEndHandlers = fake.handlers.get("agent_end");
    expect(agentEndHandlers).toBeDefined();
    expect(agentEndHandlers?.length).toBeGreaterThan(0);
    for (const handler of agentEndHandlers ?? []) {
      await handler({} as ExtensionEvent, NO_UI_CTX);
    }
    // FollowUp still staged at this point — agent_end no longer drains it.
    const stagedAfterAgentEnd = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    ).length;
    expect(stagedAfterAgentEnd).toBe(0);

    // Fire agent_settled — pi is idle; the staged followUp is drained (deferred).
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    const drainedFollowUps = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    ).length;
    expect(drainedFollowUps).toBe(1); // exactly one followUp drained at the boundary

    // First call in turn 2 — should process again (guard was reset)
    await phaseReady.execute("tc-design-2a", { issuesFound: 3 }, undefined, undefined, NO_UI_CTX);
    expect(loadFeatureState(slug, null)?.design.reviewLoopCount).toBe(3); // incremented
  });
});

describe("phase_ready — verify transition deduplication within same turn", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);

    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 0);
  });

  test("verify: multiple phase_ready calls in same turn only transition once (second call lands in review, must be a no-op)", async () => {
    // Regression: the agent frequently re-calls phase_ready after seeing the
    // `✓ done` result. The first verify call transitions verify→review and
    // dispatches the review skill. A second call the same turn lands in the
    // review phase — without priming the review-loop guard it would process a
    // review-loop iteration (a SECOND transition this turn). The verify→review
    // transition must prime the review guard so the stray call is a no-op.
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-05-verify-dedup";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "verify",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    // Mark tests passed + all todos done so the verify transition is allowed.
    getGuardrailsRef()?.setVerifyTestsPassed(true);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First call — verify → review, STAGES the review skill followUp (delivered at agent_end).
    const result1 = await phaseReady.execute("tc-verify-dedup-1", {}, undefined, undefined, NO_UI_CTX);
    expect((result1.content[0] as { text: string }).text).toBe("");
    expect(fake.sentMessages.length).toBe(0); // staged, not yet sent

    // Second call the SAME turn — now currentPhase is "review". The review-loop
    // guard was primed by the verify→review transition, so this must be a no-op:
    // no additional followUp, no review-loop iteration processed.
    const result2 = await phaseReady.execute("tc-verify-dedup-2", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect((result2.content[0] as { text: string }).text).toBe("");

    // Third call — also a no-op.
    await phaseReady.execute("tc-verify-dedup-3", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);

    // Still nothing sent inline (no second transition, no second staging).
    expect(fake.sentMessages.length).toBe(0);

    // Fire agent_end — exactly ONE followUp drained (the review skill dispatch).
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    const followUps = fake.sentMessages.filter(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { options?: { deliverAs?: string } }).options?.deliverAs === "followUp",
    );
    expect(followUps.length).toBe(1);
    expect(followUps[0] && (followUps[0] as { options?: { deliverAs?: string } }).options).toEqual({
      deliverAs: "followUp",
    });

    // No review-loop iteration was recorded (the review branch was blocked).
    const state = loadFeatureState(slug, null);
    expect(state?.review.reviewLoopCount ?? 0).toBe(0);
    expect(state?.review.reviewHistory ?? []).toHaveLength(0);
  });

  test("verify: repeated calls across LLM turns within ONE agent turn still transition once (turn_end does NOT reset the guard)", async () => {
    // Regression for the real-world bug: the agent re-calls phase_ready after
    // seeing `✓ done`, with Thinking BETWEEN calls — i.e. the two calls span two
    // pi turns (turn_start/turn_end per LLM response) but ONE agent turn (one user
    // prompt → agent_start … agent_end). A turn_end-scoped guard would reset
    // between the calls and let the second call dispatch a SECOND follow-up. The
    // guard must be agent-turn-scoped (reset on agent_end), so turn_end between
    // the calls leaves it set and the second call is a no-op.
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-05-verify-cross-turn";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "verify",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);
    getGuardrailsRef()?.setVerifyTestsPassed(true);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Call 1 (turn 1): verify → review, STAGES the review skill followUp (not sent inline).
    await phaseReady.execute("tc-vct-1", {}, undefined, undefined, NO_UI_CTX);
    expect(fake.sentMessages.length).toBe(0);

    // Simulate the agent's second LLM response (Thinking between calls): fire
    // turn_end + turn_start. With the OLD turn_end-scoped guard this reset the
    // guard; with the agent-scoped guard it must NOT.
    await fireAllHandlers(fake.handlers, "turn_end", {}, NO_UI_CTX);
    await fireAllHandlers(fake.handlers, "turn_start", {}, NO_UI_CTX);

    // Call 2 (turn 2, SAME agent turn — now in the review phase): must be a no-op.
    await phaseReady.execute("tc-vct-2", { issuesFound: 10 }, undefined, undefined, NO_UI_CTX);

    // Still nothing sent inline — turn_end did NOT reset the guard, no second staging.
    expect(fake.sentMessages.length).toBe(0);
    const state = loadFeatureState(slug, null);
    expect(state?.review.reviewHistory ?? []).toHaveLength(0);
  });

  test("verify: agent_end resets the guard — next agent turn can process phase_ready again", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-05-verify-turn-reset";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "verify",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    getGuardrailsRef()?.setVerifyTestsPassed(true);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Turn 1: verify → review (primes the review guard), then a stray review
    // call that must be a no-op. The review-skill followUp is STAGED (not sent inline).
    await phaseReady.execute("tc-vtr-1a", {}, undefined, undefined, NO_UI_CTX);
    await phaseReady.execute("tc-vtr-1b", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);
    expect(fake.sentMessages.length).toBe(0); // staged, not yet sent

    // Fire agent_end — resets the once-per-agent-turn guard (agent turn boundary).
    const agentEndHandlers = fake.handlers.get("agent_end");
    expect(agentEndHandlers).toBeDefined();
    expect(agentEndHandlers?.length).toBeGreaterThan(0);
    for (const handler of agentEndHandlers ?? []) {
      await handler({} as ExtensionEvent, NO_UI_CTX);
    }

    // Turn 2: the legitimate review-skill phase_ready call now processes (guard reset).
    await phaseReady.execute("tc-vtr-2a", { issuesFound: 5 }, undefined, undefined, NO_UI_CTX);

    // A review-loop iteration was processed this turn (history recorded, review skill re-dispatched).
    const state = loadFeatureState(slug, null);
    expect(state?.review.reviewHistory ?? []).toHaveLength(1);
    expect(state?.review.reviewHistory?.[0]).toMatchObject({ phase: "review", issuesFound: 5 });
  });
});

describe("phase_ready — finish transition deduplication within same turn", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);

    setSetting("uatMode", "after-review");
  });

  test("finish: multiple phase_ready calls in same turn only complete once", async () => {
    // Regression: the finish completion branch stamps completedAt but keeps
    // currentPhase on "finish", so a re-call the same turn would re-run the
    // completion side effects (double notify / kanban move / auto-agent
    // callback). Only the first call may run; subsequent calls are no-ops.
    setSetting("uatMode", "after-review");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-05-finish-dedup";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "finish",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
    });

    const notifySpy = vi.fn();
    const onFeatureComplete = vi.fn();

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    // setAutoAgentCallback must run AFTER workflowMonitorExtension creates the
    // globalThis.__piKanban bridge (setAutoAgentCallback is a no-op without it).
    setAutoAgentCallback({ onFeatureComplete, onFeatureError: () => {} } as unknown as {
      onFeatureComplete: (slug: string) => void;
      onFeatureError: (slug: string, error: string) => void;
    });
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    // Set up the UI guard AFTER session_start so the notify spy is live for the
    // phase_ready execute (notifyFeatureCompleted reads globalThis.__piCtx).
    setupPiCtx({ notify: notifySpy, setWidget: () => {} } as unknown as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First call — completes the feature (notify + onFeatureComplete + completedAt).
    const result1 = await phaseReady.execute("tc-finish-dedup-1", {}, undefined, undefined, NO_UI_CTX);
    expect((result1.content[0] as { text: string }).text).toBe("");
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(onFeatureComplete).toHaveBeenCalledTimes(1);
    expect(onFeatureComplete).toHaveBeenCalledWith(slug);
    expect(loadFeatureState(slug, null)?.completedAt).not.toBeNull();

    // Second call the SAME turn — must be a no-op: no duplicate notify / callback.
    const result2 = await phaseReady.execute("tc-finish-dedup-2", {}, undefined, undefined, NO_UI_CTX);
    expect((result2.content[0] as { text: string }).text).toBe("");

    // Third call — also a no-op.
    await phaseReady.execute("tc-finish-dedup-3", {}, undefined, undefined, NO_UI_CTX);

    // Still exactly ONE notify + ONE auto-agent callback (no double completion).
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(onFeatureComplete).toHaveBeenCalledTimes(1);
  });

  test("finish: agent_end resets the guard — next agent turn can process phase_ready again", async () => {
    setSetting("uatMode", "after-review");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    const slug = "2026-07-05-finish-turn-reset";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "finish",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
    });

    const notifySpy = vi.fn();

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    // setAutoAgentCallback must run AFTER workflowMonitorExtension creates the
    // globalThis.__piKanban bridge (setAutoAgentCallback is a no-op without it).
    setAutoAgentCallback({ onFeatureComplete: vi.fn(), onFeatureError: () => {} } as unknown as {
      onFeatureComplete: (slug: string) => void;
      onFeatureError: (slug: string, error: string) => void;
    });
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    // Set up the UI guard AFTER session_start so the notify spy is live for execute.
    setupPiCtx({ notify: notifySpy, setWidget: () => {} } as unknown as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // First call — completes.
    await phaseReady.execute("tc-ftr-1", {}, undefined, undefined, NO_UI_CTX);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // Second call same turn — blocked.
    await phaseReady.execute("tc-ftr-2", {}, undefined, undefined, NO_UI_CTX);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // Fire agent_end — resets the once-per-agent-turn guard (agent turn boundary).
    const agentEndHandlers = fake.handlers.get("agent_end");
    expect(agentEndHandlers).toBeDefined();
    for (const handler of agentEndHandlers ?? []) {
      await handler({} as ExtensionEvent, NO_UI_CTX);
    }

    // After agent_end, a call runs again — but completedAt is already stamped, so
    // completion re-runs (notify fires a second time). This confirms the guard
    // was reset by agent_end (without it, the call would have been a no-op).
    await phaseReady.execute("tc-ftr-3", {}, undefined, undefined, NO_UI_CTX);
    expect(notifySpy).toHaveBeenCalledTimes(2);
  });
});

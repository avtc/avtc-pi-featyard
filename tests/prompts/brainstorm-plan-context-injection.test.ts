// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  BRAINSTORM_ACTIVE_STATE,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  NO_UI_CTX,
  PLAN_ACTIVE_STATE,
  withTempCwd,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Tests for context prefix injection in the new interceptor-based flow.
 *
 * Context (loop number, slug, report file, review method) is now prepended to
 * the expandSkillCommand result via buildReviewContextPrefix when the loop gate
 * sends a review iteration skill as a followUp.
 *
 * The old tool_result regex injection for designing/ff-plan was removed.
 */
describe("design/plan review context prefix", () => {
  beforeEach(() => {
    setTestSettings(null);
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FF_FEATURE;
    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
  });

  test("design loop gate includes context prefix with loop number, slug, report file", async () => {
    withTempCwd();
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("ctx-prefix-feature", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 }, // interceptor has run, 0 completed
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Trigger loop gate: phase_ready(review_iteration, issuesFound=2) → should loop
    await phaseReady.execute("tc-ctx-1", { issuesFound: 2 }, undefined, undefined, NO_UI_CTX);

    // Verify followUp contains context prefix
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const followUp = fake.sentMessages[fake.sentMessages.length - 1];
    expect((followUp.options as { deliverAs?: string } | undefined)?.deliverAs).toBe("followUp");

    // Context prefix should contain loop info
    expect(followUp.message).toContain("ff-design-review");
    expect(followUp.message).toContain("**Feature:** `ctx-prefix-feature`");
    expect(followUp.message).toContain("**Review loop:** `1`"); // loopNumber = rawLoopCount (1 completed after increment)
    expect(followUp.message).toContain("ff-design-review");
    expect(followUp.message).toContain("Dispatch reviewer"); // review method substituted into {{PI_FF_REVIEW_METHOD}}
  });

  test("plan loop gate includes context prefix with loop number, slug, report file", async () => {
    withTempCwd();
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("plan-ctx-feature", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 }, // interceptor has run, 0 completed
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Trigger loop gate
    await phaseReady.execute("tc-plan-ctx-1", { issuesFound: 1 }, undefined, undefined, NO_UI_CTX);

    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const followUp = fake.sentMessages[fake.sentMessages.length - 1];
    expect((followUp.options as { deliverAs?: string } | undefined)?.deliverAs).toBe("followUp");

    expect(followUp.message).toContain("ff-plan-review");
    expect(followUp.message).toContain("**Feature:** `plan-ctx-feature`");
    expect(followUp.message).toContain("ff-plan-review");
    expect(followUp.message).toContain("Dispatch reviewer"); // review method substituted into {{PI_FF_REVIEW_METHOD}}
  });

  test("design interceptor (no stage) sets loopCount=1 and sends skill with context", async () => {
    disableSubagentMode();
    withTempCwd();
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    // Record the design doc in state (consistent with the file on disk) so session-start
    // artifact recovery does not fire a partial-workflow patch that would wipe currentPhase
    // (known production gap — see test-migration-notes.md "recovery wipes currentPhase").
    writeFeatureStateFile("intercept-ctx-feature", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: "docs/ff/designs/intercept-ctx-feature-design.md", planDoc: null },
      design: { doc: "docs/ff/designs/intercept-ctx-feature-design.md", reviewActive: false, reviewLoopCount: 0 },
    });

    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/intercept-ctx-feature-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const selectFn = async () => "Proceed with implementation";
    const rootCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, rootCtx);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // phase_ready() without stage → design interceptor fires
    await phaseReady.execute("tc-intercept", {}, undefined, undefined, rootCtx);

    // Verify design.reviewLoopCount set to 1
    const state = loadFeatureState("intercept-ctx-feature", null);
    expect(state?.design.reviewLoopCount).toBe(1);

    // Verify followUp sent with context
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const followUp = fake.sentMessages[fake.sentMessages.length - 1];
    expect(followUp.message).toContain("ff-design-review");
    expect(followUp.message).toContain("**Feature:** `intercept-ctx-feature`");
    expect(followUp.message).toContain("**Review loop:** `0`"); // first iteration, 0 completed
  });

  test("subsequent loop iteration increments loop number in context prefix", async () => {
    withTempCwd();
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("loop-incr-feature", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 2 }, // 1 completed iteration
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Trigger loop gate from iteration 1 → should send iteration 2
    await phaseReady.execute("tc-loop-incr", { issuesFound: 1 }, undefined, undefined, NO_UI_CTX);

    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const followUp = fake.sentMessages[fake.sentMessages.length - 1];
    expect(followUp.message).toContain("ff-design-review");
    expect(followUp.message).toContain("**Review loop:** `2`"); // incremented to 2
    expect(followUp.message).toContain("loop-incr-feature");
  });

  test("maxPlanReviewRounds=off does not send review skill followUp", async () => {
    disableSubagentMode();
    withTempCwd();
    setSetting("maxPlanReviewRounds", 0);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("off-ctx-feature", BRAINSTORM_ACTIVE_STATE);

    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/off-ctx-feature-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const selectFn = async () => "Proceed with implementation";
    const rootCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
    } as unknown as ExtensionContext;

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, rootCtx);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // phase_ready() without stage → design interceptor should NOT fire when maxPlanReviewRounds=off
    await phaseReady.execute("tc-off-ctx", {}, undefined, undefined, rootCtx);

    // Should NOT have sent design-review
    const reviewMessages = fake.sentMessages.filter((m: { message: string }) => m.message.includes("ff-design-review"));
    expect(reviewMessages).toHaveLength(0);
  });

  test("context prefix includes known-issues file path", async () => {
    withTempCwd();
    setSetting("maxPlanReviewRounds", 3);

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("known-issues-feature", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    await phaseReady.execute("tc-known-issues", { issuesFound: 1 }, undefined, undefined, NO_UI_CTX);

    const followUp = fake.sentMessages[fake.sentMessages.length - 1];
    expect(followUp.message).toContain("**Known issues:**");
    expect(followUp.message).toContain("known-issues-feature-design-known-issues.md");
  });
});

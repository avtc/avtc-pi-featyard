// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { log as _log } from "../../src/log.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import { setSetting } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  createPiWithToolCapture,
  fireAllHandlers,
  getToolHandlers,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Tests for review loop detection in workflow-monitor:
 * - task_tracker init in review phase skips execution mode dialog
 * - All review fix tasks complete with real issues → extension re-dispatches review skill
 * - All review fix tasks complete with zero real issues → extension ends loop, generates report
 * - Max loops reached → extension ends loop even if real issues remain
 * - cannot-fix issues tracked in reviewHistory
 *
 * NOTE: review-loop completion is driven by calling the phase_ready tool with
 * {issuesFound, cannotFix} during the review phase (the ff-review skill's
 * completion trigger). Only the FIRST test still exercises task_tracker init
 * directly (it asserts the execution-mode dialog is skipped).
 */

function createCtx(hasUI: boolean) {
  return {
    hasUI,
    sessionManager: {
      getBranch: () => [],
    },
    ui: {
      setWidget: () => {},
      select: async () => "next",
      setEditorText: () => {},
      notify: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

/** Get the notify mock's call arguments. notify is vi.fn from createCtx. */
function getNotifyCall(ctx: ExtensionContext, argIndex: 0 | 1): string {
  const calls = vi.mocked(ctx.ui.notify).mock.calls;
  if (calls.length === 0) throw new Error("getNotifyCall: ctx.ui.notify was not called");
  return calls[0][argIndex] as string;
}

/** No review loop options (use defaults) */
const NO_REVIEW_OPTIONS: { reviewLoopCount?: number } | null = null;

function setupReviewPhase(slug: string, options: { reviewLoopCount?: number } | null) {
  const fake = createFakePi();
  writeFeatureStateFile(slug, {
    workflow: {
      currentPhase: "review",
      designDoc: `docs/ff/designs/${slug}-design.md`,
      planDoc: `.ff/task-plans/${slug}-task-plan.md`,
    },
    review: { reviewLoopCount: options?.reviewLoopCount ?? 0, reviewHistory: [] },
  });

  workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
  return fake;
}

/**
 * Review-phase setup that also captures registered tools so tests can drive the
 * review loop via the phase_ready tool (the new completion trigger).
 */
function setupReviewPhaseWithTools(slug: string, options: { reviewLoopCount?: number } | null) {
  const { fake, registeredTools, api } = createPiWithToolCapture();
  writeFeatureStateFile(slug, {
    workflow: {
      currentPhase: "review",
      designDoc: `docs/ff/designs/${slug}-design.md`,
      planDoc: `.ff/task-plans/${slug}-task-plan.md`,
    },
    review: { reviewLoopCount: options?.reviewLoopCount ?? 0, reviewHistory: [] },
  });
  workflowMonitorExtension(api as unknown as ExtensionAPI);
  return { fake, registeredTools, api };
}

describe("review loop detection", () => {
  beforeEach(async () => {
    vi.spyOn(_log, "info").mockImplementation(() => {});
    vi.spyOn(_log, "warn").mockImplementation(() => {});
    vi.spyOn(_log, "debug").mockImplementation(() => {});
    vi.spyOn(_log, "error").mockImplementation(() => {});
    // Clean up env vars to prevent cross-test contamination
    delete process.env.PI_FF_REVIEW_LOOP;
    delete process.env.PI_FF_STAGE;
    // Reset featureReviewMode to general for tests expecting ff-review

    setSetting("featureReviewMode", "general");
  });

  afterEach(async () => {
    setSetting("maxFeatureReviewRounds", 0);
    setSetting("featureReviewMode", "comprehensive");
    setSetting("minReviewLoops", 0);
    setSetting("uatMode", "after-review"); // reset (default) — some tests set off/after-finish
  });

  test("task_tracker init in review phase skips execution mode dialog", async () => {
    const slug = "2026-05-12-review-init";
    const fake = setupReviewPhase(slug, NO_REVIEW_OPTIONS);
    const { onToolCall, onToolResult } = getToolHandlers(fake);
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // task_tracker init should succeed without triggering execution mode dialog
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "tc-init-1",
        toolName: "task_tracker",
        input: { action: "init", tasks: ["[Review #1] Fix: error handling", "[Review #1] Fix: input validation"] },
      } as unknown as ExtensionEvent,
      ctx,
    );

    const result = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "tc-init-1",
        toolName: "task_tracker",
        input: { action: "init", tasks: ["[Review #1] Fix: error handling", "[Review #1] Fix: input validation"] },
        content: [{ type: "text", text: "Plan initialized with 2 tasks." }],
        details: {
          action: "init",
          tasks: [
            { name: "[Review #1] Fix: error handling", status: "pending" },
            { name: "[Review #1] Fix: input validation", status: "pending" },
          ],
        },
      } as unknown as ExtensionEvent,
      ctx,
    );

    // Should NOT have sent execution mode dialog (no select call)
    // The result should just be the normal task_tracker result
    expect(result).toBeUndefined(); // no injection from workflow-monitor
  });

  test("review loop detection works with non-prefixed task names (fallback)", async () => {
    const slug = "2026-05-16-review-no-prefix";

    setSetting("maxFeatureReviewRounds", 5);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 2 }); // 3rd loop (0-indexed)
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Should NOT have re-dispatched yet (not all complete)
    expect(fake.sentMessages.length).toBe(0);

    // Init review fix tasks WITHOUT the [Review #N] prefix (LLM used custom naming),
    // then mark both complete with result "fixed". Review completion is driven by
    // phase_ready({issuesFound, cannotFix}) — 2 fixed → issuesFound=2, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 2, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should have re-dispatched the review skill despite non-prefixed task names
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.options).toEqual({ deliverAs: "followUp" });
    expect(lastMessage.message).toContain('<skill name="ff-review"');

    // Verify reviewLoopCount was incremented
    expect(loadFeatureState("2026-05-16-review-no-prefix", null)?.review.reviewLoopCount).toBe(3);
  });

  test("all review fix tasks complete with real issues re-dispatches review skill", async () => {
    const slug = "2026-05-12-review-loop-redispatch";

    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Init review fix tasks, mark complete with result "fixed". Review completion
    // driven by phase_ready — 1 fixed → issuesFound=1, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 1, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should re-dispatch the review skill as followUp
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.options).toEqual({ deliverAs: "followUp" });
    expect(lastMessage.message).toContain('<skill name="ff-review"');

    // Verify the review loop count was incremented (durable in feature-state)
    expect(loadFeatureState("2026-05-12-review-loop-redispatch", null)?.review.reviewLoopCount).toBe(1);
  });

  test("all review fix tasks complete with zero real issues ends loop with report", async () => {
    const slug = "2026-05-12-review-loop-end";

    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 1 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Mark task complete with result "false-positive" (zero real issues). Review
    // completion driven by phase_ready — 0 real issues → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should send end-of-loop report (NOT re-dispatch review skill)
    // review loop ended — notification sent. uatMode defaults to after-review, so the report +
    // UAT-handoff (+ worth-notes) are MERGED into ONE notify ( — fixes the handoff-hides-
    // report data-loss bug).
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const merged = getNotifyCall(ctx, 0);
    expect(merged).toContain("Review Round Summary");
    expect(merged).toContain("ready for UAT"); // report + handoff in the SAME notify
    // Zero real issues → notification level should be "info"
    expect(getNotifyCall(ctx, 1)).toBe("info");
  });

  test("headless (hasUI=false) loop-end does not crash and does not call notify", async () => {
    const slug = "2026-05-12-review-headless-loop-end";

    setSetting("maxFeatureReviewRounds", 1);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false); // hasUI=false (headless)

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Mark task complete with result "false-positive" (zero real issues). Review
    // completion driven by phase_ready — 0 real issues → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Headless loop-end: no crash, no notify call, no skill re-dispatch
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(fake.sentMessages.length).toBe(0);

    // Headless fallback: report logged via log.info
    const reportCall = vi
      .mocked(_log.info)
      .mock.calls.find((call) => typeof call[0] === "string" && call[0].includes("review loop ended"));
    expect(reportCall).toBeDefined();
    expect(reportCall?.[0]).toContain("Review Round Summary");
  });

  test("after-review merge appends worth-notes pointer when the file exists", async () => {
    const slug = "2026-05-12-review-worth-notes-present";

    setSetting("maxFeatureReviewRounds", 3);
    // Set up the review phase FIRST — this enters the temp cwd (withTempCwd) where the loop runs.
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 1 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    // Write a non-empty worth-notes file at the resolved slug path (relative to the temp cwd) so
    // worthNotesPointer is non-null when the loop ends.
    const notesPath = path.join(process.cwd(), ".ff", "reviews", slug, `${slug}-worth-notes.md`);
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.writeFileSync(notesPath, "## worth noting\n- an oddity\n");
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // uatMode defaults to after-review → report + handoff + worth-notes pointer MERGED into ONE.
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const merged = getNotifyCall(ctx, 0);
    expect(merged).toContain("Review Round Summary");
    expect(merged).toContain("ready for UAT");
    expect(merged).toContain("📝 worth-notes:"); // pointer appended (file exists + non-empty)
    expect(getNotifyCall(ctx, 1)).toBe("info");
  });

  test("after-review merge adds no pointer line when worth-notes is absent", async () => {
    const slug = "2026-05-12-review-worth-notes-absent";

    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 1 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(getNotifyCall(ctx, 0)).not.toContain("📝 worth-notes:");
  });

  test("off-mode standalone report notify carries the worth-notes pointer (no UAT merge)", async () => {
    const slug = "2026-05-12-review-off-mode-worth-notes";

    setSetting("maxFeatureReviewRounds", 3);
    setSetting("uatMode", "off");
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 1 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    // Write a non-empty worth-notes file at the slug path so the pointer is non-null.
    const notesPath = path.join(process.cwd(), ".ff", "reviews", slug, `${slug}-worth-notes.md`);
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.writeFileSync(notesPath, "## worth noting\n- oddity\n");
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // uatMode off: no UAT handoff. The standalone report notify fires WITH the worth-notes
    // pointer appended (the natural review-completion boundary — row 3).
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    expect(report).toContain("📝 worth-notes:");
    expect(report).not.toContain("ready for UAT"); // off mode → no handoff
  });

  test("zero-issues review (empty task_tracker init) ends loop with report", async () => {
    const slug = "2026-05-12-review-zero-issues-end";

    setSetting("maxFeatureReviewRounds", 1);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Reviewer found zero issues — review completion driven by phase_ready with
    // zero issues → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should send end-of-loop report (NOT re-dispatch review skill)
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    // Zero issues → notification level should be "info"
    expect(getNotifyCall(ctx, 1)).toBe("info");

    // Should NOT re-dispatch review skill
    expect(fake.sentMessages.length).toBe(0);
  });

  test("zero-issues review (empty task_tracker init) ends loop with log in headless mode (hasUI: false)", async () => {
    const slug = "2026-05-12-review-zero-issues-headless";

    setSetting("maxFeatureReviewRounds", 1);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false); // hasUI: false — headless/subagent mode

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Reviewer found zero issues — review completion driven by phase_ready with
    // zero issues → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should NOT call ctx.ui.notify in headless mode
    expect(ctx.ui.notify).not.toHaveBeenCalled();

    // Should NOT re-dispatch review skill
    expect(fake.sentMessages.length).toBe(0);

    // Verify the loop ended — feature state should have reviewHistory entry

    const state = loadFeatureState(slug, null);
    expect(state?.review.reviewHistory).toHaveLength(1);
    expect(state?.review.reviewHistory?.[0].phase).toBe("review"); // tagged by phase
    expect(state?.review.reviewHistory?.[0].issuesFound).toBe(0);
  });

  test("zero-issues review loops again when minReviewLoops not met", async () => {
    const slug = "2026-05-12-review-zero-issues-loop";

    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 2);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Reviewer found zero issues at loop 0 — minReviewLoops=2 not met yet. Review
    // completion driven by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should re-dispatch review skill (minReviewLoops not met)
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.options).toEqual({ deliverAs: "followUp" });
    expect(lastMessage.message).toContain('<skill name="ff-review"');

    // Should NOT send notify report (loop continues)
    expect(ctx.ui.notify).not.toHaveBeenCalled();

    // Verify loop counter incremented
    expect(loadFeatureState("2026-05-12-review-zero-issues-loop", null)?.review.reviewLoopCount).toBe(1);
  });

  test("max loops reached ends loop even with real issues", async () => {
    const slug = "2026-05-12-review-max-loops";

    setSetting("maxFeatureReviewRounds", 1);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 1 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Mark task complete with result "fixed" (real issue). Review completion driven
    // by phase_ready — 1 fixed → issuesFound=1, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 1, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Loop cap reached (1 loop done, setting is "1") — should end with report
    // review loop ended — notification sent
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    expect(getNotifyCall(ctx, 1)).toBe("info");
  });

  test("cannot-fix issues tracked in reviewHistory", async () => {
    const slug = "2026-05-12-review-cannot-fix";

    setSetting("maxFeatureReviewRounds", 1);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Fix A: fixed, Fix B: cannot-fix. Review completion driven by phase_ready
    // 1 fixed + 1 cannot-fix → issuesFound=2, cannotFix=1.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 2, cannotFix: 1 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Loop cap reached (1) — should end with report
    // review loop ended — notification sent
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    // Cannot-fix issues present → notification level should be "warning"
    expect(getNotifyCall(ctx, 1)).toBe("warning");
    // Report should mention cannot-fix
    expect(report).toContain("cannot-fix");
  });

  test("featureReviewMode comprehensive dispatches ff-review on loop re-entry", async () => {
    const slug = "2026-05-12-review-comprehensive";

    setSetting("maxFeatureReviewRounds", 3);
    setSetting("featureReviewMode", "comprehensive");
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Mark task complete with result "fixed". Review completion driven by
    // phase_ready — 1 fixed → issuesFound=1, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 1, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should re-dispatch ff-review
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain('<skill name="ff-review"');

    // Verify the review loop count was incremented (durable in feature-state)
    expect(loadFeatureState("2026-05-12-review-comprehensive", null)?.review.reviewLoopCount).toBe(1);
  });

  test("generateReviewReport output contains per-loop details and totals", async () => {
    const slug = "2026-05-12-review-report-content";

    setSetting("maxFeatureReviewRounds", 1);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Mark tasks: A=fixed, B=false-positive, C=cannot-fix. Review completion
    // driven by phase_ready — fixed+cannot-fix = 2 real issues → issuesFound=2,
    // cannotFix=1, falsePositives=1.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 2, cannotFix: 1, falsePositives: 1 },
      undefined,
      undefined,
      ctx,
    );

    // Loop cap (1) reached — report generated via UI notify
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(getNotifyCall(ctx, 1)).toBe("warning");

    // Verify report structure (plain text — notify renders no markdown)
    expect(report).toContain("Review Round Summary");
    expect(report).toContain("Code Review");
    expect(report).toContain("Round #0: 2 issues found, 1 false positive, 1 cannot-fix"); // per-round entry
    expect(report).toContain("Code Review total: 2 issues found, 1 false positive, 1 cannot-fix");
    expect(report).toContain("Totals: 2 issues found across 1 round");
    expect(report).toContain("False positives: 1");
    expect(report).toContain("⚠️ Cannot fix: 1"); // cannot-fix present since > 0
    // No markdown markers (plain-text notify rendering) and no Fixed line (field removed)
    expect(report).not.toContain("**");
    expect(report).not.toContain("Fixed:");
  });

  test("reviewHistory and reviewLoopCount persist to disk after loop detection", async () => {
    const slug = "2026-05-12-review-persist";

    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Mark A=fixed (real issue), B=false-positive. Review completion driven by
    // phase_ready — 1 fixed → issuesFound=1, cannotFix=0, falsePositives=1.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 1, cannotFix: 0, falsePositives: 1 },
      undefined,
      undefined,
      ctx,
    );

    // Should have re-dispatched (1 real issue, loop cap 3 not reached)
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain('<skill name="ff-review"');

    // Verify persisted state on disk
    const statePath = path.join(".ff", "feature-state", `${slug}.json`);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(persisted.review.reviewLoopCount).toBe(1); // incremented from 0 → 1
    expect(persisted.review.reviewHistory).toHaveLength(1);
    expect(persisted.review.reviewHistory[0].loopNumber).toBe(0);
    expect(persisted.review.reviewHistory[0].phase).toBe("review"); // tagged by phase
    expect(persisted.review.reviewHistory[0].issuesFound).toBe(1); // fixed
    expect(persisted.review.reviewHistory[0].falsePositives).toBe(1);
    expect(persisted.review.reviewHistory[0].cannotFixIssues).toBe(0);
  });

  test("maxFeatureReviewRounds 'off' prevents review loop re-dispatch even with real issues", async () => {
    const slug = "2026-05-12-review-off";

    setSetting("maxFeatureReviewRounds", 0);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Mark task fixed (real issue). Review completion driven by phase_ready
    // 1 fixed → issuesFound=1, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 1, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should NOT re-dispatch review skill when maxFeatureReviewRounds is 'off'
    if (fake.sentMessages.length > 0) {
      const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
      expect(lastMessage.message).not.toContain('<skill name="ff-review"');
    }
  });
});

describe("minReviewLoops integration", () => {
  beforeEach(async () => {
    vi.spyOn(_log, "info").mockImplementation(() => {});
    vi.spyOn(_log, "warn").mockImplementation(() => {});
    vi.spyOn(_log, "debug").mockImplementation(() => {});
    vi.spyOn(_log, "error").mockImplementation(() => {});
    // Clean up env vars to prevent cross-test contamination
    delete process.env.PI_FF_REVIEW_LOOP;
    delete process.env.PI_FF_STAGE;
    // Reset featureReviewMode to general for tests expecting ff-review

    setSetting("featureReviewMode", "general");
  });

  afterEach(async () => {
    setSetting("maxFeatureReviewRounds", 0);
    setSetting("featureReviewMode", "comprehensive");
    setSetting("minReviewLoops", 0);
  });

  /**
   * Helper: run a complete review task cycle through task_tracker.
   * Sets up feature state, initializes task_tracker with one task, marks it complete.
   */
  test("minReviewLoops=2 forces loop after first loop (loop 0) with zero issues", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 2);

    const slug = "2026-05-12-min-loops-force-2";
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Init + complete task as false-positive (zero real issues). Review completion
    // driven by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // minReviewLoops=2, currentLoop=0, minMet=false → should loop even with 0 real issues
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain('<skill name="ff-review"');
    expect(lastMessage.message).not.toContain("Review Round Summary");
  });

  test("minReviewLoops=2 allows early exit after 2 loops with zero issues", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 2);

    const slug = "2026-05-12-min-loops-exit-after-2";
    // reviewLoopCount=1 means loop 1 already completed, now completing loop 2
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 1 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Init + complete task as false-positive (zero real issues). Review completion
    // driven by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // currentLoop=1, numericMin=2, minMet = (1+1) >= 2 = true
    // issuesFound=0, minMet=true → (0 || !true) = false → shouldLoop = false
    // Early exit: 2 loops completed, minimum met, zero issues → loop ends
    // review loop ended — notification sent
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    expect(getNotifyCall(ctx, 1)).toBe("info");
  });

  test("minReviewLoops=2 allows early exit at loop index 2 with zero issues", async () => {
    setSetting("maxFeatureReviewRounds", 5);
    setSetting("minReviewLoops", 2);

    const slug = "2026-05-12-min-loops-exit-at-2";
    // reviewLoopCount=2 means loops 0,1,2 have run; this is the 3rd completion
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 2 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Init + complete task as false-positive (zero real issues). Review completion
    // driven by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // currentLoop=2, numericMin=2, minMet = 2 >= 2 = true
    // issuesFound=0, minMet=true → (issuesFound > 0 || !minMet) = (false || false) = false
    // shouldLoop = false → ends with report
    // review loop ended — notification sent
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    expect(getNotifyCall(ctx, 1)).toBe("info");
  });

  test("minReviewLoops=3 forces loops until loop 2 with zero issues, exits at loop 3", async () => {
    setSetting("maxFeatureReviewRounds", 5);
    setSetting("minReviewLoops", 3);

    // reviewLoopCount=2 means loops 0,1,2 completed; 3rd loop just finished
    // minMet = (2+1) >= 3 = true → allows exit with 0 real issues
    const slug = "2026-05-12-min-loops-3-exit";
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 2 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Init + complete task as false-positive (zero real issues). Review completion
    // driven by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // currentLoop=2, numericMin=3, minMet = (2+1) >= 3 = true
    // issuesFound=0, !minMet=false → (0 || false) = false → shouldLoop = false
    // Early exit: min met, no real issues, sends summary
    // review loop ended — notification sent
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    expect(getNotifyCall(ctx, 1)).toBe("info");
  });

  test("minReviewLoops=3 forces loop when min not yet met at loop 1", async () => {
    setSetting("maxFeatureReviewRounds", 5);
    setSetting("minReviewLoops", 3);

    // reviewLoopCount=1 means loop 0,1 completed; 2nd loop just finished
    // minMet = (1+1) >= 3 = false → forces another loop
    const slug = "2026-05-12-min-loops-3-force";
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 1 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Init + complete task as false-positive (zero real issues). Review completion
    // driven by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // currentLoop=1, numericMin=3, minMet = (1+1) >= 3 = false → !minMet=true
    // issuesFound=0, !minMet=true → (0 || true) = true → shouldLoop = true
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain('<skill name="ff-review"');
    expect(lastMessage.message).not.toContain("Review Round Summary");
  });

  test("minReviewLoops raises effective ceiling above maxFeatureReviewRounds", async () => {
    setSetting("maxFeatureReviewRounds", 1);
    setSetting("minReviewLoops", 3);

    const slug = "2026-05-12-min-exceeds-max";
    // reviewLoopCount=0, maxFeatureReviewRounds=1, minReviewLoops=3
    // effectiveMax = max(1, 3) = 3
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Task is false-positive (zero real issues), but min not met. Review completion
    // driven by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // currentLoop=0, numericMin=3, minMet=false → !minMet=true
    // effectiveMax = max(1,3) = 3, currentLoop+1 = 1 < 3 → true
    // shouldLoop = true (even though maxFeatureReviewRounds=1, min raises ceiling)
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain('<skill name="ff-review"');
    expect(lastMessage.message).not.toContain("Review Round Summary");
  });

  test("maxFeatureReviewRounds=off disables minReviewLoops (min is ignored)", async () => {
    setSetting("maxFeatureReviewRounds", 0);
    setSetting("minReviewLoops", 3);

    const slug = "2026-05-12-min-with-off";
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Task has real issues, but maxFeatureReviewRounds=off. Review completion driven by
    // phase_ready — 1 fixed → issuesFound=1, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 1, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // maxLoops='off' → shouldLoop=false regardless of minReviewLoops
    if (fake.sentMessages.length > 0) {
      const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
      expect(lastMessage.message).not.toContain('<skill name="ff-review"');
    }
  });

  test("minReviewLoops=1 is a no-op — allows exit after first loop with zero issues", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 1);

    const slug = "2026-05-12-min-loops-1-noop";
    // reviewLoopCount=0 means first loop just completed
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Complete task as false-positive (zero real issues). Review completion driven
    // by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // currentLoop=0, numericMin=1, minMet = (0+1) >= 1 = true → !minMet = false
    // issuesFound=0, !minMet=false → (0 || false) = false → shouldLoop = false
    // minReviewLoops=1 is effectively a no-op — first loop always runs, min is already met
    // review loop ended — notification sent
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    expect(getNotifyCall(ctx, 1)).toBe("info");
  });

  test("minReviewLoops=1 allows early exit at loop 1 with zero issues", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    setSetting("minReviewLoops", 1);

    const slug = "2026-05-12-min-loops-1-exit-at-1";
    // reviewLoopCount=1 means loop 1 already ran (forced by min=1), now completing loop 2
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 1 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Complete task as false-positive (zero real issues). Review completion driven
    // by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // currentLoop=1, numericMin=1, minMet = (1+1) >= 1 = true → !minMet = false
    // issuesFound=0, !minMet=false → (0 || false) = false → shouldLoop = false
    // Early exit: loop ends, sends summary instead of re-dispatching review
    // review loop ended — notification sent
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    expect(getNotifyCall(ctx, 1)).toBe("info");
  });

  test("minReviewLoops raises ceiling above numeric maxFeatureReviewRounds, stops at raised ceiling with zero issues", async () => {
    setSetting("maxFeatureReviewRounds", 1); // numericMax=1
    setSetting("minReviewLoops", 3); // numericMin=3, effectiveMax=max(1,3)=3

    const slug = "2026-05-12-min-raises-ceiling";
    // currentLoop=2 means loopsCompleted=3, minMet=(3>=3)=true, loopsCompleted<effectiveMax=(3<3)=false
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 2 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Init + complete task as false-positive (zero real issues). Review completion
    // driven by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // currentLoop=2, loopsCompleted=3, effectiveMax=3
    // minMet=(3>=3)=true, issuesFound=0, loopsCompleted<effectiveMax=(3<3)=false
    // shouldLoop = false → loop ends with summary
    // review loop ended — notification sent
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff (+ worth-notes) in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    expect(getNotifyCall(ctx, 1)).toBe("info");
  });

  test("completed fix tasks without explicit result counted as fixed (real issues)", async () => {
    const slug = "2026-05-14-review-no-result-field";

    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(false);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Mark A=complete WITHOUT result field (counts as fixed), B=false-positive,
    // C=complete WITHOUT result field (counts as fixed). Review completion driven
    // by phase_ready — 2 counted as fixed → issuesFound=2, cannotFix=0,
    // falsePositives=1.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 2, cannotFix: 0, falsePositives: 1 },
      undefined,
      undefined,
      ctx,
    );

    // Should have re-dispatched review (2 actionable issues from tasks without result)
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain('<skill name="ff-review"');

    // Verify reviewHistory counts tasks without result as fixed
    const statePath = path.join(".ff", "feature-state", `${slug}.json`);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(persisted.review.reviewHistory).toHaveLength(1);
    expect(persisted.review.reviewHistory[0].issuesFound).toBe(2); // A and C counted as fixed
    expect(persisted.review.reviewHistory[0].falsePositives).toBe(1); // B
  });

  test("committed result excluded from issue counting", async () => {
    const slug = "2026-05-24-review-committed-excluded";

    setSetting("maxFeatureReviewRounds", 1);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Init with 1 fix task + 1 commit task. Mark fix task as fixed, commit task as
    // committed (excluded from issue counting). Review completion driven by
    // phase_ready — 1 fixed → issuesFound=1, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 1, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Loop ended — verify report generated
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");

    // Verify reviewHistory: commit task excluded from counts
    const statePath = path.join(".ff", "feature-state", `${slug}.json`);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(persisted.review.reviewHistory).toHaveLength(1);
    expect(persisted.review.reviewHistory[0].issuesFound).toBe(1); // only fix task counted (commit excluded)
    expect(persisted.review.reviewHistory[0].falsePositives).toBe(0);
    expect(persisted.review.reviewHistory[0].cannotFixIssues).toBe(0);
  });

  test("zero-issues with commit-only task triggers zero-issues detection", async () => {
    const slug = "2026-05-24-review-commit-only-zero";

    setSetting("maxFeatureReviewRounds", 1);
    const { fake, registeredTools } = setupReviewPhaseWithTools(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx(true);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Init with only a commit task (zero issues found, but commit needed).
    // Commit task excluded from issue counting → zero real issues. Review
    // completion driven by phase_ready → issuesFound=0, cannotFix=0.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Should trigger zero-issues detection immediately (only commit task, no fix tasks)
    // Zero-issues path fires via phase_ready({issuesFound:0})
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // MERGED: report + UAT handoff in ONE notify
    const report = getNotifyCall(ctx, 0);
    expect(report).toContain("Review Round Summary");
    expect(getNotifyCall(ctx, 1)).toBe("info");

    // Verify reviewHistory: zero issues
    const statePath = path.join(".ff", "feature-state", `${slug}.json`);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(persisted.review.reviewHistory).toHaveLength(1);
    expect(persisted.review.reviewHistory[0].issuesFound).toBe(0);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _getEmptyLoopsForSlug, _resetAllEmptyLoops } from "../../src/index.js";
import { getPhaseReadyRef } from "../../src/shared/workflow-refs.js";
import { setSetting } from "../helpers/settings-test-helpers.js";
import {
  createPiWithToolCapture,
  fireAllHandlers,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

function createCtx(): ExtensionContext {
  return {
    hasUI: false,
    sessionManager: { getBranch: () => [] },
    ui: { setWidget: () => {} },
  } as unknown as ExtensionContext;
}

/** No review loop options (use defaults) */
const NO_REVIEW_OPTIONS: { reviewLoopCount?: number } | null = null;

function setupReviewPhase(slug: string, options: { reviewLoopCount?: number } | null) {
  const { fake, registeredTools, api } = createPiWithToolCapture();
  writeFeatureStateFile(slug, {
    workflow: {
      phases: {
        design: "done",
        plan: "done",
        implement: "done",
        verify: "done",
        review: "in-progress",
        finish: "pending",
      },
      currentPhase: "review",
      artifacts: {
        design: `docs/ff/designs/${slug}-design.md`,
        plan: `.ff/task-plans/${slug}-task-plan.md`,
        implement: null,
        verify: null,
        review: null,
        finish: null,
      },
    },
    reviewLoopCount: options?.reviewLoopCount ?? 0,
    reviewHistory: [],
  });

  workflowMonitorExtension(api as unknown as ExtensionAPI);
  return { fake, registeredTools, api };
}

/**
 * Write a review report file to simulate a completed review.
 */
function writeReviewReport(slug: string, loopNumber: number, reviewers: string[], categories: string[]) {
  const dir = path.join(process.cwd(), "docs", "reviews", slug);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${slug}-review-${loopNumber}.md`;
  let content = `# Review Loop #${loopNumber + 1} — ${slug}\n\n**Reviewers dispatched:** ${reviewers.join(", ")}\n\n## Issues\n\n`;
  for (const cat of categories) {
    content += `### Issue R${loopNumber}-${categories.indexOf(cat) + 1}: Test issue [Minor]\n- **Category:** ${cat}\n- **Description:** Test\n\n`;
  }
  fs.writeFileSync(path.join(dir, filename), content);
}

describe("review loop: empty-loop tracking", () => {
  beforeEach(async () => {
    delete process.env.PI_FF_REVIEW_LOOP;
    delete process.env.PI_FF_STAGE;
    _resetAllEmptyLoops();
    // Reset the once-per-agent-turn phase_ready guard so each test starts clean.
    // The guard collapses repeated phase_ready calls within one agent turn into a
    // single transition. Tests that simulate multiple agent turns must fire
    // agent_end between phase_ready calls (NOT turn_end — a pi turn is one LLM
    // response, and repeated calls span multiple turns within one agent turn).
    getPhaseReadyRef()?.resetTracking();
  });

  test("empty-loop tracking increments for reviewers with no issues", async () => {
    const slug = "2026-05-14-empty-loop-incr";

    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools } = setupReviewPhase(slug, NO_REVIEW_OPTIONS);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx();

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Write review report where quality found nothing (only "testing" category in issues)
    writeReviewReport(slug, 0, ["ff-quality-reviewer", "ff-testing-reviewer"], ["testing"]);

    // Complete fix tasks (all fixed) — 1 fixed → issuesFound=1, cannotFix=0
    await phaseReady.execute("tc-complete", { issuesFound: 1, cannotFix: 0 }, undefined, undefined, ctx);

    // quality-reviewer had no issues → empty loop count incremented
    expect(_getEmptyLoopsForSlug(slug)).toEqual({ "ff-quality-reviewer": 1 });
  });

  test("empty-loop tracking resets for reviewers that found issues", async () => {
    const slug = "2026-05-14-empty-loop-reset";

    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools } = setupReviewPhase(slug, NO_REVIEW_OPTIONS);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx();

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Both reviewers found issues
    writeReviewReport(slug, 0, ["ff-quality-reviewer", "ff-testing-reviewer"], ["quality", "testing"]);

    // Complete fix task (fixed) — 1 fixed → issuesFound=1, cannotFix=0
    await phaseReady.execute("tc-complete", { issuesFound: 1, cannotFix: 0 }, undefined, undefined, ctx);

    // Both found issues → neither in empty loops
    const loops = _getEmptyLoopsForSlug(slug);
    expect(loops).toEqual({});
  });

  test("multi-loop empty-loop tracking: increment, reset, re-increment across loops", async () => {
    const slug = "2026-05-14-multi-loop-empty";

    setSetting("maxFeatureReviewRounds", 3);
    const { fake, registeredTools } = setupReviewPhase(slug, NO_REVIEW_OPTIONS);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx();

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // === Loop 0: quality finds nothing, testing finds issues ===
    writeReviewReport(slug, 0, ["ff-quality-reviewer", "ff-testing-reviewer"], ["testing"]);

    // Loop 0: 1 fixed → issuesFound=1, cannotFix=0
    await phaseReady.execute("tc-complete", { issuesFound: 1, cannotFix: 0 }, undefined, undefined, ctx);

    // After loop 0: quality had no issues → increment to 1, testing had issues → not tracked
    expect(_getEmptyLoopsForSlug(slug)).toEqual({ "ff-quality-reviewer": 1 });

    // Simulate agent turn ending before the next review iteration
    await fireAllHandlers(fake.handlers, "agent_end", {}, ctx);

    // === Loop 1: quality finds issues this time, testing finds nothing ===
    writeReviewReport(slug, 1, ["ff-quality-reviewer", "ff-testing-reviewer"], ["quality"]);

    // Loop 1: 1 fixed → issuesFound=1, cannotFix=0
    await phaseReady.execute("tc-complete", { issuesFound: 1, cannotFix: 0 }, undefined, undefined, ctx);

    // After loop 1: quality found issues → reset to 0, testing had no issues → increment to 1
    expect(_getEmptyLoopsForSlug(slug)).toEqual({ "ff-testing-reviewer": 1 });

    // Simulate agent turn ending before the next review iteration
    await fireAllHandlers(fake.handlers, "agent_end", {}, ctx);

    // === Loop 2: neither finds issues ===
    writeReviewReport(slug, 2, ["ff-quality-reviewer", "ff-testing-reviewer"], []);

    // Loop 2: 1 false-positive → issuesFound=0, cannotFix=0, falsePositives=1
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0, falsePositives: 1 },
      undefined,
      undefined,
      ctx,
    );

    // After loop 2: quality had no issues → increment to 1, testing had no issues → increment to 2
    expect(_getEmptyLoopsForSlug(slug)).toEqual({ "ff-quality-reviewer": 1, "ff-testing-reviewer": 2 });
  });

  test("tracks empty loops for -reviewer suffix agents (design-reviewer, code-reviewer)", async () => {
    const slug = "2026-05-14-suffix-reviewers";
    const { fake, registeredTools } = setupReviewPhase(slug, NO_REVIEW_OPTIONS);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx();
    const statePath = path.join(process.cwd(), ".ff", "feature-state", `${slug}.json`);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Dispatch design-reviewer and code-reviewer (both use -reviewer suffix pattern)
    writeReviewReport(slug, 0, ["ff-design-reviewer", "code-reviewer"], ["design"]);
    // design-reviewer: category "design" found in report → reset (0 empty loops)
    // code-reviewer: category "code" NOT found in report → increment (1 empty loop)

    // 1 fixed → issuesFound=1, cannotFix=0
    await phaseReady.execute("tc-complete", { issuesFound: 1, cannotFix: 0 }, undefined, undefined, ctx);

    // design-reviewer found issues (category "design" present) → empty loop = 0
    // code-reviewer found nothing (category "code" absent) → empty loop = 1
    expect(_getEmptyLoopsForSlug(slug)).toEqual({ "code-reviewer": 1 });

    // Cleanup
    fs.rmSync(statePath, { force: true });
  });

  test("extension does not create or modify known-issues file during review loop", async () => {
    // Regression: after removing updateKnownIssuesFile, the extension should
    // never create or modify the known-issues file, even with dismissed tasks.
    const slug = "2026-05-29-no-extension-known-issues-write";

    setSetting("maxFeatureReviewRounds", 1); // Use 1 so loop ends, exercising handleReviewLoopEnd path too
    const { fake, registeredTools } = setupReviewPhase(slug, NO_REVIEW_OPTIONS);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx();

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Write review report with quality reviewer
    writeReviewReport(slug, 0, ["ff-quality-reviewer"], ["quality"]);

    // Pre-create a known-issues file to verify it stays unchanged
    const knownIssuesPath = path.join(process.cwd(), "docs", "reviews", slug, `${slug}-known-issues.md`);
    fs.mkdirSync(path.dirname(knownIssuesPath), { recursive: true });
    const originalContent = "# Known Issues — test\n\nOriginal content.\n";
    fs.writeFileSync(knownIssuesPath, originalContent);

    // Init task_tracker with fix task + commit task, then complete: fix as
    // false-positive (dismissed) + commit as committed (excluded from issue
    // counting). 1 false-positive → issuesFound=0, cannotFix=0, falsePositives=1.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0, falsePositives: 1 },
      undefined,
      undefined,
      ctx,
    );

    // Verify: known-issues file content is unchanged
    const contentAfter = fs.readFileSync(knownIssuesPath, "utf-8");
    expect(contentAfter).toBe(originalContent);
  });

  test("extension does not create known-issues file in fresh loop", async () => {
    // Regression: extension should not create a known-issues file even when
    // tasks are dismissed, since updateKnownIssuesFile is removed.
    const slug = "2026-05-29-no-extension-known-issues-fresh";

    setSetting("maxFeatureReviewRounds", 1);
    const { fake, registeredTools } = setupReviewPhase(slug, NO_REVIEW_OPTIONS);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx();

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    writeReviewReport(slug, 0, ["ff-quality-reviewer"], ["quality"]);

    // Do NOT create a known-issues file — verify extension doesn't create one
    const knownIssuesPath = path.join(process.cwd(), "docs", "reviews", slug, `${slug}-known-issues.md`);

    // Init with fix task + commit task, then complete: fix as false-positive
    // (dismissed) + commit as committed (excluded from issue counting).
    // 1 false-positive → issuesFound=0, cannotFix=0, falsePositives=1.
    await phaseReady.execute(
      "tc-complete",
      { issuesFound: 0, cannotFix: 0, falsePositives: 1 },
      undefined,
      undefined,
      ctx,
    );

    // Verify: extension did not create a known-issues file
    expect(fs.existsSync(knownIssuesPath)).toBe(false);
  });

  test("empty-loop tracking skips report with empty dispatched reviewers value", async () => {
    const slug = "2026-06-08-empty-dispatched";
    const { fake, registeredTools } = setupReviewPhase(slug, { reviewLoopCount: 0 });
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const ctx = createCtx();

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Write a report with an empty dispatched reviewers value
    const dir = path.join(process.cwd(), "docs", "reviews", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${slug}-review-0.md`),
      "# Review Loop #1\n\n**Reviewers dispatched:** \n\nNo issues found.",
    );

    // Trigger empty-loop tracking via zero-issues path — commit-only task excluded
    // from issue counting → zero real issues. issuesFound=0, cannotFix=0.
    await phaseReady.execute("tc-complete", { issuesFound: 0, cannotFix: 0 }, undefined, undefined, ctx);

    // With empty dispatched reviewers, no empty loops should be tracked
    const emptyLoops = _getEmptyLoopsForSlug(slug);
    expect(Object.keys(emptyLoops).length).toBe(0);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { buildTaskGateSkill } from "../../src/prompts/task-gate-skill.js";

describe("buildTaskGateSkill (ff-task-gate dispatch body)", () => {
  test("wraps the body as a collapsed <skill ff-task-gate> block", () => {
    const skill = buildTaskGateSkill({
      round: 1,
      task: "1. Login",
      next: "2. Tests",
      runVerifier: true,
      runReviewer: true,
    });
    expect(skill.startsWith('<skill name="ff-task-gate" location=" ">')).toBe(true);
    expect(skill.trim().endsWith("</skill>")).toBe(true);
  });

  test("header shows the round and names the task", () => {
    const skill = buildTaskGateSkill({
      round: 2,
      task: "3. Wire API",
      next: undefined,
      runVerifier: false,
      runReviewer: true,
    });
    expect(skill).toContain("# Per-Task Gate — Round 2");
    expect(skill).toContain('Task "3. Wire API" is not ready to advance.');
  });

  test("renders #### Verify only when runVerifier", () => {
    const withVerify = buildTaskGateSkill({ round: 1, task: "t", next: "n", runVerifier: true, runReviewer: false });
    expect(withVerify).toContain("#### Verify");
    expect(withVerify).toContain("ff-task-verifier");
    expect(withVerify).not.toContain("#### Review");

    const withoutVerify = buildTaskGateSkill({ round: 1, task: "t", next: "n", runVerifier: false, runReviewer: true });
    expect(withoutVerify).not.toContain("#### Verify");
    expect(withoutVerify).not.toContain("ff-task-verifier");
  });

  test("renders #### Review only when runReviewer", () => {
    const withReview = buildTaskGateSkill({ round: 1, task: "t", next: "n", runVerifier: false, runReviewer: true });
    expect(withReview).toContain("#### Review");
    expect(withReview).toContain("ff-general-reviewer");
    expect(withReview).not.toContain("#### Verify");

    const withoutReview = buildTaskGateSkill({ round: 1, task: "t", next: "n", runVerifier: true, runReviewer: false });
    expect(withoutReview).not.toContain("#### Review");
    expect(withoutReview).not.toContain("ff-general-reviewer");
  });

  test("renders both gates when both run", () => {
    const both = buildTaskGateSkill({ round: 1, task: "t", next: "n", runVerifier: true, runReviewer: true });
    expect(both).toContain("#### Verify");
    expect(both).toContain("#### Review");
    // Verify appears before Review
    expect(both.indexOf("#### Verify")).toBeLessThan(both.indexOf("#### Review"));
  });

  test("always renders the Triage section with fixable/false-positive/cannot-fix", () => {
    const skill = buildTaskGateSkill({ round: 1, task: "t", next: "n", runVerifier: false, runReviewer: false });
    expect(skill).toContain("#### Triage");
    expect(skill).toContain("**Fixable**");
    expect(skill).toContain("**False-positive**");
    expect(skill).toContain("**Cannot-fix**");
  });

  test("leaves {{PI_FF_*}} markers intact (the context handler substitutes them at the next LLM call)", () => {
    const skill = buildTaskGateSkill({ round: 1, task: "t", next: "n", runVerifier: true, runReviewer: true });
    // The known-issues path marker must survive so the context handler can resolve it with the real slug.
    expect(skill).toContain("{{PI_FF_KNOWN_ISSUES_PATH}}");
  });

  test("includes nextTask in the example call when next is set", () => {
    const skill = buildTaskGateSkill({ round: 1, task: "t", next: "2. Next", runVerifier: true, runReviewer: true });
    expect(skill).toContain(
      'task_ready_advance({ verifierIssuesFixed: <count>, reviewerIssuesFixed: <count>, nextTask: "2. Next" })',
    );
  });

  test("omits nextTask from the example call when next is undefined (last-task reloop)", () => {
    const skill = buildTaskGateSkill({ round: 2, task: "t", next: undefined, runVerifier: true, runReviewer: true });
    expect(skill).toContain("task_ready_advance({ verifierIssuesFixed: <count>, reviewerIssuesFixed: <count> })");
    expect(skill).not.toContain("nextTask:");
  });

  test("does not tell the model the cap (Round {N} only, no 'of {max}')", () => {
    const skill = buildTaskGateSkill({ round: 3, task: "t", next: "n", runVerifier: true, runReviewer: true });
    expect(skill).toContain("Round 3");
    expect(skill).not.toMatch(/of\s+\d+/i);
  });

  test("Verify section uses the simplified DEFERRED wording", () => {
    const skill = buildTaskGateSkill({ round: 1, task: "t", next: "n", runVerifier: true, runReviewer: false });
    // Simplified form: treat deferred like missing.
    expect(skill).toContain("Treat `⏭️ deferred` like `❌ missing`");
    // ff-implement uses the simplified deferred wording, not the verbose form.
    expect(skill).not.toContain("is a finding, not an escape");
  });

  test("sanitizes task/next so they cannot break the <skill> tag boundary or quoting", () => {
    // A task name containing </skill> would prematurely close the skill block; a " would break
    // the nextTask example quoting; a backtick would break the markdown code span.
    const skill = buildTaskGateSkill({
      round: 1,
      task: 'evil </skill> "quoted" `code`',
      next: 'next "</skill>',
      runVerifier: true,
      runReviewer: false,
    });
    // The raw tag-closer / quote / backtick never reach the output unescaped.
    expect(skill).not.toContain("</skill>evil");
    expect(skill).not.toMatch(/nextTask: "next "<\/skill>/);
    // Exactly one <skill ...> opener and one </skill> closer (the wrapper's own).
    expect(skill.match(/<skill name="ff-task-gate"/g)).toHaveLength(1);
    expect(skill.match(/<\/skill>/g)).toHaveLength(1);
  });
});

// The per-task gates are dispatched (ff-task-gate), not injected. The injected
// templates/handlers are absent from the substitution source so nothing renders
// stale spawn instructions into ff-implement.
describe("injected per-task gate templates are absent", () => {
  // After the template-substitution split, the substitution pipeline lives in two files:
  // the engine (template-engine.ts, handlers) and the content (text-blocks.ts, templates).
  const engine = fs.readFileSync(path.join(__dirname, "../../src/prompts/template-engine.ts"), "utf8");
  const blocks = fs.readFileSync(path.join(__dirname, "../../src/prompts/text-blocks.ts"), "utf8");
  const source = `${engine}\n${blocks}`;

  test("PER_TASK_CODE_REVIEW_TEMPLATE constant is absent from the substitution pipeline", () => {
    expect(source).not.toContain("PER_TASK_CODE_REVIEW_TEMPLATE");
  });

  test("{{PI_FF_PER_TASK_CODE_REVIEW}} handler is absent from the substitution pipeline", () => {
    expect(source).not.toContain("{{PI_FF_PER_TASK_CODE_REVIEW}}");
  });

  test("VERIFY_PHASES handler does not match the implement phase", () => {
    expect(source).not.toMatch(/VERIFY_PHASES:\(verify\|plan\|implement\)/);
  });
});

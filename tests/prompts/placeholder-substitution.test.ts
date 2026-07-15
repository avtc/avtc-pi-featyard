// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { substitutePlaceholders } from "../../src/prompts/template-engine.js";
import { buildFallbackReportPath, buildReportFilePath } from "../../src/state/artifact-paths.js";
import { resetSettingsState, setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import { cleanupAfterTest, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

/** Build a fake fs for path-builder tests: existsSync/readdirSync backed by a fixed file list. */
function mockFs(exists: boolean | null, files: string[] | null): typeof fs {
  return {
    existsSync: () => exists ?? false,
    readdirSync: () => [...(files ?? [])],
    mkdirSync: () => {},
  } as unknown as typeof fs;
}

// Every test runs in a temp dir: buildFallbackReportPath (no-slug report-file path) does a real
// mkdirSync(".featyard/reviews/<date>") through the production fs, which must land in the temp, never
// the real repo's.featyard junction / external store.
beforeEach(() => {
  setTestSettings(null);
  withTempCwd();
});

afterEach(() => {
  cleanupAfterTest();
});

describe("substitutePlaceholders", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  afterEach(() => {
    resetSettingsState();
  });

  it("returns text unchanged when no placeholders present", () => {
    const text = "No placeholders here.";
    expect(substitutePlaceholders(text, {})).toBe(text);
  });

  it("replaces {{PI_FY_ARCHITECTURE_PRINCIPLES}} with the canonical principles block", () => {
    const result = substitutePlaceholders("## Architecture\n{{PI_FY_ARCHITECTURE_PRINCIPLES}}\nEnd.", {});
    expect(result).not.toContain("{{PI_FY_ARCHITECTURE_PRINCIPLES}}");
    // Universal principles appear in the shared block...
    expect(result).toContain("Apply SOLID, Clean Architecture, best practices");
    expect(result).toContain("Single source of truth");
    expect(result).toContain("dependency inversion");
    expect(result).toContain("Make invalid states unrepresentable");
    // ...but the planning-only coverage bullet does NOT (it lives in design/plan skills, not the shared block)
    expect(result).not.toContain("Specify what must be covered");
    expect(result).toContain("End.");
  });

  it("replaces {{PI_FY_COVERAGE_REVIEW_PROCESS}} with the coverage-first review process block", () => {
    const result = substitutePlaceholders("## Process\n{{PI_FY_COVERAGE_REVIEW_PROCESS}}\nEnd.", {});
    expect(result).not.toContain("{{PI_FY_COVERAGE_REVIEW_PROCESS}}");
    // The four steps of the coverage-first skeleton are present
    expect(result).toContain("## Process\n");
    expect(result).not.toContain("## Process — Coverage-First Review");
    expect(result).toContain("Build the checklist (your first todo item)");
    expect(result).toContain("Work every item in order, one at a time");
    expect(result).toContain("Re-validate (last item)");
    // Re-validation cross-checks findings against the known-issues file (drop dismissed duplicates)
    expect(result).toContain("known-issues file");
    // Bullets under an area are checks per leaf, NOT separate todo items (prevents list explosion)
    expect(result).toContain("are NOT items");
    expect(result).toContain("append it to the report file IMMEDIATELY");
    // Coverage tracked via todo, report is issues-only — not free-form scanning
    expect(result).toContain("track coverage through the todo list, not the report");
    // Coverage Areas belong to each reviewer's prompt, NOT this shared block
    expect(result).not.toContain("Coverage Areas");
    expect(result).toContain("End.");
  });

  it("replaces {{PI_FY_DOC_COVERAGE_PROCESS}} with the doc coverage-first process block", () => {
    const result = substitutePlaceholders("## Process\n{{PI_FY_DOC_COVERAGE_PROCESS}}\nEnd.", {});
    expect(result).not.toContain("{{PI_FY_DOC_COVERAGE_PROCESS}}");
    expect(result).toContain("## Process\n");
    expect(result).not.toContain("## Process — Coverage-First Review");
    expect(result).toContain("enumerate the document into checkable items");
    expect(result).toContain("Build the checklist (your first todo item)");
    expect(result).toContain("Re-validate (last item)");
    // Re-validation cross-checks findings against the known-issues file (drop dismissed duplicates)
    expect(result).toContain("known-issues file");
    // Bullets under an area are checks per leaf, NOT separate todo items (prevents list explosion)
    expect(result).toContain("are NOT items");
    expect(result).not.toContain("git diff");
    // Coverage Areas belong to each reviewer's prompt, NOT this shared block
    expect(result).not.toContain("Coverage Areas");
    expect(result).toContain("End.");
  });

  it("replaces {{PI_FY_ADDITIONAL_AREAS_OF_ATTENTION}} with the concerns checklist (no heading)", () => {
    const result = substitutePlaceholders("{{PI_FY_ADDITIONAL_AREAS_OF_ATTENTION}}", {});
    expect(result).not.toContain("{{PI_FY_ADDITIONAL_AREAS_OF_ATTENTION}}");
    // Heading-less body (like ARCHITECTURE_PRINCIPLES) — the consumer owns the heading
    expect(result).not.toContain("## Additional areas of attention");
    expect(result).toContain("**Security**");
    expect(result).toContain("**Performance**");
    expect(result).toContain("**Testing**");
    expect(result).toContain("N+1 queries");
    // Deduped against the architecture principles — SOLID/error-handling live there, not here
    expect(result).not.toContain("Apply SOLID, Clean Architecture");
    // The extend-note was removed
    expect(result).not.toContain("AGENTS.md");
  });

  it("replaces {{PI_FY_WORTH_NOTES_PATH}} with slug-based path when slug provided", () => {
    const result = substitutePlaceholders("Save to {{PI_FY_WORTH_NOTES_PATH}}.", {
      slug: "2026-06-23-foo",
    });
    expect(result).toBe("Save to .featyard/reviews/2026-06-23-foo/2026-06-23-foo-worth-notes.md.");
    expect(result).not.toContain("{{PI_FY_WORTH_NOTES_PATH}}");
  });

  it("replaces {{PI_FY_WORTH_NOTES_PATH}} with date-based fallback when no slug", () => {
    const result = substitutePlaceholders("Save to {{PI_FY_WORTH_NOTES_PATH}}.", {});
    // No slug -> date-based accumulated file (manual fy-implement invocation)
    expect(result).toMatch(/\.featyard\/reviews\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}-worth-notes\.md\./);
    expect(result).not.toContain("{{PI_FY_WORTH_NOTES_PATH}}");
    expect(result).not.toContain("(not available)");
  });

  it("replaces {{PI_FY_IMPLEMENTER_GUIDANCE}} with the full guidance (inner placeholders inlined)", () => {
    const result = substitutePlaceholders("{{PI_FY_IMPLEMENTER_GUIDANCE}}", {});
    expect(result).not.toContain("{{PI_FY_IMPLEMENTER_GUIDANCE}}");
    // Guidance sections present
    expect(result).toContain("## Cycle");
    expect(result).toContain("## Discipline");
    expect(result).toContain("## Blockers");
    // Inner placeholders are INLINED (resolved in code) — no residual tokens
    expect(result).toContain("Apply SOLID, Clean Architecture, best practices");
    expect(result).toContain("**Requirements**");
    expect(result).not.toContain("{{PI_FY_ARCHITECTURE_PRINCIPLES}}");
    expect(result).not.toContain("{{PI_FY_ADDITIONAL_AREAS_OF_ATTENTION}}");
  });

  it("replaces {{PI_FY_REVIEWER_SKIP}} with skip context", () => {
    const result = substitutePlaceholders("Skip: {{PI_FY_REVIEWER_SKIP}} end", {});
    expect(result).not.toContain("{{PI_FY_REVIEWER_SKIP}}");
    expect(result).toContain("threshold");
  });

  it("handles both placeholders in same text", () => {
    const result = substitutePlaceholders("{{PI_FY_FEATURE_SLUG}} and {{PI_FY_REVIEWER_SKIP}}", {});
    expect(result).not.toContain("{{PI_FY_");
  });

  it("replaces {{PI_FY_REPORT_FILE}} with a date-based fallback when no slug or agentName provided", () => {
    const result = substitutePlaceholders("Write only to `{{PI_FY_REPORT_FILE}}`.", {});
    expect(result).toMatch(
      /\.featyard\/reviews\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}-(?:report|review)(-\S+)?-\d+\.md/,
    );
    expect(result).not.toContain("{{PI_FY_REPORT_FILE}}");
  });

  it("replaces {{PI_FY_REPORT_FILE}} with slug+agentName derived path", () => {
    const result = substitutePlaceholders("Write only to `{{PI_FY_REPORT_FILE}}`.", {
      slug: "2026-06-01-codebase-refactoring",
      agentName: "quality",
      loopIndex: 2,
    });
    expect(result).toBe(
      "Write only to `.featyard/reviews/2026-06-01-codebase-refactoring/2026-06-01-codebase-refactoring-quality-2.md`.",
    );
    expect(result).not.toContain("{{PI_FY_REPORT_FILE}}");
  });

  it("replaces {{PI_FY_REPORT_FILE}} with slug+agentName path without loop number", () => {
    const result = substitutePlaceholders("Write only to `{{PI_FY_REPORT_FILE}}`.", {
      slug: "2026-06-01-codebase-refactoring",
      agentName: "quality",
    });
    expect(result).toBe(
      "Write only to `.featyard/reviews/2026-06-01-codebase-refactoring/2026-06-01-codebase-refactoring-quality.md`.",
    );
  });

  it("replaces {{PI_FY_REPORT_FILE}} with slug+agentName+taskName path for per-task review", () => {
    const result = substitutePlaceholders("Write only to `{{PI_FY_REPORT_FILE}}`.", {
      slug: "2026-06-01-nonexistent-feature",
      agentName: "fy-general-reviewer",
      taskName: "3. Wire the login form",
      loopIndex: 0,
    });
    expect(result).toBe(
      "Write only to `.featyard/reviews/2026-06-01-nonexistent-feature/2026-06-01-nonexistent-feature-task-3-wire-the-login-form-fy-general-reviewer-0.md`.",
    );
  });

  it("replaces {{PI_FY_REPORT_FILE}} with slug+agentName+taskName path without loop number", () => {
    const result = substitutePlaceholders("Write only to `{{PI_FY_REPORT_FILE}}`.", {
      slug: "2026-06-01-nonexistent-feature",
      agentName: "fy-general-reviewer",
      taskName: "5. Add validator",
    });
    expect(result).toBe(
      "Write only to `.featyard/reviews/2026-06-01-nonexistent-feature/2026-06-01-nonexistent-feature-task-5-add-validator-fy-general-reviewer.md`.",
    );
  });

  it("replaces {{PI_FY_REPORT_FILE}} with loopIndex 0 (first review loop)", () => {
    const result = substitutePlaceholders("Write only to `{{PI_FY_REPORT_FILE}}`.", {
      slug: "2026-06-01-nonexistent-feature",
      agentName: "fy-quality-reviewer",
      loopIndex: 0,
    });
    expect(result).toBe(
      "Write only to `.featyard/reviews/2026-06-01-nonexistent-feature/2026-06-01-nonexistent-feature-fy-quality-reviewer-0.md`.",
    );
  });

  it("replaces {{PI_FY_REVIEWER_SKIP}} with actual emptyLoops data", () => {
    const emptyLoops = { "fy-quality-reviewer": 2, "fy-testing-reviewer": 0 };
    const result = substitutePlaceholders("Skip: {{PI_FY_REVIEWER_SKIP}} end", { emptyLoops });
    expect(result).toContain("fy-quality-reviewer");
    expect(result).toContain("2");
    expect(result).toContain("fy-testing-reviewer");
    expect(result).toContain("0");
  });

  it("outputs skipping disabled message when reviewerSkipThreshold is 0", () => {
    setSetting("reviewerSkipThreshold", 0);
    const result = substitutePlaceholders("Skip: {{PI_FY_REVIEWER_SKIP}} end", {});
    expect(result).toContain("Skipping is disabled");
    expect(result).toContain("dispatch all relevant reviewers");
  });
});

describe("PI_FY_DESIGN_REPORT_FILE placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("replaces with slug-based path when slug provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_DESIGN_REPORT_FILE}}.", { slug: "my-feature" });
    expect(result).toMatch(/\.featyard\/reviews\/my-feature\/my-feature-design-review\.md/);
    expect(result).not.toContain("{{PI_FY_DESIGN_REPORT_FILE}}");
  });

  it("falls back to a date-based path when no slug provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_DESIGN_REPORT_FILE}}.", {});
    expect(result).toMatch(/\.featyard\/reviews\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}-design-review-\S*-\d+\.md/);
    expect(result).not.toContain("{{PI_FY_DESIGN_REPORT_FILE}}");
  });
});

describe("PI_FY_PLAN_REPORT_FILE placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("replaces with slug-based path when slug provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_PLAN_REPORT_FILE}}.", { slug: "my-feature" });
    expect(result).toMatch(/\.featyard\/reviews\/my-feature\/my-feature-plan-review\.md/);
    expect(result).not.toContain("{{PI_FY_PLAN_REPORT_FILE}}");
  });

  it("falls back to a date-based path when no slug provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_PLAN_REPORT_FILE}}.", {});
    expect(result).toMatch(/\.featyard\/reviews\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}-plan-review-\S*-\d+\.md/);
    expect(result).not.toContain("{{PI_FY_PLAN_REPORT_FILE}}");
  });
});

describe("both report file placeholders together", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("both placeholders in same text produce consistent paths", () => {
    const result = substitutePlaceholders("Design: {{PI_FY_DESIGN_REPORT_FILE}} and Plan: {{PI_FY_PLAN_REPORT_FILE}}", {
      slug: "my-feature",
    });
    expect(result).not.toContain("{{PI_FY_");

    // Verify slug subfolder is present in both paths
    expect(result).toContain(".featyard/reviews/my-feature/");

    // Verify correct file types
    expect(result).toContain("my-feature-design-review.md");
    expect(result).toContain("my-feature-plan-review.md");
  });
});

describe("PI_FY_DESIGN_REPORT_FILE with loopIndex", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("appends loop index suffix when loopIndex provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_DESIGN_REPORT_FILE}}.", {
      slug: "my-feature",
      loopIndex: 3,
    });
    expect(result).toMatch(/\.featyard\/reviews\/my-feature\/my-feature-design-review-3\.md/);
    expect(result).not.toContain("{{PI_FY_DESIGN_REPORT_FILE}}");
  });

  it("appends loop index 0 suffix", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_DESIGN_REPORT_FILE}}.", {
      slug: "my-feature",
      loopIndex: 0,
    });
    expect(result).toMatch(/\.featyard\/reviews\/my-feature\/my-feature-design-review-0\.md/);
  });
});

describe("PI_FY_PLAN_REPORT_FILE with loopIndex", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("appends loop index suffix when loopIndex provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_PLAN_REPORT_FILE}}.", { slug: "my-feature", loopIndex: 2 });
    expect(result).toMatch(/\.featyard\/reviews\/my-feature\/my-feature-plan-review-2\.md/);
    expect(result).not.toContain("{{PI_FY_PLAN_REPORT_FILE}}");
  });
});

describe("PI_FY_REVIEW_REPORT_FILE placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("replaces with slug-based path when slug provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_REVIEW_REPORT_FILE}}.", { slug: "my-feature" });
    expect(result).toMatch(/\.featyard\/reviews\/my-feature\/my-feature-review\.md/);
    expect(result).not.toContain("{{PI_FY_REVIEW_REPORT_FILE}}");
  });

  it("falls back to a date-based path when no slug provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_REVIEW_REPORT_FILE}}.", {});
    expect(result).toMatch(/\.featyard\/reviews\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}-review-\S*-\d+\.md/);
    expect(result).not.toContain("{{PI_FY_REVIEW_REPORT_FILE}}");
  });

  it("appends loop index suffix when loopIndex provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_REVIEW_REPORT_FILE}}.", {
      slug: "my-feature",
      loopIndex: 2,
    });
    expect(result).toMatch(/\.featyard\/reviews\/my-feature\/my-feature-review-2\.md/);
    expect(result).not.toContain("{{PI_FY_REVIEW_REPORT_FILE}}");
  });

  it("appends loop index 0 suffix", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_REVIEW_REPORT_FILE}}.", {
      slug: "my-feature",
      loopIndex: 0,
    });
    expect(result).toMatch(/\.featyard\/reviews\/my-feature\/my-feature-review-0\.md/);
  });
});

describe("buildReportFilePath", () => {
  it("builds design review path with loop number", () => {
    const path = buildReportFilePath("my-feature", "design-review", 2, mockFs(null, null));
    expect(path).toBe(".featyard/reviews/my-feature/my-feature-design-review-2.md");
  });

  it("builds plan review path with loop number", () => {
    const path = buildReportFilePath("my-feature", "plan-review", 0, mockFs(null, null));
    expect(path).toBe(".featyard/reviews/my-feature/my-feature-plan-review-0.md");
  });

  it("builds path without loop number when undefined and no files exist", () => {
    const path = buildReportFilePath("my-feature", "design-review", null, mockFs(null, null));
    expect(path).toBe(".featyard/reviews/my-feature/my-feature-design-review.md");
  });

  it("picks next available number when counter=0 but files exist on disk", () => {
    const filePath = buildReportFilePath(
      "my-feature",
      "design-review",
      0,
      mockFs(true, ["my-feature-design-review-0.md", "my-feature-design-review-1.md"]),
    );
    expect(filePath).toBe(".featyard/reviews/my-feature/my-feature-design-review-2.md");
  });

  it("uses counter when counter > highest file on disk", () => {
    const filePath = buildReportFilePath(
      "my-feature",
      "design-review",
      5,
      mockFs(true, ["my-feature-design-review-0.md"]),
    );
    expect(filePath).toBe(".featyard/reviews/my-feature/my-feature-design-review-5.md");
  });

  it("picks next number when loopNumber is undefined but files exist", () => {
    const filePath = buildReportFilePath(
      "my-feature",
      "design-review",
      null,
      mockFs(true, ["my-feature-design-review-0.md", "my-feature-design-review-3.md"]),
    );
    expect(filePath).toBe(".featyard/reviews/my-feature/my-feature-design-review-4.md");
  });

  it("ignores files with different prefix when scanning", () => {
    const filePath = buildReportFilePath(
      "my-feature",
      "design-review",
      0,
      mockFs(true, ["my-feature-plan-review-0.md", "my-feature-plan-review-5.md", "my-feature-known-issues.md"]),
    );
    expect(filePath).toBe(".featyard/reviews/my-feature/my-feature-design-review-0.md");
  });

  it("handles manual review after extension loop finished (counter reset, files exist)", () => {
    const filePath = buildReportFilePath(
      "my-feature",
      "review",
      0,
      mockFs(true, ["my-feature-review-0.md", "my-feature-review-1.md", "my-feature-review-2.md"]),
    );
    // Counter says 0 (phase changed / reset), but files show 3 reviews already done
    expect(filePath).toBe(".featyard/reviews/my-feature/my-feature-review-3.md");
  });

  it("handles slug with special regex characters", () => {
    const filePath = buildReportFilePath("my.feature", "review", 0, mockFs(true, ["my.feature-review-0.md"]));
    expect(filePath).toBe(".featyard/reviews/my.feature/my.feature-review-1.md");
  });
});

describe("PI_FY_DESIGN_DOC_PATH placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("replaces with slug-based exact path when slug provided (committed mode)", () => {
    setSetting("designDocStorage", "committed");
    const result = substitutePlaceholders("Save to {{PI_FY_DESIGN_DOC_PATH}}.", {
      slug: "2026-05-22-my-feature",
    });
    expect(result).toBe("Save to docs/featyard/designs/2026-05-22-my-feature-design.md.");
    expect(result).not.toContain("{{PI_FY_DESIGN_DOC_PATH}}");
  });

  it("replaces with the local path when designDocStorage = local (default)", () => {
    const result = substitutePlaceholders("Save to {{PI_FY_DESIGN_DOC_PATH}}.", {
      slug: "2026-05-22-my-feature",
    });
    expect(result).toBe("Save to .featyard/designs/2026-05-22-my-feature-design.md.");
  });

  it("replaces with template hint when no slug provided (local mode default)", () => {
    const result = substitutePlaceholders("Save to {{PI_FY_DESIGN_DOC_PATH}}.", {});
    expect(result).toContain(".featyard/designs/YYYY-MM-DD-<topic>-design.md");
    expect(result).not.toContain("{{PI_FY_DESIGN_DOC_PATH}}");
  });
});

describe("PI_FY_RESEARCH_DIR placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("replaces with absolute path when slug provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_RESEARCH_DIR}}.", {
      slug: "2026-06-01-codebase-refactoring",
    });
    const expected = path.resolve(process.cwd(), ".featyard", "research", "2026-06-01-codebase-refactoring");
    expect(result).toBe(`Write to ${expected}.`);
    expect(result).not.toContain("{{PI_FY_RESEARCH_DIR}}");
  });

  it("replaces with date-wrapped fallback path when no slug provided", () => {
    const result = substitutePlaceholders("Write to {{PI_FY_RESEARCH_DIR}}.", {});
    // Fallback wraps in <date>/<date>-<topic>/ (matches reviews/ pattern) so age-clean targets
    // a bare <date> dir in research/ too. <date> is a real ISO date (ctx.date), not the literal
    // 'YYYY-MM-DD' placeholder.
    expect(result).not.toContain("YYYY-MM-DD");
    expect(result).toMatch(/Write to (.*)\.featyard[\\/]research[\\/](\d{4}-\d{2}-\d{2})[\\/]\2-<topic>[\\/]?\.$/);
    expect(path.isAbsolute(result.replace(/^Write to |\.$/g, ""))).toBe(true);
    expect(result).not.toContain("{{PI_FY_RESEARCH_DIR}}");
  });

  it("replaces multiple occurrences", () => {
    const result = substitutePlaceholders("Input: {{PI_FY_RESEARCH_DIR}}\nOutput: {{PI_FY_RESEARCH_DIR}}", {
      slug: "my-feature",
    });
    const expected = path.resolve(process.cwd(), ".featyard", "research", "my-feature");
    expect(result).toBe(`Input: ${expected}\nOutput: ${expected}`);
  });

  it("produces absolute path (not relative)", () => {
    const result = substitutePlaceholders("{{PI_FY_RESEARCH_DIR}}", {
      slug: "test-slug",
    });
    expect(path.isAbsolute(result)).toBe(true);
  });
});

describe("PI_FY_PLAN_DOC_PATH placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("replaces with slug-based exact path when slug provided", () => {
    const result = substitutePlaceholders("Save to {{PI_FY_PLAN_DOC_PATH}}.", {
      slug: "2026-05-22-my-feature",
    });
    expect(result).toBe("Save to .featyard/task-plans/2026-05-22-my-feature-task-plan.md.");
    expect(result).not.toContain("{{PI_FY_PLAN_DOC_PATH}}");
  });

  it("replaces with date-wrapped fallback path when no slug provided", () => {
    const result = substitutePlaceholders("Save to {{PI_FY_PLAN_DOC_PATH}}.", {});
    // Fallback wraps in <date>/<date>-<feature-name> (matches reviews/ pattern) so age-clean
    // targets a bare <date> dir in task-plans/ too. Relative file path (unchanged convention).
    expect(result).not.toContain("YYYY-MM-DD");
    expect(result).toMatch(
      /^Save to \.featyard[\\/]task-plans[\\/](\d{4}-\d{2}-\d{2})[\\/]\1-<feature-name>-task-plan\.md\.$/,
    );
    expect(result).not.toContain("{{PI_FY_PLAN_DOC_PATH}}");
  });

  it("replaces multiple occurrences (slug path)", () => {
    const result = substitutePlaceholders("Plan A: {{PI_FY_PLAN_DOC_PATH}}\nPlan B: {{PI_FY_PLAN_DOC_PATH}}", {
      slug: "my-feature",
    });
    expect(result).toBe(
      "Plan A: .featyard/task-plans/my-feature-task-plan.md\nPlan B: .featyard/task-plans/my-feature-task-plan.md",
    );
  });
});

describe("PI_FY_DESIGN_RELATIVE_DIR placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("resolves to the local design-doc directory by default (designDocStorage = local)", () => {
    // Decouples skill/prompt text from the literal path: the marker resolves to the design-doc
    // directory selected by the designDocStorage setting — 'local' (.featyard/designs) by default.
    const result = substitutePlaceholders("Write design docs to {{PI_FY_DESIGN_RELATIVE_DIR}}/.", {});
    expect(result).toBe("Write design docs to .featyard/designs/.");
    expect(result).not.toContain("{{PI_FY_DESIGN_RELATIVE_DIR}}");
  });

  it("resolves to the in-repo directory when designDocStorage = committed", () => {
    setSetting("designDocStorage", "committed");
    const result = substitutePlaceholders("{{PI_FY_DESIGN_RELATIVE_DIR}}", {});
    expect(result).toBe("docs/featyard/designs");
  });

  it("is independent of slug/date (constant dir per mode, not a per-feature path)", () => {
    const noSlug = substitutePlaceholders("{{PI_FY_DESIGN_RELATIVE_DIR}}", {});
    const withSlug = substitutePlaceholders("{{PI_FY_DESIGN_RELATIVE_DIR}}", {
      slug: "2026-06-29-x",
    });
    expect(noSlug).toBe(".featyard/designs");
    expect(withSlug).toBe(".featyard/designs");
  });
});

describe("PI_FY_DESIGN_HANDOFF placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  it("instructs to skip the commit when designDocStorage = local (default)", () => {
    const result = substitutePlaceholders("- {{PI_FY_DESIGN_HANDOFF}}", {});
    expect(result).toBe(
      "- The design file is gitignored under `.featyard/` (do not commit). Signal the phase complete with the `phase_ready` tool. End your turn.",
    );
    expect(result).not.toContain("{{PI_FY_DESIGN_HANDOFF}}");
    expect(result).not.toContain("Commit the design file");
  });

  it("instructs to commit when designDocStorage = committed", () => {
    setSetting("designDocStorage", "committed");
    const result = substitutePlaceholders("- {{PI_FY_DESIGN_HANDOFF}}", {});
    expect(result).toBe(
      "- Commit the design file, then signal the phase complete with the `phase_ready` tool. End your turn.",
    );
    expect(result).not.toContain("{{PI_FY_DESIGN_HANDOFF}}");
  });
});

describe("PI_FY_REVIEWER_DISPATCH", () => {
  it("injects general dispatch when featureReviewMode is general", () => {
    setSetting("featureReviewMode", "general");
    const result = substitutePlaceholders("Step 2:\n{{PI_FY_REVIEWER_DISPATCH}}", {});
    expect(result).toContain("fy-general-reviewer");
    expect(result).not.toContain("{{PI_FY_REVIEWER_SKIP}}");
  });

  it("injects comprehensive dispatch when featureReviewMode is comprehensive", () => {
    setSetting("featureReviewMode", "comprehensive");
    const result = substitutePlaceholders("Step 2:\n{{PI_FY_REVIEWER_DISPATCH}}", {});
    expect(result).toContain("fy-quality-reviewer");
    expect(result).toContain("fy-testing-reviewer");
    expect(result).toContain("fy-security-reviewer");
    expect(result).toContain("fy-performance-reviewer");
    expect(result).toContain("fy-guidelines-reviewer");
    expect(result).toContain("fy-requirements-reviewer");
    expect(result).toContain("Dispatch ALL 6");
  });

  it("pre-resolves PI_FY_REVIEWER_SKIP before injection", () => {
    setSetting("featureReviewMode", "general");
    const result = substitutePlaceholders("Step 2:\n{{PI_FY_REVIEWER_DISPATCH}}", {});
    expect(result).not.toContain("{{PI_FY_REVIEWER_SKIP}}");
  });
});

describe("PI_FY_VERIFY_PHASES", () => {
  it("resolves to content block when phase is included", () => {
    setSetting("verifyPhases", "plan+implement+verify");
    const input = "Before\n{{PI_FY_VERIFY_PHASES:verify}}\nAfter";
    const result = substitutePlaceholders(input, {});
    expect(result).toContain("Spawn fy-feature-verifier");
    expect(result).toContain("Fallback");
    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).not.toContain("{{PI_FY_VERIFY_ITERATIONS}}");
  });

  it("embeds the maxVerifyRounds count literally (no chained placeholder)", () => {
    setSetting("verifyPhases", "plan+implement+verify");
    setSetting("maxVerifyRounds", 5);
    const input = "Before\n{{PI_FY_VERIFY_PHASES:verify}}\nAfter";
    const result = substitutePlaceholders(input, {});
    expect(result).toContain("Max iterations: 5");
    expect(result).not.toContain("{{PI_FY_VERIFY_ITERATIONS}}");
  });

  it("defaults to 3 iterations when maxVerifyRounds is unset", () => {
    resetSettingsState(); // clear leaked maxVerifyRounds from sibling tests
    setSetting("verifyPhases", "plan+implement+verify");
    // maxVerifyRounds intentionally NOT set — exercises the `?? "3"` default
    const result = substitutePlaceholders("{{PI_FY_VERIFY_PHASES:verify}}", {});
    expect(result).toContain("Max iterations: 3");
    expect(result).not.toContain("{{PI_FY_");
  });

  it("resolves to empty string when phase is off", () => {
    setSetting("verifyPhases", "off");
    const input = "Before\n{{PI_FY_VERIFY_PHASES:verify}}\nAfter";
    const result = substitutePlaceholders(input, {});
    expect(result).toBe("Before\n\nAfter");
    expect(result).not.toContain("Spawn");
  });

  it("resolves plan phase correctly", () => {
    setSetting("verifyPhases", "plan+verify");
    const result = substitutePlaceholders("{{PI_FY_VERIFY_PHASES:plan}}", {});
    expect(result).toContain("Spawn `fy-plan-verifier`");
  });

  it("unrecognized phase name resolves to empty string", () => {
    setSetting("verifyPhases", "verify");
    const result = substitutePlaceholders("{{PI_FY_VERIFY_PHASES:unknown}}", {});
    expect(result).not.toContain("Spawn");
  });

  it("verify loop treats `⏭️ deferred` as a finding to fix, not an escape", () => {
    setSetting("verifyPhases", "verify");
    const result = substitutePlaceholders("{{PI_FY_VERIFY_PHASES:verify}}", {});
    expect(result).toContain("`⏭️ deferred` is a finding, not an escape");
    expect(result).toContain("treat it like `❌ missing`");
  });

  it("plan loop treats `⏭️ deferred` as a finding to fix", () => {
    setSetting("verifyPhases", "plan");
    const result = substitutePlaceholders("{{PI_FY_VERIFY_PHASES:plan}}", {});
    expect(result).toContain("`⏭️ deferred` is a finding, not an escape");
  });
});

describe("PI_FY_RESEARCHER_DELEGATION", () => {
  it("resolves to delegation section when nestedResearchers is on", () => {
    setSetting("nestedResearchers", "on");
    const input = "Before\n{{PI_FY_RESEARCHER_DELEGATION}}\nAfter";
    const result = substitutePlaceholders(input, {});
    expect(result).toContain("## Delegation");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("resolves to empty string when nestedResearchers is off", () => {
    setSetting("nestedResearchers", "off");
    const input = "Before\n{{PI_FY_RESEARCHER_DELEGATION}}\nAfter";
    const result = substitutePlaceholders(input, {});
    expect(result).toBe("Before\n\nAfter");
    expect(result).not.toContain("Delegation");
  });

  it("defaults to delegation section when nestedResearchers is not specified", () => {
    resetSettingsState();
    const result = substitutePlaceholders("{{PI_FY_RESEARCHER_DELEGATION}}", {});
    expect(result).toContain("## Delegation");
    expect(result).toContain("subagent");
  });

  it("does not affect text without the placeholder", () => {
    setSetting("nestedResearchers", "on");
    const input = "No placeholder here";
    const result = substitutePlaceholders(input, {});
    expect(result).toBe("No placeholder here");
  });
});

describe("malformed placeholder syntax", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  afterEach(() => {
    resetSettingsState();
  });

  it("leaves unclosed {{PI_FY_ prefix unchanged", () => {
    const text = "Before {{PI_FY_FEATURE_SLUG after";
    const result = substitutePlaceholders(text, {});
    expect(result).toBe(text);
  });

  it("leaves partial placeholder name unchanged", () => {
    const text = "{{PI_FY_REVIEW}} is not a real placeholder";
    const result = substitutePlaceholders(text, {});
    expect(result).toBe(text);
  });

  it("leaves empty braces unchanged", () => {
    const text = "Before {{}} after";
    const result = substitutePlaceholders(text, {});
    expect(result).toBe(text);
  });

  it("is case-sensitive — lowercase not replaced", () => {
    const text = "{{pi_sp_review_passes}} should not be replaced";
    const result = substitutePlaceholders(text, {});
    expect(result).toBe(text);
  });

  it("leaves single-brace placeholders unchanged", () => {
    const text = "Before {PI_FY_FEATURE_SLUG} after";
    const result = substitutePlaceholders(text, {});
    expect(result).toBe(text);
  });

  it("handles triple-braced placeholder gracefully", () => {
    const text = "{{{PI_FY_FEATURE_SLUG}}} extra brace";
    // The function replaces {{PI_FY_FEATURE_SLUG}} leaving the outer { and }
    const result = substitutePlaceholders(text, {});
    expect(result).toContain("YYYY-MM-DD");
    expect(result).not.toContain("{{PI_FY_FEATURE_SLUG}}");
  });

  it("handles adjacent placeholders without separator", () => {
    setSetting("featureReviewMode", "general");
    const text = "{{PI_FY_FEATURE_SLUG}}{{PI_FY_REVIEWER_DISPATCH}}";
    const result = substitutePlaceholders(text, {});
    expect(result).not.toContain("{{PI_FY_FEATURE_SLUG}}");
    expect(result).not.toContain("{{PI_FY_REVIEWER_DISPATCH}}");
  });

  it("does not replace PI_FY_ prefix without braces", () => {
    const text = "PI_FY_FEATURE_SLUG is just text";
    const result = substitutePlaceholders(text, {});
    expect(result).toBe(text);
  });
});

describe("buildFallbackReportPath", () => {
  it("returns N=1 when directory does not exist", () => {
    const path = buildFallbackReportPath("2026-06-05", "my-topic", "fy-general-reviewer", mockFs(false, null));
    expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-my-topic-fy-general-reviewer-1.md");
  });

  it("returns N=1 when directory is empty", () => {
    const path = buildFallbackReportPath("2026-06-05", "my-topic", "fy-general-reviewer", mockFs(true, []));
    expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-my-topic-fy-general-reviewer-1.md");
  });

  it("returns N=3 when existing files end in -1 and -2", () => {
    const path = buildFallbackReportPath(
      "2026-06-05",
      "my-topic",
      "fy-general-reviewer",
      mockFs(true, ["2026-06-05-my-topic-fy-general-reviewer-1.md", "2026-06-05-my-topic-fy-general-reviewer-2.md"]),
    );
    expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-my-topic-fy-general-reviewer-3.md");
  });

  it("only matches files for the same topic+agent combo", () => {
    const path = buildFallbackReportPath(
      "2026-06-05",
      "my-topic",
      "fy-general-reviewer",
      mockFs(true, [
        "2026-06-05-other-topic-fy-general-reviewer-5.md",
        "2026-06-05-my-topic-other-agent-1.md",
        "2026-06-05-my-topic-fy-general-reviewer-2.md",
      ]),
    );
    expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-my-topic-fy-general-reviewer-3.md");
  });

  it("skips non-matching files in the directory", () => {
    const path = buildFallbackReportPath(
      "2026-06-05",
      "my-topic",
      "fy-general-reviewer",
      mockFs(true, [
        "2026-06-05-my-topic-fy-general-reviewer-1.md",
        "some-other-file.md",
        "2026-06-04-my-topic-fy-general-reviewer-99.md",
        "2026-06-05-my-topic-known-issues.md",
      ]),
    );
    expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-my-topic-fy-general-reviewer-2.md");
  });

  it("handles topic and agentName with special characters", () => {
    const path = buildFallbackReportPath(
      "2026-06-05",
      "task-1-verification",
      "fy-task-verifier",
      mockFs(true, ["2026-06-05-task-1-verification-fy-task-verifier-1.md"]),
    );
    expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-task-1-verification-fy-task-verifier-2.md");
  });

  it("handles undefined agentName — omits agent suffix from filename", () => {
    const path = buildFallbackReportPath("2026-06-05", "my-topic", undefined, mockFs(false, null));
    expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-my-topic-1.md");
  });

  it("handles undefined agentName — matches existing files without agent suffix", () => {
    const path = buildFallbackReportPath(
      "2026-06-05",
      "my-topic",
      undefined,
      mockFs(true, ["2026-06-05-my-topic-1.md", "2026-06-05-my-topic-2.md"]),
    );
    expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-my-topic-3.md");
  });

  describe("sanitization of LLM-generated input", () => {
    it("strips path traversal from topic", () => {
      const path = buildFallbackReportPath("2026-06-05", "../../../etc/passwd", undefined, mockFs(false, null));
      expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-etc-passwd-1.md");
    });

    it("replaces path separators with hyphens", () => {
      const path = buildFallbackReportPath("2026-06-05", "some/path\\here", undefined, mockFs(false, null));
      expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-some-path-here-1.md");
    });

    it("strips special characters from agentName", () => {
      const path = buildFallbackReportPath(
        "2026-06-05",
        "review",
        "agent with spaces & special!chars",
        mockFs(false, null),
      );
      expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-review-agentwithspacesspecialchars-1.md");
    });

    it("falls back to 'review' when topic sanitizes to empty", () => {
      const path = buildFallbackReportPath("2026-06-05", "!!!", undefined, mockFs(false, null));
      expect(path).toBe(".featyard/reviews/2026-06-05/2026-06-05-review-1.md");
    });
  });

  describe("{{PI_FY_KNOWN_ISSUES_PATH}}", () => {
    it("replaces with per-feature known-issues path when slug is provided (no task)", () => {
      const result = substitutePlaceholders("Issues: {{PI_FY_KNOWN_ISSUES_PATH}}", { slug: "my-feature" });
      expect(result).toBe("Issues: .featyard/reviews/my-feature/my-feature-known-issues.md");
    });

    it("replaces with per-task known-issues path when taskName is provided", () => {
      const result = substitutePlaceholders("Issues: {{PI_FY_KNOWN_ISSUES_PATH}}", {
        slug: "my-feature",
        taskName: "3. Wire the login form",
      });
      expect(result).toBe("Issues: .featyard/reviews/my-feature/my-feature-task-3-wire-the-login-form-known-issues.md");
    });

    it("replaces with design known-issues path when phase is design", () => {
      const result = substitutePlaceholders("Issues: {{PI_FY_KNOWN_ISSUES_PATH}}", {
        slug: "my-feature",
        phase: "design",
      });
      expect(result).toBe("Issues: .featyard/reviews/my-feature/my-feature-design-known-issues.md");
    });

    it("replaces with plan known-issues path when phase is plan", () => {
      const result = substitutePlaceholders("Issues: {{PI_FY_KNOWN_ISSUES_PATH}}", {
        slug: "my-feature",
        phase: "plan",
      });
      expect(result).toBe("Issues: .featyard/reviews/my-feature/my-feature-plan-known-issues.md");
    });

    it("phase design takes priority over taskName (design/plan reviews have no tasks)", () => {
      const result = substitutePlaceholders("Issues: {{PI_FY_KNOWN_ISSUES_PATH}}", {
        slug: "my-feature",
        phase: "design",
        taskName: "3. Wire the login form",
      });
      expect(result).toBe("Issues: .featyard/reviews/my-feature/my-feature-design-known-issues.md");
    });

    it("replaces with date-based fallback path when slug is not provided", () => {
      const result = substitutePlaceholders("Issues: {{PI_FY_KNOWN_ISSUES_PATH}}", {});
      // Date-based fallback so a manual invocation without an active workflow still has a file.
      expect(result).toMatch(
        /^Issues: \.featyard\/reviews\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}-review-known-issues\.md$/,
      );
    });

    it("replaces with date-based fallback path when slug is empty string", () => {
      const result = substitutePlaceholders("Issues: {{PI_FY_KNOWN_ISSUES_PATH}}", { slug: "" });
      expect(result).toMatch(
        /^Issues: \.featyard\/reviews\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}-review-known-issues\.md$/,
      );
    });

    it("date fallback is phase-scoped (design/plan) and per-task when taskName is set", () => {
      expect(substitutePlaceholders("{{PI_FY_KNOWN_ISSUES_PATH}}", { phase: "design" })).toMatch(
        /\d{4}-\d{2}-\d{2}-design-known-issues\.md$/,
      );
      expect(substitutePlaceholders("{{PI_FY_KNOWN_ISSUES_PATH}}", { phase: "plan" })).toMatch(
        /\d{4}-\d{2}-\d{2}-plan-known-issues\.md$/,
      );
      expect(substitutePlaceholders("{{PI_FY_KNOWN_ISSUES_PATH}}", { taskName: "7. Final task" })).toMatch(
        /\d{4}-\d{2}-\d{2}-task-7-final-task-known-issues\.md$/,
      );
    });

    it("replaces multiple occurrences", () => {
      const result = substitutePlaceholders("See {{PI_FY_KNOWN_ISSUES_PATH}} and {{PI_FY_KNOWN_ISSUES_PATH}}", {
        slug: "test-feature",
      });
      expect(result).toBe(
        "See .featyard/reviews/test-feature/test-feature-known-issues.md and .featyard/reviews/test-feature/test-feature-known-issues.md",
      );
    });

    it("does not modify text without the placeholder", () => {
      const text = "No known issues path here.";
      expect(substitutePlaceholders(text, { slug: "my-feature" })).toBe(text);
    });
  });

  describe("{{PI_FY_CURRENT_TASK}}", () => {
    it("replaces with the task designation when provided", () => {
      const result = substitutePlaceholders("Task: {{PI_FY_CURRENT_TASK}}", { taskName: "3. Wire the login form" });
      expect(result).toBe("Task: 3. Wire the login form");
    });

    it("replaces with not available when taskName is not provided", () => {
      const result = substitutePlaceholders("Task: {{PI_FY_CURRENT_TASK}}", {});
      expect(result).toBe("Task: (not available)");
    });

    it("replaces with not available when taskName is undefined", () => {
      const result = substitutePlaceholders("Task: {{PI_FY_CURRENT_TASK}}", { taskName: undefined });
      expect(result).toBe("Task: (not available)");
    });

    it("does not modify text without the placeholder", () => {
      const text = "No task number here.";
      expect(substitutePlaceholders(text, { taskName: "5. Add validator" })).toBe(text);
    });
  });

  describe("{{PI_FY_BASE_COMMIT_SHA}}", () => {
    it("resolves from baseCommitSha option", () => {
      const result = substitutePlaceholders("Base: {{PI_FY_BASE_COMMIT_SHA}}", {
        baseCommitSha: "abc123def456",
      });
      expect(result).toBe("Base: abc123def456");
    });

    it("resolves to (not available) when not provided", () => {
      const result = substitutePlaceholders("Base: {{PI_FY_BASE_COMMIT_SHA}}", {});
      expect(result).toBe("Base: (not available)");
    });

    it("resolves to (not available) when baseCommitSha is undefined", () => {
      const result = substitutePlaceholders("Base: {{PI_FY_BASE_COMMIT_SHA}}", { baseCommitSha: undefined });
      expect(result).toBe("Base: (not available)");
    });

    it("does not modify text without the placeholder", () => {
      const text = "No base commit here.";
      expect(substitutePlaceholders(text, { baseCommitSha: "abc123" })).toBe(text);
    });
  });
});

describe("substitutePlaceholders unresolved placeholder warning", () => {
  beforeEach(() => {
    resetSettingsState();
  });

  afterEach(() => {
    resetSettingsState();
  });

  it("returns text unchanged when unknown PI_FY_ placeholder remains after substitution", () => {
    const text = "Some text {{PI_FY_UNKNOWN_FUTURE}} more text";
    const result = substitutePlaceholders(text, {});
    // Unknown placeholder should remain in output
    expect(result).toContain("{{PI_FY_UNKNOWN_FUTURE}}");
  });

  it("resolves all known placeholders without leaving any PI_FY_ markers", () => {
    setSetting("researcherMinInstances", 2);
    setSetting("researcherMaxInstances", 5);
    const text = "{{PI_FY_FEATURE_SLUG}} {{PI_FY_RESEARCHER_MIN}} {{PI_FY_RESEARCHER_MAX}}";
    const result = substitutePlaceholders(text, {});
    expect(result).not.toContain("{{PI_FY_");
  });
});

describe("PI_FY_REVIEW_METHOD placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });
  afterEach(() => {
    resetSettingsState();
  });

  it("resolves to design review method when phase is design", () => {
    const result = substitutePlaceholders("Method: {{PI_FY_REVIEW_METHOD}}", {
      slug: "2026-06-23-my-feat",
      phase: "design",
      loopIndex: 0,
    });
    expect(result).not.toContain("{{PI_FY_");
    // default planReviewMode is parallel-subagents → design dispatch with a
    // distinguishing phrase unique to the design method (not the plan method)
    expect(result).toContain("design mistakes");
  });

  it("resolves to plan review method when phase is plan", () => {
    const result = substitutePlaceholders("Method: {{PI_FY_REVIEW_METHOD}}", {
      slug: "2026-06-23-my-feat",
      phase: "plan",
      loopIndex: 1,
    });
    expect(result).not.toContain("{{PI_FY_");
    // distinguishing phrase unique to the plan method (not the design method)
    expect(result).toContain("implementation plan");
  });

  it("resolves to empty when no review phase", () => {
    const result = substitutePlaceholders("Method: {{PI_FY_REVIEW_METHOD}}", { phase: "implement" });
    expect(result).toBe("Method: ");
  });

  it("resolves to inline instruction (not dispatch) when planReviewMode is in-session", () => {
    // : cover the non-parallel branch through the handler wiring. Default
    // planReviewMode is parallel-subagents (dispatch branch); in-session produces
    // an inline instruction with no "Dispatch reviewer:" preamble.
    setSetting("planReviewMode", "in-session");
    const result = substitutePlaceholders("Method: {{PI_FY_REVIEW_METHOD}}", {
      slug: "2026-06-23-my-feat",
      phase: "design",
      loopIndex: 0,
    });
    expect(result).not.toContain("{{PI_FY_");
    expect(result).not.toContain("Dispatch reviewer:");
    expect(result).toContain("Read the full assembled design document");
  });
});

describe("PI_FY_REVIEW_LOOP_NUMBER placeholder", () => {
  beforeEach(() => {
    resetSettingsState();
  });
  afterEach(() => {
    resetSettingsState();
  });

  it("resolves to the display loop number for design/plan phases", () => {
    // loopIndex is the raw "iterations started" count (2); display number = count - 1 = 1
    const design = substitutePlaceholders("{{PI_FY_REVIEW_LOOP_NUMBER}}", {
      slug: "2026-06-23-my-feat",
      phase: "design",
      loopIndex: 2,
    });
    expect(design).toBe("1");
    // loopIndex 1 (first iteration started) → display #0
    const plan = substitutePlaceholders("{{PI_FY_REVIEW_LOOP_NUMBER}}", {
      slug: "2026-06-23-my-feat",
      phase: "plan",
      loopIndex: 1,
    });
    expect(plan).toBe("0");
  });

  it("resolves to empty when not in a review phase", () => {
    const implement = substitutePlaceholders("{{PI_FY_REVIEW_LOOP_NUMBER}}", {
      slug: "x",
      phase: "implement",
      loopIndex: 2,
    });
    expect(implement).toBe("");
  });

  it("defaults to display loop #0 when loopIndex is omitted", () => {
    // Exercises the `ctx.opts.loopIndex ?? 1` fallback — omitting loopIndex
    // resolves to raw 1, whose display number is 0.
    const result = substitutePlaceholders("{{PI_FY_REVIEW_LOOP_NUMBER}}", {
      slug: "2026-06-23-my-feat",
      phase: "design",
    });
    expect(result).toBe("0");
  });
});

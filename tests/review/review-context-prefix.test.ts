// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import fs from "node:fs";
import { describe, expect, test } from "vitest";

// NOTE: buildReviewLoopContext and computeReviewMethod are now consumed by the
// main substitution pipeline (template-substitution.ts PLACEHOLDER_HANDLERS) which
// resolves {{PI_FY_REVIEW_LOOP_CONTEXT}}, {{PI_FY_REVIEW_METHOD}}, and
// {{PI_FY_DESIGN_DOC_PATH}}/{{PI_FY_PLAN_DOC_PATH}}. They are exercised via integration in
// phase-ready-review-loop.test.ts / brainstorm-plan-context-injection.test.ts which
// verify the followUp message content produced by the phase_ready handler.
//
// The skill files contain the three REVIEW_* placeholders that are resolved by the
// pipeline before the followUp is sent (works for both extension-driven loops and
// manual /skill:fy-design-review|plan-review invocation).
//
// This file verifies the helper skill files exist on disk, which is a prerequisite
// for expandSkillCommand used by computeReviewMethod in in-session mode.

describe("review context helper prerequisites", () => {
  test("design-review skill file exists (required by computeReviewMethod)", () => {
    expect(fs.existsSync("skills/fy-design-review/SKILL.md")).toBe(true);
  });

  test("plan-review skill file exists (required by computeReviewMethod)", () => {
    expect(fs.existsSync("skills/fy-plan-review/SKILL.md")).toBe(true);
  });
});

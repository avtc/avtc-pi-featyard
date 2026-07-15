// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";

/**
 * Tests for buildCompactFraming and buildCompactSkillBlock.
 *
 * The compact-handler (compaction.ts) assembles ONE message from:
 *   [skill block] + [framing line] + [caller note] + [✅] + [In progress item]
 *
 * buildCompactSkillBlock expands the `/skill:` reference through expandSkillCommand
 * (resolving all {{PI_FY_*}} placeholders). buildCompactFraming emits the single
 * compaction framing line (review-specific for iteration skills, phase-specific
 * otherwise, generic when there is no skill).
 */
describe("buildCompactFraming", () => {
  it("uses the review-specific suffix for design-review", async () => {
    const { buildCompactFraming } = await import("../../src/compaction/compact-message.js");
    expect(buildCompactFraming("fy-design-review", "design")).toBe(
      "Context was compacted. Reminder of planned work: continue the review from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive.",
    );
  });

  it("uses the review-specific suffix for plan-review", async () => {
    const { buildCompactFraming } = await import("../../src/compaction/compact-message.js");
    expect(buildCompactFraming("fy-plan-review", "plan")).toBe(
      "Context was compacted. Reminder of planned work: continue the review from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive.",
    );
  });

  it("uses the phase suffix for a phase skill", async () => {
    const { buildCompactFraming } = await import("../../src/compaction/compact-message.js");
    expect(buildCompactFraming("fy-implement", "implement")).toBe(
      "Context was compacted. Reminder of planned work: you are in implement phase; continue from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive.",
    );
  });

  it("uses the phase suffix when there is no skill but a phase is present", async () => {
    const { buildCompactFraming } = await import("../../src/compaction/compact-message.js");
    expect(buildCompactFraming(null, "uat")).toBe(
      "Context was compacted. Reminder of planned work: you are in uat phase; continue from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive.",
    );
  });

  it("falls back to the generic suffix when there is no skill and no phase", async () => {
    const { buildCompactFraming } = await import("../../src/compaction/compact-message.js");
    expect(buildCompactFraming(undefined, undefined)).toBe(
      "Context was compacted. Reminder of planned work: continue from where you left off. Honor the user's most recent instruction first; this is a reminder, not a new directive.",
    );
  });
});

describe("buildCompactSkillBlock", () => {
  it("expands the skill reference through expandSkillCommand", async () => {
    const { buildCompactSkillBlock } = await import("../../src/compaction/compact-message.js");
    const expand = (text: string) => `[EXPANDED] ${text}`;
    expect(buildCompactSkillBlock("fy-implement", expand)).toBe("[EXPANDED] /skill:fy-implement");
  });

  it("returns empty string when there is no skill", async () => {
    const { buildCompactSkillBlock } = await import("../../src/compaction/compact-message.js");
    const expand = (text: string) => text;
    expect(buildCompactSkillBlock(null, expand)).toBe("");
    expect(buildCompactSkillBlock(undefined, expand)).toBe("");
  });
});

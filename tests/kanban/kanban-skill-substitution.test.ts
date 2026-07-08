// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandSkillCommand } from "../../src/prompts/skill-block-builder.js";
import { substitutePlaceholders } from "../../src/prompts/template-engine.js";
import { setTestSettings } from "../helpers/settings-test-helpers.js";

beforeEach(() => {
  // The design-doc path is mode-dependent (committed → docs/ff/designs, local → .ff/designs);
  // these assertions exercise the committed path.
  setTestSettings({ designDocStorage: "committed" });
});

afterEach(() => {});

describe("kanban skill substitution integration", () => {
  it("expandSkillCommand with substituteFn replaces design doc path placeholder", () => {
    const slug = "2026-05-22-my-feature";
    const substituteFn = (text: string) => substitutePlaceholders(text, { slug });
    const result = expandSkillCommand("/skill:ff-design Work on feature: test", substituteFn);
    // The expanded skill should have the exact path substituted
    expect(result).toContain("docs/ff/designs/2026-05-22-my-feature-design.md");
    expect(result).not.toContain("{{PI_FF_DESIGN_DOC_PATH}}");
  });

  it("expandSkillCommand with substituteFn replaces plan doc path placeholder", () => {
    const slug = "2026-05-22-my-feature";
    const substituteFn = (text: string) => substitutePlaceholders(text, { slug });
    const result = expandSkillCommand("/skill:ff-plan Work on feature: test", substituteFn);
    // The expanded skill should have the exact path substituted
    expect(result).toContain(".ff/task-plans/2026-05-22-my-feature-task-plan.md");
    expect(result).not.toContain("{{PI_FF_PLAN_DOC_PATH}}");
  });

  // Note: This test depends on Tasks 2 and 3 being completed first (the placeholder
  // must exist in the skill template). If running out of order, skip this test.
  it("expandSkillCommand without substituteFn leaves placeholders unsubstituted", () => {
    const result = expandSkillCommand("/skill:ff-design Work on feature: test", null);
    // Without substituteFn, the placeholder should remain in the skill body
    // (the skill template still contains the raw placeholder)
    expect(result).toContain("{{PI_FF_DESIGN_DOC_PATH}}");
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { substitutePlaceholders } from "../../src/prompts/template-engine.js";
import { resetSettingsState, setSetting } from "../helpers/settings-test-helpers.js";

describe("PI_FY_FEATURE_SLUG placeholder", () => {
  beforeEach(resetSettingsState);
  afterEach(resetSettingsState);

  it("replaces with slug when provided", () => {
    const result = substitutePlaceholders("Path: {{PI_FY_FEATURE_SLUG}}", {
      slug: "2026-05-29-researcher-subagent",
    });
    expect(result).toBe("Path: 2026-05-29-researcher-subagent");
    expect(result).not.toContain("{{PI_FY_FEATURE_SLUG}}");
  });

  it("falls back to template hint when no slug provided", () => {
    const result = substitutePlaceholders("Path: {{PI_FY_FEATURE_SLUG}}", {});
    expect(result).toContain("YYYY-MM-DD-<topic>");
    expect(result).not.toContain("{{PI_FY_FEATURE_SLUG}}");
  });

  it("leaves text unchanged when placeholder not present", () => {
    const text = "No slug placeholder here.";
    expect(substitutePlaceholders(text, {})).toBe(text);
  });
});

describe("PI_FY_RESEARCHER_MIN placeholder", () => {
  beforeEach(resetSettingsState);
  afterEach(resetSettingsState);

  it("replaces with the numeric value of researcherMinInstances", () => {
    setSetting("researcherMinInstances", 3);
    const result = substitutePlaceholders("Spawn {{PI_FY_RESEARCHER_MIN}} researchers", {});
    expect(result).toBe("Spawn 3 researchers");
    expect(result).not.toContain("{{PI_FY_RESEARCHER_MIN}}");
  });

  it("replaces with 0 when researcherMinInstances is 0", () => {
    setSetting("researcherMinInstances", 0);
    const result = substitutePlaceholders("Min: {{PI_FY_RESEARCHER_MIN}}", {});
    expect(result).toBe("Min: 0");
  });

  it("replaces with default value (1) when setting not changed", () => {
    const result = substitutePlaceholders("Min: {{PI_FY_RESEARCHER_MIN}}", {});
    expect(result).toBe("Min: 1");
    expect(result).not.toContain("{{PI_FY_RESEARCHER_MIN}}");
  });
});

describe("PI_FY_RESEARCHER_MAX placeholder", () => {
  beforeEach(resetSettingsState);
  afterEach(resetSettingsState);

  it("replaces with the numeric value of researcherMaxInstances", () => {
    setSetting("researcherMaxInstances", 5);
    const result = substitutePlaceholders("Spawn {{PI_FY_RESEARCHER_MAX}} researchers", {});
    expect(result).toBe("Spawn 5 researchers");
    expect(result).not.toContain("{{PI_FY_RESEARCHER_MAX}}");
  });

  it("replaces with default value (3) when setting not changed", () => {
    const result = substitutePlaceholders("Max: {{PI_FY_RESEARCHER_MAX}}", {});
    expect(result).toBe("Max: 3");
    expect(result).not.toContain("{{PI_FY_RESEARCHER_MAX}}");
  });

  // NOTE: a test that set researcherMaxInstances=0 and expected the min:1 gate to reject it
  // (falling back to default 3) was removed — that exercises the settings-ui gate (min enforcement),
  // which is settings-ui's responsibility, not featyard's. The substitution logic itself is
  // covered by the cases above (explicit value + unchanged default).
});

describe("all researcher placeholders together", () => {
  beforeEach(resetSettingsState);
  afterEach(resetSettingsState);

  it("replaces all three placeholders in same text", () => {
    setSetting("researcherMinInstances", 1);
    setSetting("researcherMaxInstances", 5);
    const result = substitutePlaceholders(
      "docs/research/{{PI_FY_FEATURE_SLUG}}/{{PI_FY_FEATURE_SLUG}}-design-initial-agent-1.md (min={{PI_FY_RESEARCHER_MIN}}, max={{PI_FY_RESEARCHER_MAX}})",
      { slug: "my-feature" },
    );
    expect(result).not.toContain("{{PI_FY_");
    expect(result).toContain("my-feature");
    expect(result).toContain("min=1");
    expect(result).toContain("max=5");
  });
});

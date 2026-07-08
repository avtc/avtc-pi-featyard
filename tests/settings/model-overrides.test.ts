// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { _resetModelResolution, resolveModelOverride, resolveReviewSkill } from "../../src/settings/model-overrides.js";

// Smoke tests for resolveModelOverride at coarse granularity (bare object literals).
// Comprehensive edge-case coverage (empty-array override, negative loopIndex wrap,
// single-element arrays, round-robin rotation) lives in the sibling file
// tests/extension/settings/resolve-model-override.test.ts — these tests are
// intentionally not duplicated here to keep both files focused.
describe("resolveModelOverride", () => {
  it("returns null when no overrides configured", () => {
    _resetModelResolution();
    const result = resolveModelOverride("review", 0, { "default-model": null });
    expect(result).toBeNull();
  });
  it("returns default-model when configured", () => {
    const result = resolveModelOverride(null, 0, { "default-model": "openai/gpt-4" });
    expect(result).toBe("openai/gpt-4");
  });
  it("resolves stage model over default", () => {
    const result = resolveModelOverride("review", 0, {
      "default-model": "openai/gpt-4",
      "stage-models": { review: "anthropic/claude" },
    });
    expect(result).toBe("anthropic/claude");
  });
});

describe("resolveReviewSkill", () => {
  it("returns null when maxFeatureReviewRounds is 0 (disabled)", () => {
    expect(resolveReviewSkill({ maxFeatureReviewRounds: 0 })).toBeNull();
  });
  it("returns ff-review when enabled", () => {
    expect(resolveReviewSkill({ maxFeatureReviewRounds: 3 })).toBe("ff-review");
  });
});

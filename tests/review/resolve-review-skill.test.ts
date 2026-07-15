// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { resolveReviewSkill } from "../../src/settings/settings-ui.js";

describe("resolveReviewSkill", () => {
  test("returns null when maxFeatureReviewRounds is 0 (disabled)", () => {
    expect(resolveReviewSkill({ maxFeatureReviewRounds: 0 })).toBeNull();
  });

  test("returns fy-review when loops enabled with numeric value", () => {
    expect(resolveReviewSkill({ maxFeatureReviewRounds: 3 })).toBe("fy-review");
  });

  test("returns fy-review when loops enabled with value 1", () => {
    expect(resolveReviewSkill({ maxFeatureReviewRounds: 1 })).toBe("fy-review");
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { SKILL_TO_PHASE } from "../../src/phases/phase-progression.js";

describe("review skill phase mapping", () => {
  it("maps ff-review to review phase", () => {
    expect(SKILL_TO_PHASE["ff-review"]).toBe("review");
  });

  it("does not map removed skills", () => {
    expect(SKILL_TO_PHASE["requesting-code-review"]).toBeUndefined();
    expect(SKILL_TO_PHASE["general-review"]).toBeUndefined();
  });
});

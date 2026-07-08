// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { isLane, LANE_ORDER } from "../../src/kanban/data/kanban-types.js";

describe("isLane type guard", () => {
  test.each(LANE_ORDER)("returns true for valid lane '%s'", (lane) => {
    expect(isLane(lane)).toBe(true);
  });

  test.each([
    "unknown",
    "in-progress ",
    " IN-PROGRESS",
    "done\n",
    "",
  ])("returns false for invalid string '%s'", (value) => {
    expect(isLane(value)).toBe(false);
  });
});

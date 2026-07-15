// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Unit tests for `clampFeatyardSettings` — featyard's `clampFn` (the only featyard-OWNED
 * settings logic). The cross-field constraint keeps `researcherMinInstances <= researcherMaxInstances`.
 *
 * Tests call the function directly on a plain object — no settings-ui symbols, no handle, no files.
 * Everything else (defaults, gate, load, format, alias-stripping, schema integrity) is settings-ui's
 * responsibility and is not tested here.
 */

import { describe, expect, test } from "vitest";
import { clampFeatyardSettings } from "../../src/settings/settings-schema.js";

/** Build a settings object with the two researcher fields (clamp only touches those). */
function withInstances(min: number, max: number): Record<string, unknown> {
  return { researcherMinInstances: min, researcherMaxInstances: max };
}

describe("clampFeatyardSettings", () => {
  test("clamps researcherMinInstances down to researcherMaxInstances when min > max", () => {
    const settings = withInstances(5, 3);
    clampFeatyardSettings(settings);
    expect(settings.researcherMinInstances).toBe(3);
    expect(settings.researcherMaxInstances).toBe(3);
  });

  test("leaves valid ranges untouched (min < max)", () => {
    const settings = withInstances(1, 5);
    clampFeatyardSettings(settings);
    expect(settings.researcherMinInstances).toBe(1);
    expect(settings.researcherMaxInstances).toBe(5);
  });

  test("leaves equal min == max untouched", () => {
    const settings = withInstances(3, 3);
    clampFeatyardSettings(settings);
    expect(settings.researcherMinInstances).toBe(3);
    expect(settings.researcherMaxInstances).toBe(3);
  });

  test("does not raise researcherMaxInstances (only clamps min down)", () => {
    // min is already below max; max stays as-is.
    const settings = withInstances(0, 1);
    clampFeatyardSettings(settings);
    expect(settings.researcherMinInstances).toBe(0);
    expect(settings.researcherMaxInstances).toBe(1);
  });

  test("is a no-op when researcher fields are missing/non-numeric", () => {
    const settings: Record<string, unknown> = {};
    expect(() => clampFeatyardSettings(settings)).not.toThrow();
    expect(settings.researcherMinInstances).toBeUndefined();
    expect(settings.researcherMaxInstances).toBeUndefined();
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Unit tests for `clampFeatureFlowSettings` — feature-flow's `clampFn` (the only feature-flow-OWNED
 * settings logic). The cross-field constraint keeps `researcherMinInstances <= researcherMaxInstances`.
 *
 * Tests call the function directly on a plain object — no settings-ui symbols, no handle, no files.
 * Everything else (defaults, gate, load, format, alias-stripping, schema integrity) is settings-ui's
 * responsibility and is not tested here.
 */

import { describe, expect, test } from "vitest";
import { clampFeatureFlowSettings } from "../../src/settings/settings-schema.js";

/** Build a settings object with the two researcher fields (clamp only touches those). */
function withInstances(min: number, max: number): Record<string, unknown> {
  return { researcherMinInstances: min, researcherMaxInstances: max };
}

describe("clampFeatureFlowSettings", () => {
  test("clamps researcherMinInstances down to researcherMaxInstances when min > max", () => {
    const settings = withInstances(5, 3);
    clampFeatureFlowSettings(settings);
    expect(settings.researcherMinInstances).toBe(3);
    expect(settings.researcherMaxInstances).toBe(3);
  });

  test("leaves valid ranges untouched (min < max)", () => {
    const settings = withInstances(1, 5);
    clampFeatureFlowSettings(settings);
    expect(settings.researcherMinInstances).toBe(1);
    expect(settings.researcherMaxInstances).toBe(5);
  });

  test("leaves equal min == max untouched", () => {
    const settings = withInstances(3, 3);
    clampFeatureFlowSettings(settings);
    expect(settings.researcherMinInstances).toBe(3);
    expect(settings.researcherMaxInstances).toBe(3);
  });

  test("does not raise researcherMaxInstances (only clamps min down)", () => {
    // min is already below max; max stays as-is.
    const settings = withInstances(0, 1);
    clampFeatureFlowSettings(settings);
    expect(settings.researcherMinInstances).toBe(0);
    expect(settings.researcherMaxInstances).toBe(1);
  });

  test("is a no-op when researcher fields are missing/non-numeric", () => {
    const settings: Record<string, unknown> = {};
    expect(() => clampFeatureFlowSettings(settings)).not.toThrow();
    expect(settings.researcherMinInstances).toBeUndefined();
    expect(settings.researcherMaxInstances).toBeUndefined();
  });
});

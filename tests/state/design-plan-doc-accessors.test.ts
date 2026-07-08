// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import type { FeatureState } from "../../src/state/feature-state.js";
import { getDesignDoc } from "../../src/state/feature-state.js";

/**
 * Tests for getDesignDoc artifact accessor — resolves the design doc path from
 * a FeatureState's design.doc field.
 */

function stateWithDesign(design: string | null): FeatureState {
  return { design: { doc: design } } as unknown as FeatureState;
}

describe("getDesignDoc", () => {
  test("returns the design artifact path when present", () => {
    expect(getDesignDoc(stateWithDesign("docs/design.md"))).toBe("docs/design.md");
  });

  test("returns null when no design artifact is set", () => {
    expect(getDesignDoc(stateWithDesign(null))).toBeNull();
  });
});

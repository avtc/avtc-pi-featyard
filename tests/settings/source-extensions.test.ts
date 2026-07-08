// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * source-extensions lives in the feature-flow section of ~/.pi/agent/settings.json,
 * read via the feature-flow config loader and validated by validateSourceExtensions.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { buildExtensionOverride } from "../../src/guardrails/file-classifier.js";
import {
  loadFeatureFlowConfig,
  resetFeatureFlowConfig,
  setFeatureFlowConfig,
} from "../../src/settings/model-overrides.js";

/** No global directory override */
const NO_GLOBAL_DIR: string | null = null;

/** No cwd override */
const NO_CWD: string | null = null;

describe("source-extensions config (feature-flow section)", () => {
  beforeEach(() => {
    resetFeatureFlowConfig();
  });

  test("defaults to null when not configured", () => {
    const config = loadFeatureFlowConfig(NO_GLOBAL_DIR, NO_CWD);
    expect(config["source-extensions"]).toBeNull();
  });

  test("setFeatureFlowConfig round-trips a valid array", () => {
    setFeatureFlowConfig({
      "stage-models": {},
      "default-model": null,
      "kanban-port": null,
      "source-extensions": [".ts", ".py"],
    });
    expect(loadFeatureFlowConfig(NO_GLOBAL_DIR, NO_CWD)["source-extensions"]).toEqual([".ts", ".py"]);
  });

  test("modify-defaults entries (+/-) are preserved", () => {
    setFeatureFlowConfig({
      "stage-models": {},
      "default-model": null,
      "kanban-port": null,
      "source-extensions": ["+.dart", "-.v"],
    });
    expect(loadFeatureFlowConfig(NO_GLOBAL_DIR, NO_CWD)["source-extensions"]).toEqual(["+.dart", "-.v"]);
  });

  test("the entry array feeds buildExtensionOverride (replace mode)", () => {
    const result = buildExtensionOverride([".ts", ".py"]);
    expect(result.kind).toBe("custom");
    if (result.kind !== "custom") return;
    expect(result.pattern.test("foo.ts")).toBe(true);
    expect(result.pattern.test("foo.py")).toBe(true);
    expect(result.pattern.test("foo.css")).toBe(false);
  });
});

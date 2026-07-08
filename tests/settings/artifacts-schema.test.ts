// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Schema-integrity tests for the new Artifacts-tab settings:
 * `designDocStorage` + `autoArchiveDesignsOlderThanDays`, and the relocation of
 * `autoArchiveArtifactsOlderThanDays` into a dedicated "Artifacts" tab.
 *
 * Defaults/normalization/gate behavior are settings-ui's responsibility (see the
 * clamp-feature-flow-settings test header); here we assert feature-flow's OWN schema shape —
 * the setting definitions and tab grouping — since that is what feature-flow authors.
 */

import { describe, expect, test } from "vitest";
import { FEATURE_FLOW_SCHEMA } from "../../src/settings/settings-schema.js";

const byId = (id: string) => FEATURE_FLOW_SCHEMA.settings.find((s) => s.id === id);

describe("FEATURE_FLOW_SCHEMA — Artifacts settings", () => {
  test("designDocStorage is a string setting defaulting to 'local' with local/committed presets", () => {
    const s = byId("designDocStorage");
    expect(s).toBeDefined();
    expect(s?.type).toBe("string");
    expect(s?.defaultValue).toBe("local");
    expect(s?.presets).toEqual(["local", "committed"]);
  });

  test("autoArchiveDesignsOlderThanDays is a nullable number defaulting to null (disabled) with a Never preset", () => {
    const s = byId("autoArchiveDesignsOlderThanDays");
    expect(s).toBeDefined();
    expect(s?.type).toBe("number");
    expect(s?.defaultValue).toBeNull();
    expect(s?.min).toBe(1);
    const presets = s?.presets as ReadonlyArray<readonly [string, unknown] | unknown>;
    const hasNeverNull = presets.some((p) => Array.isArray(p) && p[0] === "Never" && p[1] === null);
    expect(hasNeverNull).toBe(true);
  });

  test("autoArchiveArtifactsOlderThanDays still exists with its original default (30)", () => {
    const s = byId("autoArchiveArtifactsOlderThanDays");
    expect(s).toBeDefined();
    expect(s?.type).toBe("number");
    expect(s?.defaultValue).toBe(30);
  });
});

describe("FEATURE_FLOW_SCHEMA — Artifacts tab grouping", () => {
  const tab = (label: string) => FEATURE_FLOW_SCHEMA.tabs.find((t) => t.label === label);

  test("has an 'Artifacts' tab", () => {
    expect(tab("Artifacts")).toBeDefined();
  });

  test("the Artifacts tab groups designDocStorage + both archive settings, in that order", () => {
    expect(tab("Artifacts")?.settingIds).toEqual([
      "designDocStorage",
      "autoArchiveArtifactsOlderThanDays",
      "autoArchiveDesignsOlderThanDays",
    ]);
  });

  test("autoArchiveArtifactsOlderThanDays is no longer in the Workflow tab", () => {
    expect(tab("Workflow")?.settingIds).not.toContain("autoArchiveArtifactsOlderThanDays");
  });

  test("every tab setting id references a defined setting (no dangling refs)", () => {
    const ids = new Set(FEATURE_FLOW_SCHEMA.settings.map((s) => s.id));
    for (const tab of FEATURE_FLOW_SCHEMA.tabs) {
      for (const id of tab.settingIds) {
        expect(ids.has(id), `tab '${tab.label}' references unknown setting '${id}'`).toBe(true);
      }
    }
  });

  test("every setting appears in exactly one tab (no orphans, no duplicates)", () => {
    const referenced: string[] = [];
    for (const tab of FEATURE_FLOW_SCHEMA.tabs) referenced.push(...tab.settingIds);
    const defined = FEATURE_FLOW_SCHEMA.settings.map((s) => s.id);
    expect(referenced.sort()).toEqual([...defined].sort());
    expect(new Set(referenced).size).toBe(referenced.length);
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { getSettings, updateSetting } from "../../src/settings/settings-ui.js";
import { defaultSettings, resetSettingsState, setTestSettings } from "../helpers/settings-test-helpers.js";

describe("mock-DI write override (production updateSetting)", () => {
  afterEach(() => resetSettingsState());

  test("when the mock override is active, production updateSetting writes to the mock holder (visible via getSettings) and does not throw", () => {
    setTestSettings(null);
    expect(getSettings().baseBranch).toBeNull();

    // Production code (e.g. resolve-base-branch persisting baseBranch) calls updateSetting.
    // No real handle has been activated — this must not throw, and the write must be readable.
    expect(() => updateSetting("baseBranch", "develop", null)).not.toThrow();

    expect(getSettings().baseBranch).toBe("develop");
  });

  test("updateSetting with level:project writes to the mock holder (level is immaterial for the mock)", () => {
    setTestSettings(null);
    updateSetting("baseBranch", "feature/x", { level: "project" });
    expect(getSettings().baseBranch).toBe("feature/x");
  });

  test("setTestSettings overrides + a production updateSetting coexist on the same holder", () => {
    setTestSettings({ uatMode: "off" });
    expect(getSettings().uatMode).toBe("off");

    updateSetting("uatMode", "after-review", null);
    expect(getSettings().uatMode).toBe("after-review");
    // Other seeded overrides persist (single holder, not reset by updateSetting).
    expect(getSettings().baseBranch).toBe(defaultSettings({ uatMode: "off" }).baseBranch);
  });
});

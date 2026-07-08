// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for the phase-driven PI_SUBAGENT_FORK_MODE sync.
 *
 * Fork mode is owned by the ROOT session and derived from the active phase +
 * settings (design/plan → planReviewSubagentsMode, review →
 * featureReviewSubagentsMode, else → "new"). It must NOT propagate deeper than the
 * 1st level of spawned subagents — enforced by the root-only guard here
 * combined with EXCLUDED_FROM_CASCADE in pi-subagent's env inheritance.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSettings,
  resolveForkModeForPhase,
  syncForkModeEnv,
  updateSetting,
} from "../../src/settings/settings-ui.js";
import { resetSettingsState, setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";

describe("resolveForkModeForPhase (pure phase→mode mapping)", () => {
  it("design/plan → planReviewSubagentsMode", () => {
    const s = getSettings();
    expect(resolveForkModeForPhase("design", s)).toBe(s.planReviewSubagentsMode);
    expect(resolveForkModeForPhase("plan", s)).toBe(s.planReviewSubagentsMode);
  });

  it("review → featureReviewSubagentsMode", () => {
    const s = getSettings();
    expect(resolveForkModeForPhase("review", s)).toBe(s.featureReviewSubagentsMode);
  });

  it("implement/verify/uat/finish → 'new' (fresh, no fork)", () => {
    for (const phase of ["implement", "verify", "uat", "finish"]) {
      expect(resolveForkModeForPhase(phase, getSettings())).toBe("new");
    }
  });

  it("no active phase (undefined) → 'new'", () => {
    expect(resolveForkModeForPhase(undefined, getSettings())).toBe("new");
  });

  it("reflects a settings change: design→planReviewSubagentsMode follows updateSetting", () => {
    setSetting("planReviewSubagentsMode", "new");
    expect(resolveForkModeForPhase("design", getSettings())).toBe("new");
    setSetting("planReviewSubagentsMode", "new+fork");
    expect(resolveForkModeForPhase("design", getSettings())).toBe("new+fork");
  });
});

describe("syncForkModeEnv (root-only, phase + settings driven)", () => {
  beforeEach(() => {
    setTestSettings(null);
    resetSettingsState();
    delete process.env.PI_SUBAGENT_FORK_MODE;
    delete process.env.PI_SUBAGENT_PARENT_PID;
    delete process.env.PI_FF_STAGE;
  });
  afterEach(() => {
    delete process.env.PI_SUBAGENT_FORK_MODE;
    delete process.env.PI_SUBAGENT_PARENT_PID;
    delete process.env.PI_FF_STAGE;
    resetSettingsState();
  });

  it("sets PI_SUBAGENT_FORK_MODE from planReviewSubagentsMode when stage is plan", () => {
    process.env.PI_FF_STAGE = "plan";
    syncForkModeEnv();
    expect(process.env.PI_SUBAGENT_FORK_MODE).toBe(getSettings().planReviewSubagentsMode);
  });

  it("sets PI_SUBAGENT_FORK_MODE from featureReviewSubagentsMode when stage is review", () => {
    process.env.PI_FF_STAGE = "review";
    syncForkModeEnv();
    expect(process.env.PI_SUBAGENT_FORK_MODE).toBe(getSettings().featureReviewSubagentsMode);
  });

  it("hardcodes 'new' for implement/verify/uat/finish", () => {
    for (const phase of ["implement", "verify", "uat", "finish"]) {
      process.env.PI_FF_STAGE = phase;
      syncForkModeEnv();
      expect(process.env.PI_SUBAGENT_FORK_MODE).toBe("new");
    }
  });

  it("hardcodes 'new' when no stage is set", () => {
    syncForkModeEnv();
    expect(process.env.PI_SUBAGENT_FORK_MODE).toBe("new");
  });

  it("updateSetting re-derives fork mode for the active phase (mid-turn settings-ui edit)", () => {
    process.env.PI_FF_STAGE = "plan";
    // Use production updateSetting (not setSetting) — this test verifies the syncForkModeEnv side
    // effect that updateSetting triggers after a settings-ui edit.
    updateSetting("planReviewSubagentsMode", "new+fork", null);
    // updateSetting calls syncForkModeEnv internally → env reflects the new value.
    expect(process.env.PI_SUBAGENT_FORK_MODE).toBe("new+fork");
    updateSetting("planReviewSubagentsMode", "new", null);
    expect(process.env.PI_SUBAGENT_FORK_MODE).toBe("new");
  });

  it("is a no-op (does NOT set fork mode) inside a subagent session — enforces 'no deeper than 1st level'", () => {
    process.env.PI_SUBAGENT_PARENT_PID = "99999"; // this is a subagent
    process.env.PI_FF_STAGE = "plan";
    process.env.PI_SUBAGENT_FORK_MODE = "pre-existing-or-undefined";
    syncForkModeEnv();
    // A subagent must never (re-)arm fork mode on its own env, regardless of phase.
    expect(process.env.PI_SUBAGENT_FORK_MODE).toBe("pre-existing-or-undefined");
  });
});

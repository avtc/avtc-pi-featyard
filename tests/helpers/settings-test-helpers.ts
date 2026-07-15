// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { settingsFilePaths } from "avtc-pi-settings-ui";
import { resetFeatyardConfig } from "../../src/settings/model-overrides.js";
import { FEATYARD_SCHEMA } from "../../src/settings/settings-schema.js";
import type { FeatyardSettings } from "../../src/settings/settings-types.js";
import { _setGetSettings, _setUpdateSettingsOverride } from "../../src/settings/settings-ui.js";

/** The current mutable test-settings holder — always present (seeded with schema defaults at
 *  module load, like todo's `_currentSettings`). setTestSettings replaces it; setSetting mutates it. */
let _holder: FeatyardSettings = defaultSettings(null);

/** Faithful test-double for the production `updateSetting` write path (used when the mock is
 *  active). Mirrors the real handle's level semantics so tests that assert on persistence
 *  behaviour see the same effects:
 *  - session (no level / `{level:"session"}`): mutate the in-memory holder only.
 *  - `{level:"project"}`: mutate the holder AND surgical-write the key to the project settings
 *    file (`<cwd>/.pi/avtc-pi-featyard-settings.json`) via read-modify-write.
 *  (`{level:"global"}` is unused by featyard production code — persistBranchChoice only writes
 *  project or session — so it is treated like session to avoid touching the real home dir.)
 *  Captures `_holder` by variable so it always targets the live holder after reassignment. */
const writeOverride = (
  key: string,
  value: unknown,
  opts: { level?: "session" | "project" | "global" } | null,
): void => {
  (_holder as unknown as Record<string, unknown>)[key] = value;
  if (opts?.level === "project") {
    const projectPath = settingsFilePaths("avtc-pi-featyard").projectPath(process.cwd());
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(projectPath, "utf-8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
    existing[key] = value;
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, JSON.stringify(existing));
  }
};

/**
 * Build default featyard settings from the schema (single source of truth) with overrides
 * applied on top. Used to seed the mock-DI override in tests.
 */
export function defaultSettings(overrides: Partial<FeatyardSettings> | null): FeatyardSettings {
  const fromSchema = Object.fromEntries(
    FEATYARD_SCHEMA.settings.map((s) => [s.id, s.defaultValue]),
  ) as unknown as FeatyardSettings;
  return overrides ? { ...fromSchema, ...overrides } : fromSchema;
}

/**
 * Mock the settings read (DI/test-double for the settings source): injects a MUTABLE holder seeded
 * with schema defaults (+ overrides) via the canonical `_setGetSettings` hook, and returns the
 * holder so a test can mutate it mid-test (e.g. `const s = setTestSettings(null); s.uatMode = "off";`).
 * Cleared by {@link resetSettingsState}. This keeps featyard tests isolated from settings-ui
 * (no real handle, no env var, no session_start) and avoids calling the production `updateSetting`.
 */
export function setTestSettings(overrides: Partial<FeatyardSettings> | null): FeatyardSettings {
  const settings = defaultSettings(overrides);
  _holder = settings;
  // Read + write overrides both target the live `_holder` (variable closure), so they stay in
  // sync across reassignment and production updateSetting writes are visible to getSettings.
  _setGetSettings(() => _holder);
  _setUpdateSettingsOverride(writeOverride);
  return settings;
}

/**
 * Mutate a single key on the current test-settings holder. The canonical way to change one setting
 * mid-test — the production `updateSetting` is not used in tests. The value is untyped (matches the
 * todo helper): the holder is the settings source and tests own the shape of what they set.
 */
export function setSetting(key: string, value: unknown): void {
  (_holder as unknown as Record<string, unknown>)[key] = value;
}

/**
 * Ensure a test-settings holder exists: if none has been injected (via {@link setTestSettings}),
 * inject one seeded with schema defaults. Idempotent — does NOT clobber a holder the test already
 * set, so extension-booting helpers (e.g. createFakePi) can call it to guarantee settings reads
 * work without wiping a test's pre-set overrides.
 */
export function ensureTestSettings(): void {
  // _holder is always present (module-load default); this is a no-op kept for explicitness/compat.
}

/**
 * Shared test helpers for settings test files.
 * Provides temp directory setup/teardown and write helpers for the raw global/project settings
 * files (used by the legacy model-overrides config tests that read ~/.pi/agent/settings.json).
 */

export interface SettingsTestContext {
  tmpDir: string;
  globalDir: string;
  projectDir: string;
  writeGlobalSettings: (data: Record<string, unknown>) => void;
  writeProjectSettings: (data: Record<string, unknown>) => void;
}

/**
 * Create a fresh settings test context with temp directories.
 * Call in beforeEach. Pair with cleanupSettingsTest() in afterEach.
 */
export function createSettingsTestContext(prefix: string): SettingsTestContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const globalDir = path.join(tmpDir, "global");
  const projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  function writeGlobalSettings(data: Record<string, unknown>): void {
    const agentDir = path.join(globalDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "avtc-pi-featyard-settings.json"), JSON.stringify(data));
  }

  function writeProjectSettings(data: Record<string, unknown>): void {
    const projectSettingsDir = path.join(projectDir, ".pi");
    fs.mkdirSync(projectSettingsDir, { recursive: true });
    fs.writeFileSync(path.join(projectSettingsDir, "avtc-pi-featyard-settings.json"), JSON.stringify(data));
  }

  return { tmpDir, globalDir, projectDir, writeGlobalSettings, writeProjectSettings };
}

/**
 * Reset settings state between test files (isolate:false shares modules between files).
 *
 * With the merged settings-ui API, settings reads in tests go through the mock-DI override
 * (_setGetSettings) or the PI_FY_SETTINGS env var — there is no in-memory buffer to reset at the
 * handle layer (the real handle is created only by registerSettingsCommand with a live `pi`).
 * So this clears the mock override + the env var, and resets the model-overrides config cache.
 */
export function resetSettingsState(): void {
  _holder = defaultSettings(null);
  _setGetSettings(() => _holder);
  _setUpdateSettingsOverride(writeOverride);
  delete process.env.PI_FY_SETTINGS;
  resetFeatyardConfig();
}

/**
 * Clean up temp directories created by createSettingsTestContext.
 * Call in afterEach.
 */
export function cleanupSettingsTest(ctx: SettingsTestContext): void {
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

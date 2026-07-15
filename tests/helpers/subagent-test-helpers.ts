// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** Shared test helpers for subagent extension tests. */

import type { FeatyardSettings } from "../../src/settings/settings-types.js";
import { _setGetSettings } from "../../src/settings/settings-ui.js";
import { defaultSettings } from "./settings-test-helpers.js";

/** Minimal mock theme — strips formatting so plain-text matching works. */
export const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

/** Helper to collect all text content from a Container tree. */
export function collectText(container: { children: Array<{ text?: string; children?: unknown[] }> }): string[] {
  const texts: string[] = [];
  for (const child of container.children) {
    if ("text" in child && typeof child.text === "string") {
      texts.push(child.text);
    }
    if ("children" in child && Array.isArray(child.children)) {
      texts.push(...collectText(child as { children: Array<{ text?: string; children?: unknown[] }> }));
    }
  }
  return texts;
}

/** Zero-usage object for SingleResult usage fields. */
export const ZERO_USAGE = {
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
} as const;

/**
 * Set subagent-related settings for testing.
 * Injects a mock settings source (schema defaults + subagent overrides) via the DI hook, then
 * mirrors the subagent-relevant overrides into the PI_FY_SETTINGS env var (pi-subagent reads
 * those from its own settings-ui handle, which loads from the env var).
 */
export function setSubagentTestSettings(overrides: Record<string, unknown> | null) {
  const settings = {
    inactivityTimeoutMs: 1_800_000,
    subagentTimeoutMs: 10_800_000,
    subagentConcurrency: 6,
    maxSubagentDepth: 3,
    ...(overrides ?? {}),
  };
  // Inject featyard settings via the mock-DI hook (defaults + subagent overrides).
  const featyard = defaultSettings(settings as Partial<FeatyardSettings> | null);
  _setGetSettings(() => featyard);
  // Mirror into the env var for pi-subagent's own settings-ui handle.
  process.env.PI_FY_SETTINGS = JSON.stringify(featyard);
}

/** Reset settings set by setSubagentTestSettings. */
export function resetSubagentTestSettings() {
  _setGetSettings(null);
  delete process.env.PI_FY_SETTINGS;
}

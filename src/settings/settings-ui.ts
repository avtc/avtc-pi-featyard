// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Settings extension — the single feature-flow settings handle.
 *
 * Registers the `/ff:settings` command + modal via avtc-pi-settings-ui's {@link registerSettingsCommand}
 * (the sole public entry point; it creates the typed handle internally) and exposes typed accessors.
 * `pi` is only available at activation, so the handle is created lazily by {@link initFeatureFlowSettings}
 * (called from the extension's activate function); all reads happen at runtime, after activation.
 *
 * feature-flow's own settings code here is intentionally thin: a typed `getSettings` cast over the
 * handle's buffer (settings-ui already caches + fills defaults — no second cache), an `updateSetting`
 * wrapper that syncs the fork-mode env var, and the clampFn + fork-mode helpers. model-overrides
 * (the legacy shared-settings.json config for model routing) are re-exported unchanged.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCommand, type SettingsHandle } from "avtc-pi-settings-ui";
import { log } from "../log.js";
import { PiCtx } from "../shared/types.js";
import { subscribeToDialogCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import { clampFeatureFlowSettings, FEATURE_FLOW_SCHEMA } from "./settings-schema.js";
import type { FeatureFlowSettings } from "./settings-types.js";

let handle: SettingsHandle<FeatureFlowSettings> | undefined;

/** Required keys in FeatureFlowSettings (all non-optional interface fields). */
const REQUIRED_SETTINGS_KEYS = FEATURE_FLOW_SCHEMA.settings.map((s) => s.id);

/**
 * Cast the handle's `Record<string, unknown>` buffer to {@link FeatureFlowSettings}.
 * Validates that all required keys are present; logs a warning if any are missing. A pure cast +
 * dev-time check — no runtime transformation, nothing to memoize.
 */
function asSettings(raw: Record<string, unknown>): FeatureFlowSettings {
  const missing = REQUIRED_SETTINGS_KEYS.filter((key) => !(key in raw));
  if (missing.length > 0) {
    log.warn(`[settings] asSettings: missing keys: ${missing.join(", ")} — returning partial object`);
  }
  return raw as unknown as FeatureFlowSettings;
}

/** @internal Test-only export for validating asSettings warning path */
export { asSettings as _asSettings };

// ---------------------------------------------------------------------------
// Mock-DI hooks (tests inject a settings source instead of the real handle)
// ---------------------------------------------------------------------------

/** Test-only override for the settings read (DI/mock pattern). */
let _getSettingsOverride: (() => FeatureFlowSettings) | null = null;

/** Test-only override for the settings write (DI/mock pattern). When set, production
 *  `updateSetting` calls (e.g. resolve-base-branch persisting baseBranch) mutate the mock holder
 *  instead of the real handle — so writes stay visible to reads and don't throw when no handle
 *  has been activated. The mock is the single source of truth for both reads and writes. Pass
 *  `null` to restore the real-handle write path. */
let _updateSettingsOverride:
  | ((key: string, value: unknown, opts: { level?: "session" | "project" | "global" } | null) => void)
  | null = null;

/** Test-only: inject a mock settings source for reads (pass `null` to restore the real handle). */
export function _setGetSettings(fn: (() => FeatureFlowSettings) | null): void {
  _getSettingsOverride = fn;
}

/** Test-only: inject a mock settings writer (pass `null` to restore the real-handle write path). */
export function _setUpdateSettingsOverride(
  fn: ((key: string, value: unknown, opts: { level?: "session" | "project" | "global" } | null) => void) | null,
): void {
  _updateSettingsOverride = fn;
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

/** Get typed feature-flow settings (settings-ui's buffer is the single cache; no second layer). */
export function getSettings(): FeatureFlowSettings {
  if (_getSettingsOverride) return _getSettingsOverride();
  if (!handle) throw new Error("feature-flow settings not initialized — initFeatureFlowSettings not called");
  return handle.getSettings();
}

/**
 * Update a setting by key. With no `level`, mutates the in-memory buffer (session); with
 * `{ level: "project" }` / `{ level: "global" }`, does a surgical one-key write to that file and
 * syncs the buffer. After any change, refreshes the fork-mode env var for the active phase so a
 * mid-turn edit of a fork-mode key takes effect without a phase transition.
 */
export function updateSetting(
  key: string,
  value: unknown,
  opts: { level?: "session" | "project" | "global" } | null,
): void {
  if (_updateSettingsOverride) {
    _updateSettingsOverride(key, value, opts);
    syncForkModeEnv();
    return;
  }
  if (!handle) throw new Error("feature-flow settings not initialized — initFeatureFlowSettings not called");
  handle.updateSetting(key, value, opts ?? undefined);
  syncForkModeEnv();
}

/**
 * Map the active workflow phase + settings to the subagent fork mode.
 *
 *   design/plan    → planReviewSubagentsMode (e.g. "new+fork" — dual review)
 *   review         → featureReviewSubagentsMode
 *   else (implement/verify/uat/finish/none) → "new" (fresh subagents, no fork)
 *
 * Pure (reads env + settings, no side effects) so it stays testable and can be
 * shared between phase-driven sync (syncEnvVarsFromState) and settings-ui edits.
 */
export function resolveForkModeForPhase(phase: string | undefined, settings: FeatureFlowSettings): string {
  switch (phase) {
    case "design":
    case "plan":
      return settings.planReviewSubagentsMode;
    case "review":
      return settings.featureReviewSubagentsMode;
    default:
      // implement / verify / uat / finish / no active phase → always fresh.
      return "new";
  }
}

/**
 * Sync `PI_SUBAGENT_FORK_MODE` from the active phase + settings.
 *
 * The subagent extension's new+fork duplication reads this env var from the
 * DISPATCHING process's own env, so the root session must own it. Root-only —
 * guarded by the absence of PI_SUBAGENT_PARENT_PID; a subagent re-deriving it
 * would re-arm fork mode at the 2nd level and defeat the "fork mode must not
 * propagate deeper than 1st level" rule.
 */
export function syncForkModeEnv(): void {
  if (process.env.PI_SUBAGENT_PARENT_PID !== undefined) return; // root session only
  const mode = resolveForkModeForPhase(process.env.PI_FF_STAGE, getSettings());
  if (mode) {
    process.env.PI_SUBAGENT_FORK_MODE = mode;
  } else {
    delete process.env.PI_SUBAGENT_FORK_MODE;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the `/ff:settings` command + modal and create the settings handle. Called from the
 * extension's activate function (needs `pi`). `beforeOpen` stashes the command ctx for the modal;
 * `onAfterChange` refreshes the fork-mode env var after a mid-turn edit.
 */
export function initFeatureFlowSettings(pi: ExtensionAPI): void {
  handle = registerSettingsCommand<FeatureFlowSettings>(pi, FEATURE_FLOW_SCHEMA, {
    commandName: "ff:settings",
    title: "Feature Flow Settings",
    titleRight: "avtc-pi-feature-flow",
    clampFn: clampFeatureFlowSettings,
    envVar: "PI_FF_SETTINGS",
    beforeOpen: (ctx) => {
      if (!globalThis.__piCtx) globalThis.__piCtx = new PiCtx();
      globalThis.__piCtx.refresh(ctx);
    },
    onAfterChange: () => {
      syncForkModeEnv();
    },
  });
}

// ---------------------------------------------------------------------------
// Re-exports from sub-modules
// ---------------------------------------------------------------------------

// NOTE: feature-flow consumes avtc-pi-settings-ui; it must NOT re-export settings-ui's
// symbols (transitive re-export anti-pattern). Any code needing them should import
// directly from "avtc-pi-settings-ui".
export {
  DEFAULT_GLOBAL_DIR,
  type FeatureFlowConfig,
  invalidateConfigCache,
  invalidateConfigCacheIfChanged,
  loadFeatureFlowConfig,
  type ModelOverride,
  NO_CWD_OVERRIDE,
  resetFeatureFlowConfig,
  resolveModelOverride,
  resolveReviewSkill,
  resolveStageModelOnly,
  setFeatureFlowConfig,
} from "./model-overrides.js";
export { clampFeatureFlowSettings, FEATURE_FLOW_SCHEMA, parseContextCompactValue } from "./settings-schema.js";
export type {
  AutoOnBlock,
  BranchPolicy,
  DesignDocStorage,
  ExecutionFlow,
  FeatureFlowSettings,
  FeatureReviewMode,
  FeatureReviewSubagentsMode,
  NestedResearchers,
  PerTaskReviewMode,
  PlanReviewMode,
  PlanReviewSubagentsMode,
  PreCommitDiscipline,
  TestingDiscipline,
  UatMode,
  VerifyPhases,
} from "./settings-types.js";

// ---------------------------------------------------------------------------
// Extension entry point (package.json → src/index.ts activate)
// ---------------------------------------------------------------------------

export default function settingsExtension(pi: ExtensionAPI): void {
  initFeatureFlowSettings(pi);
  subscribeToDialogCoordinator(pi);
}

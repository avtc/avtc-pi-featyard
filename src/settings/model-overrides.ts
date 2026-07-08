// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Feature Flow-specific model override configuration.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log.js";
// (no pi-tui or avtc-pi-settings-ui imports needed — model overrides are not rendered as a settings tab)

export type ModelOverride = string | string[];

export interface FeatureFlowConfig {
  "stage-models"?: Record<string, ModelOverride>;
  "default-model": string | null;
  "kanban-port"?: number | null;
  /** File extensions counted as "source" files by the pre-commit/coverage gate (e.g. [".ts",".py"], ["+.md","-.css"]). null = use built-in defaults. */
  "source-extensions"?: string[] | null;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidModelString(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const idx = val.indexOf("/");
  return idx > 0 && idx < val.length - 1;
}

function validateDefaultModel(val: unknown): string | null {
  if (val == null) return null;
  if (isValidModelString(val)) return val;
  log.warn(`Skipping invalid default-model: ${JSON.stringify(val)}`);
  return null;
}

function validateKanbanPort(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === "number" && Number.isInteger(val) && val >= 1 && val <= 65535) return val;
  log.warn(`Skipping invalid kanban-port: ${JSON.stringify(val)} (must be integer 1-65535 or null)`);
  return null;
}

/** Validate a source-extensions entry: must be a non-empty array of strings, else null. */
function validateSourceExtensions(val: unknown): string[] | null {
  if (val == null) return null;
  if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
    return val.filter((v) => v.trim().length > 0);
  }
  log.warn(`Skipping invalid source-extensions: ${JSON.stringify(val)} (must be array of strings or null)`);
  return null;
}

function validateOverride(val: unknown): ModelOverride | null {
  if (isValidModelString(val)) return val;
  if (Array.isArray(val)) {
    const valid = val.filter((v) => isValidModelString(v));
    return valid.length > 0 ? valid : null;
  }
  return null;
}

function filterValidOverrides(globalRaw: unknown, projectRaw: unknown): Record<string, ModelOverride> {
  const result: Record<string, ModelOverride> = {};
  for (const raw of [globalRaw, projectRaw]) {
    if (typeof raw !== "object" || raw === null) continue;
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      const validated = validateOverride(val);
      if (validated) {
        result[key] = validated;
      } else if (val !== undefined) {
        log.warn(`Skipping invalid model override '${key}': ${JSON.stringify(val)}`);
      }
    }
  }
  return result;
}

function extractFeatureFlowSection(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw) return null;
  const sp = raw["avtc-pi-feature-flow"];
  if (!sp || typeof sp !== "object") return null;
  return sp as Record<string, unknown>;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn(`readJsonFile failed for ${filePath}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function emptyConfig(): Required<FeatureFlowConfig> {
  return {
    "stage-models": {},
    "default-model": null,
    "kanban-port": null,
    "source-extensions": null,
  };
}

let _config: Required<FeatureFlowConfig> = emptyConfig();
let _configLoaded = false;
/** Serialized snapshot of the last loaded config, used to detect changes. */
let _configSnapshot: string | null = null;

function getDefaultGlobalDir(): string {
  return join(homedir(), ".pi");
}

/** Read feature-flow sections from global and project config files. */
function readConfigSections(
  globalDir: string | null,
  cwd: string | null,
): {
  globalSection: Record<string, unknown> | null;
  projectSection: Record<string, unknown> | null;
} {
  const globalPath = join(globalDir ?? getDefaultGlobalDir(), "agent", "settings.json");
  const globalSection = extractFeatureFlowSection(readJsonFile(globalPath));

  let projectSection: Record<string, unknown> | null = null;
  if (cwd) {
    const projectPath = join(cwd, ".pi", "settings.json");
    projectSection = extractFeatureFlowSection(readJsonFile(projectPath));
  }

  return { globalSection, projectSection };
}

/** Pass as `cwd` when no working directory override is needed. */
/** Sentinel: no working directory override (use process.cwd()) */
export const NO_CWD_OVERRIDE: string | null = null;

/** Sentinel: no working directory specified (use process.cwd()) */
export const NO_CWD: string | null = null;

/** Sentinel: use the default global directory (the shared ~/.pi/agent/settings.json). */
export const DEFAULT_GLOBAL_DIR: string | null = null;

export function loadFeatureFlowConfig(globalDir: string | null, cwd: string | null): Required<FeatureFlowConfig> {
  if (_configLoaded) return _config;

  const { globalSection, projectSection } = readConfigSections(globalDir, cwd);

  if (!globalSection && !projectSection) {
    _config = emptyConfig();
    _configLoaded = true;
    _configSnapshot = JSON.stringify({ global: null, project: null });
    return _config;
  }

  const globalModels = globalSection ?? {};
  const projectModels = projectSection ?? {};

  _config = {
    "stage-models": filterValidOverrides(globalModels["stage-models"], projectModels["stage-models"]),
    "default-model": validateDefaultModel(
      "default-model" in projectModels ? projectModels["default-model"] : globalModels["default-model"],
    ),
    "kanban-port": validateKanbanPort(
      "kanban-port" in projectModels ? projectModels["kanban-port"] : globalModels["kanban-port"],
    ),
    "source-extensions": validateSourceExtensions(
      "source-extensions" in projectModels ? projectModels["source-extensions"] : globalModels["source-extensions"],
    ),
  };

  _configLoaded = true;
  _configSnapshot = JSON.stringify({ global: globalSection, project: projectSection });
  log.info(
    `FeatureFlow config loaded: ${Object.keys(_config["stage-models"] ?? {}).length} stage-models, default-model=${_config["default-model"] ?? "<none>"}, kanban-port=${_config["kanban-port"] ?? "random"}, source-extensions=${_config["source-extensions"] ? "custom" : "default"}`,
  );
  return _config;
}

export function resetFeatureFlowConfig(): void {
  _config = emptyConfig();
  _configLoaded = false;
  _configSnapshot = null;
}

export function setFeatureFlowConfig(config: Required<FeatureFlowConfig>): void {
  _config = config;
  _configLoaded = true;
}

export function invalidateConfigCache(): void {
  _configLoaded = false;
}

/**
 * Invalidate config cache only if the model-related config section actually changed.
 * Reads the current config from disk and compares to the cached snapshot.
 * This avoids unnecessary re-reads when only non-model settings were saved.
 */
export function invalidateConfigCacheIfChanged(globalDir: string | null, cwd: string | null): void {
  if (!_configLoaded) return; // Already invalidated — nothing to check

  const { globalSection, projectSection } = readConfigSections(globalDir, cwd);
  const currentSnapshot = JSON.stringify({ global: globalSection, project: projectSection });
  if (currentSnapshot !== _configSnapshot) {
    _configLoaded = false;
  }
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

function resolveOverride(override: ModelOverride, loopIndex: number): string | null {
  if (Array.isArray(override)) {
    if (override.length === 0) return null;
    const idx = ((loopIndex % override.length) + override.length) % override.length;
    return override[idx] ?? null;
  }
  return override;
}

export function resolveModelOverride(
  stage: string | null,
  loopIndex: number,
  config: FeatureFlowConfig,
): string | null {
  // Workflow callers (phase-transitions, review-context): stage-models -> default-model.
  // If a stage-models entry EXISTS for the active stage, return its resolution
  // (even if it resolves to null, e.g. an empty array) — do NOT fall through to
  // default-model. default-model applies only when no entry exists for the stage.
  // The entry is captured once (avoids double lookup) and the truthy guard mirrors
  // the original semantics (arrays are truthy; empty/missing entries skip).
  const entry = stage ? config["stage-models"]?.[stage] : undefined;
  if (entry) return resolveOverride(entry, loopIndex);
  // Truthy check (not ??) preserves original behavior: an empty-string
  // default-model is treated as absent (validated configs never have "", but
  // raw configs passed directly could).
  if (config["default-model"]) return config["default-model"];
  return null;
}

/**
 * Stage-models only, NO default-model fallthrough. Used by the subagent hook so it
 * yields to pi-subagent's Phase 3 default instead of shadowing it.
 */
export function resolveStageModelOnly(
  stage: string | null,
  loopIndex: number,
  config: FeatureFlowConfig,
): string | null {
  const entry = stage ? config["stage-models"]?.[stage] : undefined;
  if (entry) return resolveOverride(entry, loopIndex);
  return null;
}

export function resolveReviewSkill(settings: { maxFeatureReviewRounds: number }): string | null {
  if (settings.maxFeatureReviewRounds === 0) return null;
  return "ff-review";
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _resetModelResolution(): void {
  _configLoaded = false;
}

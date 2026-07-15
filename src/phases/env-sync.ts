// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Environment variable synchronization — centralized management of
 * PI_FY_* env vars. All writes to these env vars should go
 * through this module to ensure atomicity and traceability.
 *
 * Note: PI_FY_REVIEW_LOOP and the per-task pointer (implement.currentTask) are
 * intentionally NOT mirrored to env vars. They live in feature-state — the
 * durable source of truth — and are read directly by the host-side consumers
 * (subagent prompt-transformer, widget, template substitution), which all have
 * handler access. Only PI_FY_FEATURE (child needs it to locate its state file
 * on start) and PI_FY_STAGE (root fork-mode derivation) are env-mirrored.
 */

import { log } from "../log.js";
import { syncForkModeEnv } from "../settings/settings-ui.js";
import type { FeatureSession } from "../state/feature-session.js";

/** Set the active feature slug env var */
export function setActiveFeatureEnv(slug: string): void {
  process.env.PI_FY_FEATURE = slug;
}

/** Clear the active feature slug env var */
export function clearActiveFeatureEnv(): void {
  delete process.env.PI_FY_FEATURE;
}

/**
 * Clear feature-specific env vars (stage).
 */
export function clearFeatureEnvVars(): void {
  delete process.env.PI_FY_STAGE;
}

/**
 * Sync PI_FY_STAGE from current handler state.
 *
 * **When to call:** After ANY state change that affects currentPhase. Call sites include:
 * - Phase transitions (phase-ready.ts, phase-transitions.ts)
 * - Review loop increments (review-loops.ts)
 * - Feature activation/restoration (feature-management.ts)
 * - Session state restoration (session-lifecycle.ts, state-persistence.ts)
 * - Workflow commands that change phase (workflow-commands.ts)
 * - Guardrail state changes (guardrails.ts via syncEnvVars callback)
 *
 * `persistState()` calls this internally, so standalone calls immediately before
 * `persistState()` are redundant and can be removed.
 */
export function syncEnvVarsFromState(handler: FeatureSession): void {
  const ws = handler.getWorkflowState();
  // Stage is independent of feature slug — always sync from currentPhase.
  if (ws?.currentPhase) {
    process.env.PI_FY_STAGE = ws.currentPhase;
    log.info(`[workflow] syncEnvVars: set PI_FY_STAGE=${ws.currentPhase}`);
  } else {
    log.info(`[workflow] syncEnvVars: clearing PI_FY_STAGE (currentPhase=${ws?.currentPhase ?? "null"})`);
    delete process.env.PI_FY_STAGE;
  }
  // Fork mode is derived from the (just-synced) stage + settings. Root-only inside.
  syncForkModeEnv();
}

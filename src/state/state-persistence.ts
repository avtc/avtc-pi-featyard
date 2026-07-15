// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * State persistence — two tiers, three stores.
 *
 *   FeatureState    (durable record) → File (cross-session bootstrap) + AppendEntry
 *   GuardrailsState (transient)      → AppendEntry ONLY (resets on a fresh session;
 *                                       restored when resuming a session-tree node)
 *
 * The handler holds the active FeatureState in memory as the single source of
 * truth. persistState write-throughs the in-memory record to its file (no
 * merge — the handler record IS the record) and appends the full FeatyardState
 * wrapper to the session log. reconstructState bootstraps a fresh session by
 * loading the active feature's file into the handler (guardrails reset).
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
import { syncEnvVarsFromState } from "../phases/env-sync.js";
import type { FeatureSession } from "../state/feature-session.js";
import { recoverArtifactsFromDisk } from "./feature-management.js";
import {
  DEFAULT_DIR,
  type FeatureState,
  stateFilePath as featureStateFilePath,
  saveFeatureState,
} from "./feature-state.js";

export const FEATYARD_STATE_ENTRY_TYPE = "featyard_state";

/** True when this session is a spawned subagent. Uses dual-signal detection:
 *  checks PiCtx.mode (from globalThis.__piCtx, refreshed on session_start) first,
 *  then falls back to PI_SUBAGENT_PARENT_PID env var. When mode is unavailable
 *  (PiCtx not yet initialized), relies solely on the env var. Subagents READ
 *  feature context on start but must NOT write the feature file — durable feature
 *  state is host-owned; suppressing the file write eliminates the host/subagent
 *  write race. Subagents still appendEntry (for in-session resume). */
export function isSubagentSession(): boolean {
  const ctx = globalThis.__piCtx;
  if (ctx?.mode !== undefined && ctx.mode !== "tui") return true;
  return process.env.PI_SUBAGENT_PARENT_PID !== undefined;
}

/**
 * Returns the feature state file path for the currently active feature slug,
 * or null if no feature is active.
 */
export function getStateFilePath(handler: FeatureSession): string | null {
  const slug = handler.getActiveFeatureSlug();
  if (slug) {
    return featureStateFilePath(slug, DEFAULT_DIR);
  }
  return null;
}

/**
 * Reconstruct handler state from a feature state file (fresh-session bootstrap).
 * Guardrails (tdd/verification) are NOT restored — they are session-only and
 * reset on a fresh session. Falls back to an empty handler if no file is found.
 */
export function reconstructState(
  _ctx: ExtensionContext,
  handler: FeatureSession,
  stateFilePath: string | false | null,
): void {
  handler.resetState();

  // Only restore from the feature state file — never from session branch entries
  // to avoid cross-feature state contamination. Guardrails reset (session-only).
  if (stateFilePath !== false) {
    try {
      const statePath = stateFilePath ?? getStateFilePath(handler);
      if (statePath && fs.existsSync(statePath)) {
        const raw = fs.readFileSync(statePath, "utf-8");
        const data = JSON.parse(raw) as FeatureState;
        // Load the durable record into the handler (seeds the workflow tracker;
        // guardrails reset to neutral since they are session-only).
        handler.setActiveFeatureState(data);
        // Recover missing doc artifacts from disk into the in-memory record.
        recoverArtifactsFromDisk(handler);
        // Sync env vars from the restored record so subagent tool can resolve model overrides.
        syncEnvVarsFromState(handler);
        return;
      }
    } catch (err) {
      log.warn(`Failed to read state file: ${err instanceof Error ? err.message : err}`);
    }
  }
  // No state file found — reset to fresh defaults (no active feature).
  handler.resetState();
}

/**
 * Persist handler state to both the session log (AppendEntry) and the
 * per-feature state file (write-through). The handler's in-memory record is the
 * source of truth, so the file is written verbatim — no merge.
 */
export function persistState(pi: ExtensionAPI, handler: FeatureSession): void {
  const fullState = handler.getFullState();
  // AppendEntry stores the FULL wrapper (featureState + guardrailsState) so a
  // session-tree resume restores BOTH tiers as of this point.
  pi.appendEntry(FEATYARD_STATE_ENTRY_TYPE, fullState);

  // Subagent sessions read feature context but never own the durable record —
  // skip the file write so they cannot race the host's write-through.
  if (!isSubagentSession()) {
    try {
      const active = handler.getActiveFeatureState();
      if (active) {
        // Write-through: the handler record IS the record. Stamp updatedAt + persist.
        active.updatedAt = new Date().toISOString();
        saveFeatureState(active, DEFAULT_DIR);
      }
    } catch (err) {
      log.warn(`Failed to persist state file: ${err instanceof Error ? err.message : err}`);
    }
  }
  // Keep env vars in sync after every state persistence.
  syncEnvVarsFromState(handler);
}

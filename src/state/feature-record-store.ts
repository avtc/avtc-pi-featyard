// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * FeatureRecordStore — the persistent tier holder.
 *
 * Wraps the active feature record (`FeatureState | null`) in an explicit holder
 * class so the persistence-fate boundary is structural, not conventional. Disk
 * serialization goes through this holder ONLY — the sibling SessionGuardrails
 * holder is structurally unreachable from persistence.
 *
 * Holds the single source of truth: get() returns the live reference (not a
 * clone), so callers mutate it in place then persist via saveFeatureState.
 */

import type { FeatureState } from "./feature-state.js";

export interface FeatureRecordStore {
  /** The active feature record (live reference — mutate then persist), or null when idle. */
  get(): FeatureState | null;
  /** Replace the record. Pass null to clear. Stores the live reference (no clone). */
  set(record: FeatureState | null): void;
  /** Clear to idle (no active feature). */
  clear(): void;
}

/** Construct the persistent-tier holder. Starts empty (no active feature). */
export function createFeatureRecordStore(): FeatureRecordStore {
  let record: FeatureState | null = null;
  return {
    get: () => record,
    set: (rec) => {
      record = rec;
    },
    clear: () => {
      record = null;
    },
  };
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

export type Lane = "backlog" | "design" | "design-approval" | "ready" | "in-progress" | "uat" | "done";

/** Canonical lane order — single source of truth for all lane ordering. */
export const LANE_ORDER: readonly Lane[] = [
  "backlog",
  "design",
  "design-approval",
  "ready",
  "in-progress",
  "uat",
  "done",
] as const;

/** Set of valid lane values for validation. */
export const VALID_LANES: ReadonlySet<Lane> = new Set(LANE_ORDER);

/** Type guard: narrows `string` to `Lane` using VALID_LANES. */
export function isLane(value: string | undefined): value is Lane {
  return value !== undefined && VALID_LANES.has(value as Lane);
}

export interface Project {
  id: number;
  name: string;
  repo_path: string;
  base_branch: string | null;
  created_at: string;
  updated_at: string;
}

export interface Feature {
  id: number;
  slug: string | null;
  project_id: number;
  lane: Lane;
  priority: number;
  title: string;
  description: string | null;
  design_doc: string | null;
  plan_doc: string | null;
  state_file: string | null;
  assigned_session: string | null;
  overlay_status: string | null; // null | 'waiting-for-response'
  created_at: string;
  updated_at: string;
  // Joined from feature_locks when present
  locked_at?: string | null;
  last_heartbeat?: string | null;
  locked_by_session?: string | null; // fl.session_id from feature_locks
}

export interface FeatureHistoryEntry {
  id: number;
  feature_id: number;
  from_lane: string | null;
  to_lane: string;
  changed_by: string;
  session_id: string | null;
  note: string | null;
  created_at: string;
}

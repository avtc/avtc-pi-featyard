// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/*
 * V2 scope — tag CRUD operations (schema tables exist, operations not yet implemented):
 *   - createTag(name, color?) → tag id
 *   - getTag(id) → Tag | null
 *   - listTags() → Tag[]
 *   - updateTag(id, { name?, color? }) → void
 *   - deleteTag(id) → void
 *   - addFeatureTag(featureId, tagId) → void
 *   - removeFeatureTag(featureId, tagId) → void
 *   - getFeatureTags(featureId) → Tag[]
 *   - getFeaturesByTag(tagId) → Feature[]
 *
 * The `tags` and `feature_tags` tables are created in V1 schema for forward
 * compatibility, but no CRUD operations, REST endpoints, or UI elements
 * exist yet. Implement when tag-based filtering and categorization is needed.
 */

export const SCHEMA_V1 = `
-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  base_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Features
CREATE TABLE IF NOT EXISTS features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT, -- nullable: null until design doc is written

  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lane TEXT NOT NULL DEFAULT 'backlog',
  priority INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT,
  design_doc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_features_project_slug ON features(project_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_features_project_lane ON features(project_id, lane);
CREATE INDEX IF NOT EXISTS idx_features_priority ON features(project_id, lane, priority DESC);

-- Tags (many-to-many)
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS feature_tags (
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (feature_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_feature_tags_tag ON feature_tags(tag_id);

-- Dependencies (directed graph)
CREATE TABLE IF NOT EXISTS feature_dependencies (
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('blocks', 'requires', 'related')),
  PRIMARY KEY (feature_id, depends_on_id),
  CHECK(feature_id != depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_feature_deps_from ON feature_dependencies(feature_id);
CREATE INDEX IF NOT EXISTS idx_feature_deps_to ON feature_dependencies(depends_on_id);

-- Feature history (audit trail)
CREATE TABLE IF NOT EXISTS feature_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  from_lane TEXT,
  to_lane TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  session_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feature_history_feature ON feature_history(feature_id);

-- Lock tracking
CREATE TABLE IF NOT EXISTS feature_locks (
  feature_id INTEGER PRIMARY KEY REFERENCES features(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feature_locks_session ON feature_locks(session_id);

-- Migration tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

export const SCHEMA_V2 = `
-- Add overlay_status column for waiting-for-response indicator
ALTER TABLE features ADD COLUMN overlay_status TEXT DEFAULT NULL;
`;

export const SCHEMA_V3 = `
-- Auto-agent state persistence for crash recovery
CREATE TABLE IF NOT EXISTS auto_agent_state (
  session_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('worker', 'designer', 'agent')),
  project_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('idle', 'working', 'waiting', 'polling', 'stopped', 'error')),
  current_feature_id INTEGER,
  current_feature_lane TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const SCHEMA_V4 = `
-- Add metadata columns for cross-referencing and session tracking
ALTER TABLE features ADD COLUMN plan_doc TEXT DEFAULT NULL;
ALTER TABLE features ADD COLUMN state_file TEXT DEFAULT NULL;
ALTER TABLE features ADD COLUMN assigned_session TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_features_assigned ON features(assigned_session);
`;

export const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
];

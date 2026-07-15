// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./kanban-db-schema.js";
import type { Feature, FeatureHistoryEntry, Lane, Project } from "./kanban-types.js";

/**
 * Loose statement interface matching the call shape used throughout this module
 * (positional params spread as `unknown[]`, row reads cast via `as`). node:sqlite's
 * `StatementSync` types params as `SQLInputValue` and rows as `Record<string,
 * SQLOutputValue>`, which reject the existing `as Feature` casts. This interface
 * widens the param/row types to `unknown` so all existing casts stay valid, while
 * preserving `.run()`'s `changes` count for affected callers.
 */
interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * Loose database interface (see {@link SqlStatement}). `DatabaseSync` is
 * assignable to this because `SQLInputValue` ⊆ `unknown` and the concrete return
 * types are subtypes of `unknown`. Keeps the migration a drop-in: every
 * `.prepare().get() as Feature` and `.run(...mixedParams)` call compiles unchanged.
 */
interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/**
 * Suppress Node's ExperimentalWarning for `node:sqlite`. The API is stable in
 * practice (ships with Node 22+, required by pi) but Node still tags it
 * experimental. Without this, every process logs a warning on first DB open.
 * Pattern mirrors avtc-pi-portrait and gsd-pi.
 */
const _origEmit = process.emit;
// Node's overloaded emit signature isn't directly assignable — loose cast is intentional.
(process as { emit: typeof process.emit }).emit = (event: string, ...args: unknown[]): boolean => {
  if (
    event === "warning" &&
    args[0] &&
    typeof args[0] === "object" &&
    "name" in args[0] &&
    (args[0] as { name: string }).name === "ExperimentalWarning" &&
    "message" in args[0] &&
    typeof (args[0] as { message: string }).message === "string" &&
    (args[0] as { message: string }).message.includes("SQLite")
  ) {
    return false;
  }
  return _origEmit.apply(process, [event, ...args] as Parameters<typeof process.emit>);
};

/** Sentinel: empty params array for rawExec */
export const EMPTY_PARAMS: unknown[] = [];

/** Sentinel: no project ID specified */
export const NO_PROJECT_ID: number | undefined = undefined;

/** Sentinel: no timestamp specified (will use current time) */
export const NO_NOW: string | undefined = undefined;

/** Sentinel: no done-hide-after-ms filter */
export const NO_DONE_HIDE_AFTER_MS: number | undefined = undefined;

/**
 * Prefix marking a feature-lock `session_id` as "interactive". Such locks are
 * created by design-doc save, manual kanban lock, or /fy:auto-stop, carry no
 * heartbeat, and are NEVER swept by cleanupExpiredLocks (they persist until
 * explicitly released or reassigned to an auto-agent). Auto-agent locks use a
 * UUID `session_id` instead. The `cleanupExpiredLocks` SQL `NOT LIKE` predicate
 * is DERIVED from this constant (`\`${INTERACTIVE_SESSION_PREFIX}%\``), so it is
 * a single source of truth — no manual sync is needed when the prefix changes.
 */
export const INTERACTIVE_SESSION_PREFIX = "session:";

/** Build the interactive lock `session_id` for a feature slug. */
export function interactiveSessionIdFor(slug: string): string {
  return `${INTERACTIVE_SESSION_PREFIX}${slug}`;
}

/** Sentinel: no precomputed bounds */
export const NO_PRECOMPUTED_BOUNDS: { min: number | null; max: number | null } | undefined = undefined;

const DB_FILENAME = "kanban.db";

/** Spacing between auto-assigned priorities. Allows up to 9 manual insertions
 *  between auto-assigned positions without renumbering. */
export const PRIORITY_SPACING = 10;

/** Compute FIFO priority: below all existing cards in the lane, or 0 if empty.
 *  Used by move, create (bottom position), and kanbanTake.
 *  @param bounds.min Minimum priority in the lane, or null if empty.
 *  @param bounds.max Unused — included so the type matches getLanePriorityBounds output. */
export function fifoPriority(bounds: { min: number | null; max: number | null }): number {
  return bounds.min !== null ? bounds.min - PRIORITY_SPACING : 0;
}

/** Compute top priority: above all existing cards in the lane, or PRIORITY_SPACING if empty.
 *  Used by create (top position) and assignTopPriority.
 *  @param bounds.max Maximum priority in the lane, or null if empty.
 *  @param bounds.min Unused — included so the type matches getLanePriorityBounds output. */
export function topPriority(bounds: { min: number | null; max: number | null }): number {
  return bounds.max !== null ? bounds.max + PRIORITY_SPACING : PRIORITY_SPACING;
}

/** Reusable SELECT for features with lock info from LEFT JOIN with feature_locks. */
const FEATURE_SELECT_SQL =
  "SELECT f.*, fl.locked_at, fl.last_heartbeat, fl.session_id as locked_by_session FROM features f LEFT JOIN feature_locks fl ON f.id = fl.feature_id";

/** Normalize a repo path for consistent lookups: forward slashes, lowercase on Windows, no trailing slash. */
export function normalizeRepoPath(repoPath: string): string {
  let normalized = repoPath.replace(/\\/g, "/");
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  // Strip trailing slash (but keep root "/" or "C:/")
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export class KanbanDatabase {
  private db!: SqlDatabase;

  private constructor(_dbPath: string) {}

  /**
   * Create a new KanbanDatabase backed by a SQLite file.
   * Kept async for API compatibility but internally synchronous (node:sqlite DatabaseSync).
   */
  static async create(dataDir: string): Promise<KanbanDatabase> {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, DB_FILENAME);

    const db = new DatabaseSync(dbPath);

    // Enable WAL mode for safe concurrent multi-process access
    db.exec("PRAGMA journal_mode = WAL");
    // Wait up to 5s for locked database instead of failing immediately
    db.exec("PRAGMA busy_timeout = 5000");
    // NORMAL is safe with WAL and much faster than FULL
    db.exec("PRAGMA synchronous = NORMAL");
    // Enable foreign key enforcement (required for ON DELETE CASCADE)
    db.exec("PRAGMA foreign_keys = ON");

    const instance = new KanbanDatabase(dbPath);
    instance.db = db;
    instance.runMigrations();
    return instance;
  }

  /** @internal Bind an already-initialized Database (for testing) */
  static fromDb(db: DatabaseSync, dbPath: string): KanbanDatabase {
    const instance = new KanbanDatabase(dbPath);
    instance.db = db;
    instance.runMigrations();
    return instance;
  }

  /** @internal Create an in-memory database for testing (no file I/O) */
  static async createInMemory(): Promise<KanbanDatabase> {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    return KanbanDatabase.fromDb(db, ":memory:");
  }

  // ---- Migration ----

  /**
   * Check whether a column exists on a table by querying sqlite_master for the
   * CREATE statement and scanning for the column name. Safer than pragma_table_info
   * with parameter binding (which is unreliable across SQLite versions).
   */
  private columnExists(table: string, column: string): boolean {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table) as
      | { sql: string }
      | undefined;
    if (!row?.sql) return false;
    // Match column name as a whole word in the CREATE statement.
    // e.g., "overlay_status" but not "some_overlay_status_field"
    return new RegExp(`\\b${column}\\b`).test(row.sql);
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    for (const migration of MIGRATIONS) {
      const existing = this.db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(migration.version);
      if (existing) continue;

      // Pre-check: if migration only adds columns that already exist, the schema
      // is already up to date (e.g., DB was created outside migration system or
      // schema_migrations was deleted). Mark as applied and skip.
      const alterMatches = [...migration.sql.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)];
      if (alterMatches.length > 0) {
        const allExist = alterMatches.every(([, table, column]) => this.columnExists(table, column));
        if (allExist) {
          this.db
            .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .run(migration.version, new Date().toISOString());
          continue;
        }
      }

      // Execute migration as a batch, then record version in same transaction.
      this.withTransaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      });
    }
  }

  // ---- Persistence ----

  /** No-op for node:sqlite — writes are immediate via WAL. Kept for API compat. */
  save(): void {
    // node:sqlite writes are synchronous and immediate via WAL.
    // This method is kept as a no-op for backward compatibility with callers.
  }

  close(): void {
    this.db.close();
  }

  // ---- Raw query helpers ----

  /** Run a function inside a transaction. Uses SAVEPOINT for nesting so it
   *  composes safely when called from within another transaction. */
  runInTransaction<T>(fn: () => T): T {
    return this.withTransaction(fn);
  }

  /**
   * Transaction wrapper replacing better-sqlite3's `.transaction()`.
   * Uses SAVEPOINT for re-entrant nesting (matches better-sqlite3 semantics):
   * the outermost call opens BEGIN/COMMIT, nested calls open SAVEPOINT tiers.
   * On error the active tier is rolled back and the error re-thrown.
   */
  private transactionDepth = 0;
  private withTransaction<T>(fn: () => T): T {
    const topLevel = this.transactionDepth === 0;
    if (topLevel) {
      this.db.exec("BEGIN");
    } else {
      this.db.exec(`SAVEPOINT t${this.transactionDepth}`);
    }
    this.transactionDepth++;
    try {
      const result = fn();
      if (topLevel) {
        this.db.exec("COMMIT");
      } else {
        this.db.exec(`RELEASE SAVEPOINT t${this.transactionDepth - 1}`);
      }
      return result;
    } catch (err) {
      if (topLevel) {
        this.db.exec("ROLLBACK");
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT t${this.transactionDepth - 1}`);
        this.db.exec(`RELEASE SAVEPOINT t${this.transactionDepth - 1}`);
      }
      throw err;
    } finally {
      this.transactionDepth--;
    }
  }

  rawExec(sql: string, params: unknown[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    // Use run() for non-SELECT statements (INSERT, UPDATE, DELETE, etc.)
    // node:sqlite throws on .all() for non-returning statements
    const trimmed = sql.trimStart().toUpperCase();
    if (
      trimmed.startsWith("INSERT") ||
      trimmed.startsWith("UPDATE") ||
      trimmed.startsWith("DELETE") ||
      trimmed.startsWith("CREATE") ||
      trimmed.startsWith("DROP") ||
      trimmed.startsWith("ALTER") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("BEGIN") ||
      trimmed.startsWith("COMMIT") ||
      trimmed.startsWith("ROLLBACK")
    ) {
      stmt.run(...params);
      return [];
    }
    return stmt.all(...params) as Record<string, unknown>[];
  }

  listTables(): string[] {
    const rows = this.rawExec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      EMPTY_PARAMS,
    );
    return rows.map((r) => r.name as string);
  }

  private getLastInsertRowId(): number {
    const row = this.db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    return row.id;
  }

  // ---- Project CRUD ----

  createProject(opts: { name: string; repoPath: string; baseBranch?: string }): number {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO projects (name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(opts.name, normalizeRepoPath(opts.repoPath), opts.baseBranch ?? null, now, now);
    return this.getLastInsertRowId();
  }

  getProject(id: number): Project | null {
    return (this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project) ?? null;
  }

  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY name").all() as Project[];
  }

  findProjectByRepoPath(repoPath: string): Project | null {
    return (
      (this.db.prepare("SELECT * FROM projects WHERE repo_path = ?").get(normalizeRepoPath(repoPath)) as Project) ??
      null
    );
  }

  findFeatureBySlug(slug: string, projectId: number | undefined): Feature | null {
    if (projectId !== undefined) {
      if (!this._findFeatureBySlugAndProjectStmt) {
        this._findFeatureBySlugAndProjectStmt = this.db.prepare(
          `${FEATURE_SELECT_SQL} WHERE f.slug = ? AND f.project_id = ?`,
        );
      }
      return (this._findFeatureBySlugAndProjectStmt.get(slug, projectId) as Feature) ?? null;
    }
    if (!this._findFeatureBySlugStmt) {
      this._findFeatureBySlugStmt = this.db.prepare(`${FEATURE_SELECT_SQL} WHERE f.slug = ?`);
    }
    return (this._findFeatureBySlugStmt.get(slug) as Feature) ?? null;
  }

  findFeatureById(id: number): Feature | null {
    return (this.db.prepare(`${FEATURE_SELECT_SQL} WHERE f.id = ?`).get(id) as Feature) ?? null;
  }

  /** Find features with null slug in a given project (for design doc linking). */
  findNullSlugFeatures(projectId: number): Feature[] {
    return this.db
      .prepare(`${FEATURE_SELECT_SQL} WHERE f.slug IS NULL AND f.project_id = ?`)
      .all(projectId) as Feature[];
  }

  /** Find features assigned to a specific session. */
  findFeaturesBySession(sessionId: string): Feature[] {
    return this.db.prepare(`${FEATURE_SELECT_SQL} WHERE f.assigned_session = ?`).all(sessionId) as Feature[];
  }

  /** Update the slug on a feature (typically when design doc is written). */
  updateFeatureSlug(featureId: number, slug: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE features SET slug = ?, updated_at = ? WHERE id = ?").run(slug, now, featureId);
  }

  // ---- Feature CRUD ----

  createFeature(opts: {
    projectId: number;
    slug: string;
    title: string;
    description?: string | null;
    lane?: Lane;
    priority?: number;
    designDoc?: string | null;
    planDoc?: string | null;
    stateFile?: string | null;
    assignedSession?: string | null;
  }): number {
    const now = new Date().toISOString();
    const slug = opts.slug || null; // empty string → null
    this.db
      .prepare(
        "INSERT INTO features (slug, project_id, lane, priority, title, description, design_doc, plan_doc, state_file, assigned_session, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        slug,
        opts.projectId,
        opts.lane ?? "backlog",
        opts.priority ?? 0,
        opts.title,
        opts.description ?? null,
        opts.designDoc ?? null,
        opts.planDoc ?? null,
        opts.stateFile ?? null,
        opts.assignedSession ?? null,
        now,
        now,
      );
    return this.getLastInsertRowId();
  }

  getFeature(id: number): Feature | null {
    if (!this._getFeatureStmt) {
      this._getFeatureStmt = this.db.prepare(`${FEATURE_SELECT_SQL} WHERE f.id = ?`);
    }
    return (this._getFeatureStmt.get(id) as Feature) ?? null;
  }

  /** Batch-lookup features by IDs using a single SELECT query. */
  getFeaturesByIds(ids: number[]): Feature[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(`${FEATURE_SELECT_SQL} WHERE f.id IN (${placeholders})`).all(...ids) as Feature[];
  }

  /** Update only the priority of a feature using a cached prepared statement. */
  private _updatePriorityStmt: SqlStatement | null = null;
  private _priorityBoundsStmt: SqlStatement | null = null;
  private _moveUpdateStmt: SqlStatement | null = null;
  private _moveHistoryStmt: SqlStatement | null = null;
  private _heartbeatStmt: SqlStatement | null = null;
  private _getFeatureStmt: SqlStatement | null = null;
  private _findFeatureBySlugStmt: SqlStatement | null = null;
  private _findFeatureBySlugAndProjectStmt: SqlStatement | null = null;
  private _availableFeaturesCache = new Map<string, SqlStatement>();
  updateFeaturePriority(featureId: number, priority: number, now: string | undefined): void {
    if (!this._updatePriorityStmt) {
      this._updatePriorityStmt = this.db.prepare("UPDATE features SET priority = ?, updated_at = ? WHERE id = ?");
    }
    this._updatePriorityStmt.run(priority, now ?? new Date().toISOString(), featureId);
  }

  listFeatures(projectId: number, lane: Lane, doneHideAfterMs: number | undefined): Feature[] {
    if (lane === "done" && doneHideAfterMs && doneHideAfterMs > 0) {
      const cutoff = new Date(Date.now() - doneHideAfterMs).toISOString();
      // NOTE: Column list intentionally mirrors FEATURE_SELECT_SQL (f.*, fl.locked_at,
      // fl.last_heartbeat, fl.session_id as locked_by_session). Keep in sync if base SQL changes.
      // The done-lane query can't use FEATURE_SELECT_SQL directly due to the subquery JOIN.
      return this.db
        .prepare(
          `SELECT f.*, fl.locked_at, fl.last_heartbeat, fl.session_id as locked_by_session
           FROM features f
           LEFT JOIN feature_locks fl ON f.id = fl.feature_id
           LEFT JOIN (
             SELECT feature_id, MAX(created_at) as done_at
             FROM feature_history
             WHERE to_lane = 'done'
             GROUP BY feature_id
           ) fh ON f.id = fh.feature_id
           WHERE f.project_id = ? AND f.lane = 'done'
             AND (fh.done_at IS NULL OR fh.done_at >= ?)
           ORDER BY f.priority DESC`,
        )
        .all(projectId, cutoff) as Feature[];
    }
    return this.db
      .prepare(`${FEATURE_SELECT_SQL} WHERE f.project_id = ? AND f.lane = ? ORDER BY f.priority DESC`)
      .all(projectId, lane) as Feature[];
  }

  listAllFeatures(projectId: number, doneHideAfterMs: number | undefined): Feature[] {
    if (doneHideAfterMs && doneHideAfterMs > 0) {
      const cutoff = new Date(Date.now() - doneHideAfterMs).toISOString();
      return this.db
        .prepare(
          `SELECT f.*, fl.locked_at, fl.last_heartbeat, fl.session_id as locked_by_session
           FROM features f
           LEFT JOIN feature_locks fl ON f.id = fl.feature_id
           LEFT JOIN (
             SELECT feature_id, MAX(created_at) as done_at
             FROM feature_history
             WHERE to_lane = 'done'
             GROUP BY feature_id
           ) fh ON f.id = fh.feature_id
           WHERE f.project_id = ?
             AND (f.lane != 'done' OR fh.done_at IS NULL OR fh.done_at >= ?)
           ORDER BY f.lane, f.priority DESC`,
        )
        .all(projectId, cutoff) as Feature[];
    }
    return this.db
      .prepare(`${FEATURE_SELECT_SQL} WHERE f.project_id = ? ORDER BY f.lane, f.priority DESC`)
      .all(projectId) as Feature[];
  }

  listTags(): { id: number; name: string; color: string | null }[] {
    return this.db.prepare("SELECT * FROM tags ORDER BY name").all() as {
      id: number;
      name: string;
      color: string | null;
    }[];
  }

  createTag(opts: { name: string; color?: string }): number {
    this.db.prepare("INSERT INTO tags (name, color) VALUES (?, ?)").run(opts.name, opts.color ?? null);
    return this.getLastInsertRowId();
  }

  removeTag(tagId: number): void {
    this.db.prepare("DELETE FROM tags WHERE id = ?").run(tagId);
  }

  addFeatureTag(featureId: number, tagId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO feature_tags (feature_id, tag_id) VALUES (?, ?)").run(featureId, tagId);
  }

  removeFeatureTag(featureId: number, tagId: number): void {
    this.db.prepare("DELETE FROM feature_tags WHERE feature_id = ? AND tag_id = ?").run(featureId, tagId);
  }

  listFeatureTags(featureId: number): { id: number; name: string; color: string | null }[] {
    return this.db
      .prepare(
        "SELECT t.id, t.name, t.color FROM tags t INNER JOIN feature_tags ft ON ft.tag_id = t.id WHERE ft.feature_id = ? ORDER BY t.name",
      )
      .all(featureId) as { id: number; name: string; color: string | null }[];
  }

  findAvailableFeatures(projectId: number | undefined, lanes: Lane[]): Feature[] {
    if (lanes.length === 0) return [];
    const placeholders = lanes.map(() => "?").join(", ");
    const params: unknown[] = [...lanes];
    if (projectId !== undefined) {
      params.push(projectId);
    }
    const projectFilter = projectId !== undefined ? " AND f.project_id = ?" : "";
    const sql =
      FEATURE_SELECT_SQL +
      ` WHERE fl.feature_id IS NULL AND f.lane IN (${placeholders})${projectFilter} ORDER BY f.priority DESC`;
    let stmt = this._availableFeaturesCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this._availableFeaturesCache.set(sql, stmt);
    }
    return stmt.all(...params) as Feature[];
  }

  updateFeature(opts: {
    featureId: number;
    title?: string;
    description?: string;
    priority?: number;
    designDoc?: string;
    planDoc?: string;
    stateFile?: string;
    assignedSession?: string | null;
  }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (opts.title !== undefined) {
      sets.push("title = ?");
      params.push(opts.title);
    }
    if (opts.description !== undefined) {
      sets.push("description = ?");
      params.push(opts.description);
    }
    if (opts.designDoc !== undefined) {
      sets.push("design_doc = ?");
      params.push(opts.designDoc);
    }
    if (opts.priority !== undefined) {
      sets.push("priority = ?");
      params.push(opts.priority);
    }
    if (opts.planDoc !== undefined) {
      sets.push("plan_doc = ?");
      params.push(opts.planDoc);
    }
    if (opts.stateFile !== undefined) {
      sets.push("state_file = ?");
      params.push(opts.stateFile);
    }
    if (opts.assignedSession !== undefined) {
      sets.push("assigned_session = ?");
      params.push(opts.assignedSession);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(opts.featureId);
    this.db.prepare(`UPDATE features SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  getLanePriorityBounds(projectId: number, lane: Lane): { min: number | null; max: number | null } {
    if (!this._priorityBoundsStmt) {
      this._priorityBoundsStmt = this.db.prepare(
        "SELECT MIN(priority) as min, MAX(priority) as max FROM features WHERE project_id = ? AND lane = ?",
      );
    }
    const row = this._priorityBoundsStmt.get(projectId, lane) as { min: number | null; max: number | null };
    return { min: row.min, max: row.max };
  }

  /** Compute and assign a priority for a feature using a bounds→priority function. Shared by assignFifoPriority and assignTopPriority: resolves bounds (precomputed or live from lane state), applies the priority fn, updates the feature, and returns the new priority. */
  private assignPriorityByFn(
    featureId: number,
    projectId: number,
    lane: Lane,
    precomputedBounds: { min: number | null; max: number | null } | undefined,
    computePriority: (bounds: { min: number | null; max: number | null }) => number,
  ): number {
    const bounds = precomputedBounds ?? this.getLanePriorityBounds(projectId, lane);
    const priority = computePriority(bounds);
    this.updateFeaturePriority(featureId, priority, NO_NOW);
    return priority;
  }

  /** Assign FIFO priority to a feature: places it below all existing cards in the target lane.
   *  Encapsulates the get-bounds → compute → update pattern used by move, create, and kanbanTake.
   *  @param precomputedBounds Pre-computed bounds (for cross-lane moves, pass bounds BEFORE the move to exclude the moved card). If omitted, computed from current lane state. */
  assignFifoPriority(
    featureId: number,
    projectId: number,
    lane: Lane,
    precomputedBounds: { min: number | null; max: number | null } | undefined,
  ): number {
    return this.assignPriorityByFn(featureId, projectId, lane, precomputedBounds, fifoPriority);
  }

  /** Assign top-of-lane priority to a feature: places it above all existing cards.
   *  @param precomputedBounds Pre-computed bounds (for cross-lane moves, pass bounds BEFORE the move to exclude the moved card). If omitted, computed from current lane state. */
  assignTopPriority(
    featureId: number,
    projectId: number,
    lane: Lane,
    precomputedBounds: { min: number | null; max: number | null } | undefined,
  ): number {
    return this.assignPriorityByFn(featureId, projectId, lane, precomputedBounds, topPriority);
  }

  /** Delete a feature and cascade its related data.
   *  @returns true if the feature was deleted or didn't exist, false if locked. */
  deleteFeature(featureId: number): boolean {
    return this.withTransaction(() => {
      // Check if feature is locked — refuse deletion if locked
      const lock = this.db.prepare("SELECT 1 FROM feature_locks WHERE feature_id = ?").get(featureId);
      if (lock) return false;
      // Clean up orphaned tags (tags with no remaining feature references)
      this.db
        .prepare(
          `DELETE FROM tags WHERE id IN (
            SELECT t.id FROM tags t
            INNER JOIN feature_tags ft ON ft.tag_id = t.id
            WHERE ft.feature_id = ?
            AND t.id NOT IN (
              SELECT ft2.tag_id FROM feature_tags ft2 WHERE ft2.feature_id != ?
            )
          )`,
        )
        .run(featureId, featureId);
      this.db.prepare("DELETE FROM features WHERE id = ?").run(featureId);
      return true;
    });
  }

  // ---- Dependencies ----

  addDependency(opts: { featureId: number; dependsOnId: number; kind: "blocks" | "requires" | "related" }): void {
    this.db
      .prepare("INSERT INTO feature_dependencies (feature_id, depends_on_id, kind) VALUES (?, ?, ?)")
      .run(opts.featureId, opts.dependsOnId, opts.kind);
  }

  private listRelatedFeatures(
    featureId: number,
    whereColumn: string,
  ): { featureId: number; dependsOnId: number; kind: string }[] {
    return (
      this.db
        .prepare(`SELECT feature_id, depends_on_id, kind FROM feature_dependencies WHERE ${whereColumn} = ?`)
        .all(featureId) as Record<string, unknown>[]
    ).map((r) => ({
      featureId: r.feature_id as number,
      dependsOnId: r.depends_on_id as number,
      kind: r.kind as string,
    }));
  }

  listDependencies(featureId: number): { featureId: number; dependsOnId: number; kind: string }[] {
    return this.listRelatedFeatures(featureId, "feature_id");
  }

  listDependents(featureId: number): { featureId: number; dependsOnId: number; kind: string }[] {
    return this.listRelatedFeatures(featureId, "depends_on_id");
  }

  removeDependency(featureId: number, dependsOnId: number): void {
    this.db
      .prepare("DELETE FROM feature_dependencies WHERE feature_id = ? AND depends_on_id = ?")
      .run(featureId, dependsOnId);
  }

  // ---- Lane moves ----

  moveFeature(opts: {
    featureId: number;
    toLane: Lane;
    changedBy: string;
    sessionId?: string;
    note?: string;
    fromLane?: Lane;
  }): void {
    const fromLane =
      opts.fromLane ??
      (() => {
        const feature = this.getFeature(opts.featureId);
        if (!feature) throw new Error(`Feature ${opts.featureId} not found`);
        return feature.lane;
      })();

    const now = new Date().toISOString();
    if (!this._moveUpdateStmt) {
      this._moveUpdateStmt = this.db.prepare("UPDATE features SET lane = ?, updated_at = ? WHERE id = ?");
    }
    this._moveUpdateStmt.run(opts.toLane, now, opts.featureId);
    if (!this._moveHistoryStmt) {
      this._moveHistoryStmt = this.db.prepare(
        "INSERT INTO feature_history (feature_id, from_lane, to_lane, changed_by, session_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
    }
    this._moveHistoryStmt.run(
      opts.featureId,
      fromLane,
      opts.toLane,
      opts.changedBy,
      opts.sessionId ?? null,
      opts.note ?? null,
      now,
    );
  }

  // ---- Lock management ----

  lockFeature(featureId: number, sessionId: string): boolean {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare("INSERT INTO feature_locks (feature_id, session_id, locked_at, last_heartbeat) VALUES (?, ?, ?, ?)")
        .run(featureId, sessionId, now, now);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        return false;
      }
      throw err;
    }
  }

  unlockFeature(featureId: number): void {
    this.db.prepare("DELETE FROM feature_locks WHERE feature_id = ?").run(featureId);
  }

  heartbeat(featureId: number, sessionId: string): void {
    const now = new Date().toISOString();
    if (!this._heartbeatStmt) {
      this._heartbeatStmt = this.db.prepare(
        "UPDATE feature_locks SET last_heartbeat = ? WHERE feature_id = ? AND session_id = ?",
      );
    }
    this._heartbeatStmt.run(now, featureId, sessionId);
  }

  /**
   * Reassign a feature lock from one session to another (transfer ownership).
   * Currently used by /fy:auto-stop to hand an auto-agent lock back to the
   * interactive session (agent UUID → session:<slug>). The inverse takeover
   * (session:<slug> → agent UUID) is performed in tryMatchSessionSlug via
   * unlockFeature()+lockFeature(), not this method.
   * Returns true if the lock existed under fromSessionId and was transferred.
   */
  reassignLock(featureId: number, fromSessionId: string, toSessionId: string): boolean {
    const info = this.db
      .prepare("UPDATE feature_locks SET session_id = ? WHERE feature_id = ? AND session_id = ?")
      .run(toSessionId, featureId, fromSessionId);
    return info.changes > 0;
  }

  /**
   * Delete locks whose heartbeat is older than the cutoff.
   *
   * IMPORTANT: only auto-agent locks (session_id NOT LIKE 'session:%') are swept.
   * Interactive locks (session_id = 'session:<slug>', created on design-doc save,
   * /fy:auto-stop, or manual kanban lock) have no heartbeat and must persist until
   * explicitly released or reassigned — never swept for staleness. Otherwise a
   * user who steps away (or whose pi crashes) could have their feature stolen by
   * an auto-agent.
   */
  cleanupExpiredLocks(timeoutMs: number): number {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    // Single source of truth for the interactive-prefix predicate. INTERACTIVE_SESSION_PREFIX
    // is a controlled internal constant (never user input), so interpolating it into the
    // SQL text is safe and keeps the LIKE pattern in sync with interactiveSessionIdFor().
    const interactivePattern = `${INTERACTIVE_SESSION_PREFIX}%`;
    const result = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM feature_locks WHERE last_heartbeat < ? AND session_id NOT LIKE '${interactivePattern}'`,
      )
      .get(cutoff) as { count: number };
    const count = result.count;
    if (count > 0) {
      this.db
        .prepare(`DELETE FROM feature_locks WHERE last_heartbeat < ? AND session_id NOT LIKE '${interactivePattern}'`)
        .run(cutoff);
    }
    return count;
  }

  // ---- Overlay Status ----

  setOverlayStatus(featureId: number, status: string): boolean {
    const info = this.db
      .prepare("UPDATE features SET overlay_status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), featureId);
    return info.changes > 0;
  }

  clearOverlayStatus(featureId: number): void {
    this.db
      .prepare("UPDATE features SET overlay_status = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), featureId);
  }

  // ---- History ----

  getFeatureHistory(featureId: number): FeatureHistoryEntry[] {
    return this.db
      .prepare("SELECT * FROM feature_history WHERE feature_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(featureId) as FeatureHistoryEntry[];
  }
}

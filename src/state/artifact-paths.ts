// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Artifact directory path constants — single source of truth.
 *
 * Design docs live either IN-REPO (`docs/ff/designs/`, tracked) or OUT of the repo under `.ff/designs/`
 * (the gitignored `.ff/` junction → `~/.pi/feature-flow/artifacts/<key>/`), per the `designDocStorage`
 * setting. Task-plans, research, and reviews always live under `.ff/`. All consumers (feature-state,
 * template-substitution, guardrails, feature-management, phase-progression, review-context) import
 * these to avoid drift.
 *
 * This is a LEAF module (no imports from other extension modules) so it can be imported safely
 * from anywhere without creating circular-dependency cycles (e.g. feature-state ↔ phase-progression).
 * The design-doc directory depends on the `designDocStorage` setting, so it is RESOLVED by callers
 * (which pass the mode in) rather than read here — keeping this module settings-free.
 */

/** Design-doc storage mode (mirrors the `designDocStorage` setting values). */
export type DesignDocStorageMode = "local" | "committed";

/**
 * Directory holding design docs, RELATIVE to the project root, for a given storage mode.
 *
 * - `committed` → `docs/ff/designs/` — in-repo, tracked in git (published with the repo, survives clone).
 * - `local` → `.ff/designs/` — out-of-repo via the gitignored `.ff/` junction (not committed,
 *   survives worktree removal, shared across worktrees of the project).
 *
 * Kept relative so it composes under any project root and resolves identically via git mv,
 * guardrail prefix-checks, and path.resolve. The `.ff/` path resolves through the junction
 * transparently; the guardrails' string-prefix checks match because agents write to this relative
 * path.
 */
export function resolveDesignRelativeDir(mode: DesignDocStorageMode): string {
  return mode === "local" ? ".ff/designs" : "docs/ff/designs";
}

/**
 * Both recognized design-doc directories (relative), in no particular order. Detection/guarding
 * recognize EITHER location so a project can carry docs from both modes (e.g. committed docs from
 * before a switch to local, or vice-versa) without the current `designDocStorage` mode gating which
 * writes count as design-doc writes. New docs are written to {@link resolveDesignRelativeDir} for
 * the active mode (via the skill marker); this list is for read-side detection only.
 */
export const DESIGN_DOC_DIRS: readonly string[] = [
  resolveDesignRelativeDir("local"),
  resolveDesignRelativeDir("committed"),
];
export const FF_TASK_PLANS_DIR = ".ff/task-plans";
export const FF_RESEARCH_DIR = ".ff/research";
export const FF_REVIEWS_DIR = ".ff/reviews";

/** Sentinel for resolveKnownIssuesPath: no per-task scope (design/plan/feature-level review). */
export const NO_TASK_NUM: string | undefined = undefined;

/**
 * Slugify a plan-task designation (which includes its number, e.g. '3. Wire the login form')
 * into a path-safe key used in review/verify/known-issues filenames and the per-task review
 * loop counter. Lowercases, collapses runs of non-alphanumeric chars to a single `-`, trims edges.
 */
export function slugifyTaskDesignation(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve the known-issues file path for a feature, scoped by phase so design and plan
 * review dismissals stay separate from each other and from code-review dismissals.
 *   - "design"      -> {slug}-design-known-issues.md
 *   - "plan"        -> {slug}-plan-known-issues.md
 *   - otherwise     -> per-task ({slug}-task-{taskNameSlug}-known-issues.md) when taskName is active,
 *                      else per-feature ({slug}-known-issues.md)
 * taskName, when active, is the plan-task designation string set by task_ready_advance
 * (slugified here for path safety). phase is a plain string (not the Phase union) to keep this module a dependency-free
 * leaf; callers pass a typed Phase which is assignable to string. Returns null when slug
 * is absent.
 */
export function resolveKnownIssuesPath(
  slug: string | undefined,
  phase: string | undefined,
  taskName: string | undefined,
): string | null {
  if (!slug) return null;
  return phase === "design"
    ? `${FF_REVIEWS_DIR}/${slug}/${slug}-design-known-issues.md`
    : phase === "plan"
      ? `${FF_REVIEWS_DIR}/${slug}/${slug}-plan-known-issues.md`
      : taskName
        ? `${FF_REVIEWS_DIR}/${slug}/${slug}-task-${slugifyTaskDesignation(taskName)}-known-issues.md`
        : `${FF_REVIEWS_DIR}/${slug}/${slug}-known-issues.md`;
}

/**
 * Date-based fallback known-issues path when no feature slug is active.
 * Mirrors the report-path fallback (buildFallbackReportPath) so a manual skill
 * invocation without an active workflow still has a writable file.
 * Single stable file per scope per date (known-issues accumulate), phase-scoped so
 * design/plan/task/review dismissals stay separate:
 *   - "design"      -> {date}/{date}-design-known-issues.md
 *   - "plan"        -> {date}/{date}-plan-known-issues.md
 *   - taskName active-> {date}/{date}-task-{taskNameSlug}-known-issues.md
 *   - otherwise     -> {date}/{date}-review-known-issues.md
 * date is a yyyy-mm-dd string passed in to keep this a dependency-free leaf module.
 */
export function buildFallbackKnownIssuesPath(
  date: string,
  phase: string | undefined,
  taskName: string | undefined,
): string {
  const suffix =
    phase === "design"
      ? "design-known-issues"
      : phase === "plan"
        ? "plan-known-issues"
        : taskName
          ? `task-${slugifyTaskDesignation(taskName)}-known-issues`
          : "review-known-issues";
  return `${FF_REVIEWS_DIR}/${date}/${date}-${suffix}.md`;
}

/** Regex special characters that need escaping in filename patterns. */
const REGEX_SPECIAL_CHARS = /[.+?^${}()|[\]\\]/g;

/** Sanitize a string for use in filenames: strip path separators, traversal, and unsafe chars. */
function sanitizeForFilename(value: string): string {
  return value
    .replace(/\.\./g, "") // path traversal
    .replace(/[\\/]/g, "-") // path separators
    .replace(/[^a-zA-Z0-9._-]/g, "") // keep only filename-safe chars
    .replace(/--+/g, "-") // collapse repeated hyphens
    .replace(/^-|-$/g, ""); // strip leading/trailing hyphens
}

/**
 * Build a report file path with the standard naming convention.
 * The slug already includes the date prefix (e.g. "2026-05-18-session-todo"),
 * so the filename uses the slug directly without a separate date prefix.
 *
 * Scans the slug directory for existing numbered files and picks
 * max(loopNumber, nextAvailable) to prevent overwrites when the in-memory
 * counter is out of sync (manual skill dispatch, session restart, etc).
 *
 * @param _fs - Optional filesystem mock for testing.
 */
export function buildReportFilePath(
  slug: string,
  prefix: string,
  loopNumber: number | null, // no-optional-params: null = no loop suffix, number = include suffix
  _fs: typeof import("node:fs"),
): string {
  const safeSlug = sanitizeForFilename(slug);
  const safePrefix = sanitizeForFilename(prefix);
  const dir = `${FF_REVIEWS_DIR}/${safeSlug}`;

  // Scan for existing files matching {slug}-{prefix}-{N}.md
  const escapedSlug = safeSlug.replace(REGEX_SPECIAL_CHARS, "\\$&");
  const escapedPrefix = safePrefix.replace(REGEX_SPECIAL_CHARS, "\\$&");
  const pattern = new RegExp(`^${escapedSlug}-${escapedPrefix}-(\\d+)\\.md$`);

  let maxExisting = -1; // -1 means no numbered file exists yet
  try {
    if (_fs.existsSync(dir)) {
      for (const entry of _fs.readdirSync(dir)) {
        const match = entry.match(pattern);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > maxExisting) maxExisting = n;
        }
      }
    }
  } catch {
    // directory might not exist yet — that's fine
  }

  const nextFromFs = maxExisting + 1; // 0 if no files exist (maxExisting = -1)

  if (loopNumber != null) {
    const effectiveLoop = Math.max(loopNumber, nextFromFs);
    return `${dir}/${safeSlug}-${safePrefix}-${effectiveLoop}.md`;
  }

  // loopNumber undefined: only add suffix if files already exist (avoid collision)
  if (nextFromFs > 0) {
    return `${dir}/${safeSlug}-${safePrefix}-${nextFromFs}.md`;
  }
  return `${dir}/${safeSlug}-${safePrefix}.md`;
}

/**
 * Build a date-based fallback report path when no slug/feature is active.
 * Scans {FF_REVIEWS_DIR}/{date}/ for existing files matching {date}-{topic}-{agentName}-{N}.md,
 * finds the highest N for this topic+agentName combo, and returns the next available path.
 * Creates the date subdirectory if it doesn't exist.
 */
export function buildFallbackReportPath(
  date: string,
  topic: string,
  agentName: string | undefined,
  _fs: typeof import("node:fs"),
): string {
  const reviewsDir = FF_REVIEWS_DIR;
  const dateDir = `${reviewsDir}/${date}`;
  const safeTopic = sanitizeForFilename(topic) || "review";
  const safeAgent = agentName ? sanitizeForFilename(agentName) : undefined;
  const escapedDate = date.replace(/-/g, "\\-");
  const escapedTopic = safeTopic.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const agentSuffix = safeAgent ? `-${safeAgent.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}` : "";
  const pattern = new RegExp(`^${escapedDate}-${escapedTopic}${agentSuffix}-(\\d+)\\.md$`);

  let maxN = 0;
  try {
    if (_fs.existsSync(dateDir)) {
      for (const entry of _fs.readdirSync(dateDir)) {
        const match = entry.match(pattern);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > maxN) maxN = n;
        }
      }
    }
  } catch {
    // If filesystem access fails, start from 1
  }
  // Ensure the directory exists (mkdirSync with recursive is a no-op if it already exists)
  _fs.mkdirSync(dateDir, { recursive: true });

  return `${dateDir}/${date}-${safeTopic}${agentSuffix}-${maxN + 1}.md`;
}

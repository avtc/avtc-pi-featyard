// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { log, NO_ERROR } from "../log.js";
import {
  fifoPriority,
  type KanbanDatabase,
  NO_DONE_HIDE_AFTER_MS,
  PRIORITY_SPACING,
  topPriority,
} from "./data/kanban-database.js";
import { type Feature, isLane, LANE_ORDER, type Lane, type Project } from "./data/kanban-types.js";

/** Validate a position parameter ("top" | "bottom" | undefined).
 *  Returns an error string if invalid, or null if valid.
 *  When `required` is true, undefined is also invalid. */
/** Position is optional (not required) */
const OPTIONAL_POSITION = false;

function validatePosition(position: unknown, required: boolean): string | null {
  if (position === undefined) return required ? "position is required" : null;
  if (position !== "top" && position !== "bottom") return "position must be 'top' or 'bottom'";
  return null;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
};

/** Session identifier for all web UI operations (locks, moves, etc.). */
const WEB_UI_SESSION = "web-ui";

/** Timeout for each per-row LLM title generation call in the batch import endpoint. */
const PER_ROW_LLM_TIMEOUT_MS = 60_000;

/** Max characters sent to the LLM for title generation — longer descriptions are truncated. */
const MAX_LLM_DESCRIPTION_LENGTH = 2000;

/** Max request body size for the batch import endpoint (10 MB). */
const MAX_BATCH_BODY_SIZE = 10 * (1 << 20);

/** Max number of rows per batch import request. */
const MAX_BATCH_ROWS = 500;

const FEATURE_ID_RE = /^\/api\/features\/(\d+)$/;
const FEATURE_MOVE_RE = /^\/api\/features\/(\d+)\/move$/;
const FEATURE_RELEASE_RE = /^\/api\/features\/(\d+)\/release$/;
const FEATURE_LOCK_RE = /^\/api\/features\/(\d+)\/lock$/;
const FEATURE_HISTORY_RE = /^\/api\/features\/(\d+)\/history$/;
const BOARD_EXPORT_RE = /^\/api\/board\/(\d+)\/export$/;
const BOARD_RE = /^\/api\/board\/(\d+)$/;
const PROJECT_FEATURES_RE = /^\/api\/projects\/(\d+)\/features$/;

/** Per-endpoint rate limiting for expensive (LLM-invoking) routes. */
const RATE_LIMITS: Record<string, { maxRequests: number; windowMs: number }> = {
  "/api/generate-title": { maxRequests: 10, windowMs: 60_000 }, // 10 title generations per minute
  "/api/features/batch": { maxRequests: 5, windowMs: 60_000 }, // 5 batch imports per minute
};
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(pathname: string): boolean {
  const limit = RATE_LIMITS[pathname];
  if (!limit) return true; // no limit configured
  const now = Date.now();
  let bucket = rateLimitBuckets.get(pathname);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 1, resetAt: now + limit.windowMs };
    rateLimitBuckets.set(pathname, bucket);
    return true;
  }
  if (bucket.count >= limit.maxRequests) return false;
  bucket.count++;
  return true;
}

/** Reset rate limit buckets (for testing). */
export function resetRateLimits(): void {
  rateLimitBuckets.clear();
}

/*
 * V1 REST API endpoints (implemented):
 *   GET    /api/projects          — List all projects
 *   POST   /api/features          — Create feature
 *   GET    /api/features/:id      — Get feature by ID
 *   DELETE /api/features/:id      — Delete feature
 *   POST   /api/features/reorder   — Reorder features within a lane (locked features silently skipped)
 *   POST   /api/features/:id/move — Move feature to lane
 *   GET    /api/features/:id/history — Get feature history
 *   GET    /api/board/:projectId  — Get full board state
 *
 * V2 scope (not yet implemented):
 *   GET    /api/tags              — List tags
 *   POST   /api/tags              — Create tag
 *   GET    /api/projects/:id      — Get project by ID
 *   PUT    /api/features/:id      — Update feature (title, description, priority)
 */

export interface ServerOptions {
  doneHideAfterMs?: number | null;
  generateTitle?: (description: string, signal?: AbortSignal) => Promise<string>;
  /** Directory to persist server metadata (auth token). When provided, the auth token is written to `{dataDir}/auth_token.txt`. */
  dataDir?: string;
}

/**
 * Inject the auth token into HTML content so the SPA frontend can authenticate API calls.
 */
function injectAuthToken(html: Buffer, token: string): Buffer {
  return Buffer.from(
    html
      .toString("utf-8")
      .replace("</head>", `<script>window.__KANBAN_AUTH_TOKEN = ${JSON.stringify(token)};</script></head>`),
  );
}

/** Quote a single CSV field per RFC 4180, with formula injection defense. */
export function csvQuote(value: string | null | undefined): string {
  if (value == null) return "";
  // Defend against CSV formula injection: prefix dangerous leading chars with '
  const dangerous = /^[=+@\t\r -]/;
  let v = value;
  if (dangerous.test(v)) {
    v = `'${v}`;
  }
  if (/[,"\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** Generate a slug in {YYYY-MM-DD}-{feature} format. */
export function generateSlug(title: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const feature =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled";
  return `${date}-${feature}`;
}

/** Generate a CSV string from headers and rows. */
export function generateCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(row.map(csvQuote).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export async function createServer(
  db: KanbanDatabase,
  port: number,
  staticDir: string | null,
  opts: ServerOptions | null,
): Promise<{ server: Server; port: number; authToken: string }> {
  const authToken = randomBytes(32).toString("hex");
  const server = createHttpServer((req, res) => {
    handleRequest(req, res, db, staticDir, authToken, opts).catch((err) => {
      log.error(`[kanban-server] unhandled error: ${err}`, NO_ERROR);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Internal server error" }));
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "localhost", async () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      // Persist auth token so other sessions can connect to this server
      if (opts?.dataDir) {
        try {
          await writeFile(join(opts.dataDir, "auth_token.txt"), authToken, {
            encoding: "utf-8",
            mode: 0o600,
          });
        } catch (err) {
          log.warn(`[kanban-server] failed to write auth token: ${err}`);
        }
      }
      resolve({ server, port: actualPort, authToken });
    });
  });
}

function validateAuthToken(req: IncomingMessage, authToken: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const token = match[1];
  if (token.length !== authToken.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(authToken));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: KanbanDatabase,
  staticDir: string | null | undefined,
  authToken: string,
  opts: ServerOptions | null,
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // Defense-in-depth security headers for all responses
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  );

  // API routes — require bearer token
  if (pathname.startsWith("/api/")) {
    if (!validateAuthToken(req, authToken)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    await handleApiRoute(req, res, db, pathname, opts);
    return;
  }

  // Static files (SPA)
  if (staticDir) {
    const resolvedStaticDir = resolve(staticDir);
    // Strip leading slash so resolve treats path as relative to staticDir
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = resolve(resolvedStaticDir, relativePath);
    // Path traversal protection: ensure resolved path stays within staticDir
    // Normalize separators for cross-platform comparison
    const normalizedStatic = resolvedStaticDir.replace(/\\/g, "/");
    const normalizedFile = filePath.replace(/\\/g, "/");
    if (!normalizedFile.startsWith(`${normalizedStatic}/`) && normalizedFile !== normalizedStatic) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    try {
      let content: Buffer = await readFile(filePath);
      const mime = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
      res.setHeader("Content-Type", mime);
      // Inject auth token into HTML for SPA
      if (filePath.endsWith("index.html")) {
        content = injectAuthToken(content, authToken);
      }
      res.end(content);
    } catch {
      // SPA fallback: serve index.html for unknown routes
      try {
        let indexContent: Buffer = await readFile(join(staticDir, "index.html"));
        indexContent = injectAuthToken(indexContent, authToken);
        res.setHeader("Content-Type", "text/html");
        res.end(indexContent);
      } catch {
        res.statusCode = 404;
        res.end("Not found");
      }
    }
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
}

/** Handle POST /api/features/reorder — reorder features within a lane.
 *  Locked features are silently skipped and their positions are not preserved. */
async function handleReorderRequest(req: IncomingMessage, res: ServerResponse, db: KanbanDatabase) {
  const parsed = await parseJsonBody<{ featureIds: number[]; projectId: number; lane: string }>(
    req,
    res,
    NO_MAX_BODY_SIZE,
  );
  if (!parsed) return;
  const { featureIds, projectId, lane } = parsed;
  if (!lane || !isLane(lane)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: lane ? `lane must be one of: ${LANE_ORDER.join(", ")}` : "lane is required" }));
    return;
  }
  if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "projectId must be a positive integer" }));
    return;
  }
  if (!Array.isArray(featureIds) || featureIds.length === 0) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "featureIds must be a non-empty array" }));
    return;
  }
  if (featureIds.length > 1000) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "featureIds must not exceed 1000 items" }));
    return;
  }
  for (const id of featureIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "each featureId must be a positive integer" }));
      return;
    }
  }

  // Look up, validate, filter, and re-prioritize — all inside one transaction
  const reorderedIds: number[] = [];
  const skippedIds: number[] = [];

  db.runInTransaction(() => {
    // Batch-lookup all features in one query (instead of N individual getFeature calls)
    const uniqueIds = [...new Set(featureIds)];
    const features = db.getFeaturesByIds(uniqueIds);
    const featureMap = new Map(features.map((f) => [f.id, f]));
    const seenIds = new Set<number>();

    for (const id of featureIds) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const feature = featureMap.get(id);
      if (!feature || feature.project_id !== projectId) {
        skippedIds.push(id);
      } else if (feature.lane !== lane || feature.locked_at) {
        skippedIds.push(feature.id);
      } else {
        reorderedIds.push(feature.id);
      }
    }

    // Assign priorities using cached prepared statement
    // Spec: 0 or 1 cards → silent no-op, no DB writes
    if (reorderedIds.length <= 1) {
      reorderedIds.length = 0; // Clear so response reflects no-op
      return;
    }
    const now = new Date().toISOString();
    for (let i = 0; i < reorderedIds.length; i++) {
      const priority = (reorderedIds.length - i) * PRIORITY_SPACING;
      db.updateFeaturePriority(reorderedIds[i], priority, now);
    }
  });

  res.end(JSON.stringify({ ok: true, reordered: reorderedIds.length, reorderedIds, skippedIds }));
}

async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  db: KanbanDatabase,
  pathname: string,
  opts: ServerOptions | null,
) {
  const doneHideAfterMs = opts?.doneHideAfterMs ?? null;
  res.setHeader("Content-Type", "application/json");
  const method = req.method ?? "GET";

  // Rate-limit expensive (LLM-invoking) endpoints
  if (!checkRateLimit(pathname)) {
    res.statusCode = 429;
    res.end(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }));
    return;
  }

  // POST /api/generate-title
  if (pathname === "/api/generate-title" && method === "POST") {
    if (!opts?.generateTitle) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "AI-powered title generation requires an active pi session" }));
      return;
    }
    const parsed = await parseJsonBody<{ description: string }>(req, res, NO_MAX_BODY_SIZE);
    if (!parsed) return;
    if (typeof parsed.description !== "string" || parsed.description.trim().length === 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "description must be a non-empty string" }));
      return;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PER_ROW_LLM_TIMEOUT_MS);
      let title: string;
      try {
        title = await opts.generateTitle(parsed.description.slice(0, MAX_LLM_DESCRIPTION_LENGTH), controller.signal);
      } finally {
        clearTimeout(timeout);
      }
      res.end(JSON.stringify({ title }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[kanban-server] generate-title failed: ${message}`, NO_ERROR);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Title generation failed" }));
    }
    return;
  }

  // GET /api/projects
  if (pathname === "/api/projects" && method === "GET") {
    const projects = db.listProjects();
    res.end(JSON.stringify(projects));
    return;
  }

  // POST /api/features
  if (pathname === "/api/features" && method === "POST") {
    const parsed = await parseJsonBody<Record<string, unknown>>(req, res, NO_MAX_BODY_SIZE);
    if (!parsed) return;
    const { projectId, slug, title, lane, description, priority, position } = parsed;
    if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "projectId must be a positive integer" }));
      return;
    }
    if (slug !== undefined && slug !== null && typeof slug !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "slug must be a string or null" }));
      return;
    }
    if (typeof title !== "string" || title.length === 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "title must be a non-empty string" }));
      return;
    }
    if (lane !== undefined && (typeof lane !== "string" || !isLane(lane))) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `lane must be one of: ${LANE_ORDER.join(", ")}` }));
      return;
    }
    // Validate description type
    if (description !== undefined && description !== null && typeof description !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "description must be a string or null" }));
      return;
    }
    // Validate provided slug is safe: lowercase alphanumeric and hyphens only, no path traversal
    // Empty string is treated as null (auto-generate) downstream
    const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
    if (slug !== undefined && slug !== null && slug !== "") {
      if (!SLUG_RE.test(slug)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "slug must contain only lowercase alphanumeric characters and hyphens" }));
        return;
      }
    }
    // Auto-generate slug from title if not provided
    const resolvedSlug = slug ?? generateSlug(title);
    // Resolve priority from position parameter
    let resolvedPriority: number;
    if (position !== undefined) {
      const posErr = validatePosition(position, OPTIONAL_POSITION);
      if (posErr) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: posErr }));
        return;
      }
      const resolvedLane: Lane = lane ?? "backlog";
      const bounds = db.getLanePriorityBounds(projectId, resolvedLane);
      if (position === "top") {
        resolvedPriority = topPriority(bounds);
      } else {
        resolvedPriority = fifoPriority(bounds);
      }
    } else {
      resolvedPriority = typeof priority === "number" ? priority : 0;
    }
    try {
      const id = db.createFeature({
        projectId,
        slug: resolvedSlug,
        title,
        lane: lane ?? "backlog",
        description: description as string | null | undefined,
        priority: resolvedPriority,
      });
      const feature = db.getFeature(id);
      res.statusCode = 201;
      res.end(JSON.stringify(feature));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[kanban-server] createFeature failed: ${message}`, NO_ERROR);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Failed to create feature" }));
    }
    return;
  }

  // POST /api/features/batch
  if (pathname === "/api/features/batch" && method === "POST") {
    if (!opts?.generateTitle) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "AI-powered import requires an active pi session" }));
      return;
    }
    const parsed = await parseJsonBody<{ projectId: number; rows: { description: string }[] }>(
      req,
      res,
      MAX_BATCH_BODY_SIZE,
    );
    if (!parsed) return;
    if (typeof parsed.projectId !== "number" || !Number.isInteger(parsed.projectId) || parsed.projectId <= 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "projectId must be a positive integer" }));
      return;
    }
    if (!Array.isArray(parsed.rows)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "rows must be an array" }));
      return;
    }
    if (parsed.rows.length > MAX_BATCH_ROWS) {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: `Too many rows (max ${MAX_BATCH_ROWS})` }));
      return;
    }

    const imported: Feature[] = [];
    const skipped: { row: number; description: string; reason: string }[] = [];

    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      if (
        !row ||
        typeof row !== "object" ||
        typeof row.description !== "string" ||
        row.description.trim().length === 0
      ) {
        const desc =
          row && typeof row === "object" && typeof row.description === "string" ? row.description : String(row ?? "");
        skipped.push({ row: i + 1, description: desc, reason: "Empty description" });
        continue;
      }
      let title: string;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PER_ROW_LLM_TIMEOUT_MS);
        try {
          title = await opts.generateTitle(row.description.slice(0, MAX_LLM_DESCRIPTION_LENGTH), controller.signal);
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        if (err instanceof Error) {
          log.error(`[batch] Row ${i + 1} title generation failed: ${err.message}`, NO_ERROR);
        }
        skipped.push({ row: i + 1, description: row.description, reason: "Title generation failed" });
        continue;
      }
      try {
        const slug = generateSlug(title);
        // Handle slug collision with retry
        let finalSlug = slug;
        for (let attempt = 0; attempt <= 10; attempt++) {
          try {
            const id = db.createFeature({
              projectId: parsed.projectId,
              slug: finalSlug,
              title,
              description: row.description,
              lane: "backlog",
              priority: 0,
            });
            const feature = db.getFeature(id);
            if (feature) imported.push(feature);
            break;
          } catch (e) {
            if (attempt < 10 && e instanceof Error && e.message.includes("UNIQUE")) {
              finalSlug = `${slug}-${attempt + 1}`;
            } else if (attempt >= 10) {
              skipped.push({ row: i + 1, description: row.description, reason: "Slug collision after 10 retries" });
              break;
            } else {
              throw e;
            }
          }
        }
      } catch (err) {
        if (err instanceof Error) {
          log.error(`[batch] Row ${i + 1} database error: ${err.message}`, NO_ERROR);
        }
        skipped.push({ row: i + 1, description: row.description, reason: "Database error" });
      }
    }

    res.end(
      JSON.stringify({
        imported: imported.length,
        skipped: skipped.length,
        skippedRows: skipped,
        features: imported,
      }),
    );
    return;
  }

  // POST /api/features/reorder
  if (pathname === "/api/features/reorder" && method === "POST") {
    return handleReorderRequest(req, res, db);
  }

  // GET /api/features/:id
  const featureMatch = pathname.match(FEATURE_ID_RE);
  if (featureMatch && method === "GET") {
    const id = Number(featureMatch[1]);
    const feature = db.getFeature(id);
    if (!feature) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Feature not found" }));
      return;
    }
    res.end(JSON.stringify(feature));
    return;
  }

  // POST /api/features/:id/move
  const moveMatch = pathname.match(FEATURE_MOVE_RE);
  if (moveMatch && method === "POST") {
    const id = Number(moveMatch[1]);
    const parsed = await parseJsonBody<{ toLane?: string; changedBy?: string; note?: string; position?: string }>(
      req,
      res,
      null,
    );
    if (!parsed) return;
    const { toLane, changedBy, note, position } = parsed;
    if (!isLane(toLane)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid toLane" }));
      return;
    }
    if (changedBy !== undefined && typeof changedBy !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "changedBy must be a string" }));
      return;
    }
    if (note !== undefined && typeof note !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "note must be a string" }));
      return;
    }
    const posErr = validatePosition(position, OPTIONAL_POSITION);
    if (posErr) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: posErr }));
      return;
    }
    // Get feature before move to capture fromLane and slug
    const featureBefore = db.getFeature(id);
    if (!featureBefore) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Feature not found" }));
      return;
    }
    const fromLane = featureBefore.lane;
    // Same-lane moves: reject if position specified (use reorder endpoint),
    // otherwise return feature as-is (no-op)
    if (fromLane === toLane) {
      if (position !== undefined) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Cannot specify position for same-lane move; use the reorder endpoint" }));
        return;
      }
      res.end(JSON.stringify(featureBefore));
      return;
    }
    db.runInTransaction(() => {
      // Get bounds BEFORE move so the moved card's own priority isn't included
      const targetBounds = fromLane !== toLane ? db.getLanePriorityBounds(featureBefore.project_id, toLane) : null;
      db.moveFeature({ featureId: id, toLane, changedBy: changedBy ?? "api", note, fromLane });
      // Assign priority in target lane for cross-lane moves
      if (targetBounds) {
        if (position === "top") {
          db.assignTopPriority(id, featureBefore.project_id, toLane, targetBounds);
        } else {
          db.assignFifoPriority(id, featureBefore.project_id, toLane, targetBounds);
        }
      }
    });
    const feature = db.getFeature(id);
    res.end(JSON.stringify(feature));
    return;
  }

  // POST /api/features/:id/release
  const releaseMatch = pathname.match(FEATURE_RELEASE_RE);
  if (releaseMatch && method === "POST") {
    const id = Number(releaseMatch[1]);
    const feature = db.getFeature(id);
    if (!feature) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Feature not found" }));
      return;
    }
    if (!feature.locked_at) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "Feature is not locked" }));
      return;
    }
    db.unlockFeature(id);
    const updated = db.getFeature(id);
    res.end(JSON.stringify(updated));
    return;
  }

  // POST /api/features/:id/lock
  const lockMatch = pathname.match(FEATURE_LOCK_RE);
  if (lockMatch && method === "POST") {
    const id = Number(lockMatch[1]);
    const feature = db.getFeature(id);
    if (!feature) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Feature not found" }));
      return;
    }
    if (feature.locked_at) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "Feature is already locked" }));
      return;
    }
    const sessionId = WEB_UI_SESSION;
    const locked = db.lockFeature(id, sessionId);
    if (!locked) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "Failed to acquire lock" }));
      return;
    }
    const updated = db.getFeature(id);
    res.end(JSON.stringify(updated));
    return;
  }

  // DELETE /api/features/:id
  const deleteMatch = pathname.match(FEATURE_ID_RE);
  if (deleteMatch && method === "DELETE") {
    const id = Number(deleteMatch[1]);
    const feature = db.getFeature(id);
    if (!feature) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Feature not found" }));
      return;
    }
    const deleted = db.deleteFeature(id);
    if (!deleted) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "Feature is locked. Release the lock first." }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // PATCH /api/features/:id
  const patchMatch = pathname.match(FEATURE_ID_RE);
  if (patchMatch && method === "PATCH") {
    const id = Number(patchMatch[1]);
    const feature = db.getFeature(id);
    if (!feature) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Feature not found" }));
      return;
    }
    const parsed = await parseJsonBody<{ title?: string; description?: string; priority?: number }>(
      req,
      res,
      NO_MAX_BODY_SIZE,
    );
    if (!parsed) return;
    // Validate input types
    if (parsed.title !== undefined && (typeof parsed.title !== "string" || parsed.title.length === 0)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "title must be a non-empty string" }));
      return;
    }
    if (parsed.description !== undefined && parsed.description !== null && typeof parsed.description !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "description must be a string or null" }));
      return;
    }
    if (parsed.priority !== undefined && (typeof parsed.priority !== "number" || !Number.isInteger(parsed.priority))) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "priority must be an integer" }));
      return;
    }
    db.updateFeature({ featureId: id, ...parsed });
    const updated = db.getFeature(id);
    res.end(JSON.stringify(updated));
    return;
  }

  // GET /api/features/:id/history
  const historyMatch = pathname.match(FEATURE_HISTORY_RE);
  if (historyMatch && method === "GET") {
    const id = Number(historyMatch[1]);
    const history = db.getFeatureHistory(id);
    res.end(JSON.stringify(history));
    return;
  }

  // GET /api/board/:projectId/export
  const exportMatch = pathname.match(BOARD_EXPORT_RE);
  if (exportMatch && method === "GET") {
    const projectId = Number(exportMatch[1]);
    const urlObj = new URL(req.url ?? "/", "http://localhost");
    const lanesParam = urlObj.searchParams.get("lanes");
    const requestedLanes = lanesParam ? lanesParam.split(",").filter(isLane) : [...LANE_ORDER];

    if (requestedLanes.length === 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "No valid lanes specified" }));
      return;
    }

    // Get project name for filename
    const projects = db.listProjects();
    const project = projects.find((p: Project) => p.id === projectId);
    const projectName = (project ? project.name.replace(/[^a-zA-Z0-9-]/g, "_") : "unknown").slice(0, 100);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `kanban-${projectName}-${date}.csv`;

    const headers = ["Title", "Description", "Lane", "Priority", "Slug", "Created", "Updated"];
    const rows: string[][] = [];
    for (const lane of requestedLanes) {
      const features = db.listFeatures(projectId, lane, doneHideAfterMs ?? NO_DONE_HIDE_AFTER_MS);
      for (const f of features) {
        rows.push([f.title, f.description ?? "", f.lane, String(f.priority), f.slug ?? "", f.created_at, f.updated_at]);
      }
    }

    const csv = generateCsv(headers, rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(csv);
    return;
  }

  // GET /api/board/:projectId
  const boardMatch = pathname.match(BOARD_RE);
  if (boardMatch && method === "GET") {
    const projectId = Number(boardMatch[1]);
    const allFeatures = db.listAllFeatures(projectId, doneHideAfterMs ?? NO_DONE_HIDE_AFTER_MS);
    const board: Record<string, Feature[]> = {};
    for (const lane of LANE_ORDER) {
      board[lane] = allFeatures.filter((f) => f.lane === lane);
    }
    res.end(JSON.stringify(board));
    return;
  }

  // GET /api/tags
  if (pathname === "/api/tags" && method === "GET") {
    const tags = db.listTags();
    res.end(JSON.stringify(tags));
    return;
  }

  // GET /api/projects/:id/features
  const projectFeaturesMatch = pathname.match(PROJECT_FEATURES_RE);
  if (projectFeaturesMatch && method === "GET") {
    const projectId = Number(projectFeaturesMatch[1]);
    const features = db.listAllFeatures(projectId, NO_DONE_HIDE_AFTER_MS);
    res.end(JSON.stringify(features));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
}

const MAX_BODY_SIZE = 1 << 20; // 1 MB

export function readBody(req: IncomingMessage, maxSize: number | null): Promise<string> {
  const limit = maxSize ?? MAX_BODY_SIZE;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return; // drain remaining data without buffering
      totalSize += chunk.length;
      if (totalSize > limit) {
        tooLarge = true;
        // Stop receiving data — the handler will send 413 and close the connection
        req.removeAllListeners("data");
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return; // already rejected
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", reject);
  });
}

/** Pass as `maxSize` when no body size limit is needed. */
const NO_MAX_BODY_SIZE: number | null = null;

/** Parse JSON request body with standard error handling for 413/400 responses. */
async function parseJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  res: ServerResponse,
  maxSize: number | null,
): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req, maxSize)) as T;
  } catch (err) {
    if (err instanceof Error && err.message === "Request body too large") {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "Request body too large" }));
    } else {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
    return null;
  }
}

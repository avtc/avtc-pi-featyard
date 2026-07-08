// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Register kanban UI commands (/ff:kanban, /ff:kanban-release) + the shared kanban
 * HTTP server management + agent-lookup helpers shared by the auto-agent loop.
 * The add_to_backlog tool lives separately in tools/add-to-backlog.ts.
 */

import type { Server } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KanbanDatabase } from "../kanban/data/kanban-database.js";
import type { KanbanContext } from "../kanban/kanban-context.js";
import { createGenerateTitleCallback } from "../kanban/kanban-generate-title.js";
import { createServer } from "../kanban/kanban-server.js";
import { log } from "../log.js";
import { DEFAULT_GLOBAL_DIR, getSettings, loadFeatureFlowConfig, NO_CWD_OVERRIDE } from "../settings/settings-ui.js";

/** AutoAgentStateMachine (type-only alias to avoid repeating the inline import across findAgent* helpers). */
type AutoAgent = import("../kanban/auto-agent/auto-agent-state-machine.js").AutoAgentStateMachine;
/** Result shape of findAgentForSlug / findAgentByStates: a matched state machine + its kanban feature id, or null. */
type AutoAgentMatch = { sm: AutoAgent; featureId: number } | null;

/** Shared server instance — module-level for same-factory access. */
let _sharedServer: { server: Server; port: number; authToken: string } | null = null;

/** Get the shared server info. */
export function getSharedServer(): { server: Server; port: number; authToken: string } | null {
  return _sharedServer;
}

/** Set the shared server info. */
export function setSharedServer(info: { server: Server; port: number; authToken: string } | null): void {
  _sharedServer = info;
}

/** Sentinel for setSharedServer() — tear down / clear the shared server reference. */
export const NO_SHARED_SERVER: { server: Server; port: number; authToken: string } | null = null;

/** Returns true if the error is an EADDRINUSE (port already in use) error. */
function isAddressInUseError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as Record<string, unknown>).code;
    if (code === "EADDRINUSE") return true;
  }
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string" && message.includes("EADDRINUSE")) return true;
  }
  return false;
}

/**
 * When the kanban server port is already in use, try to connect to the
 * existing server by reading the persisted auth token and verifying it's alive.
 * Returns true on success (shared server is set), false on failure (user notified).
 */
async function tryConnectToExistingServer(
  dataDir: string,
  port: number,
  notify: (msg: string, level: "info" | "warning" | "error") => void,
): Promise<boolean> {
  log.info(`[kanban] port ${port} already in use, attempting to connect to existing server`);
  const tokenFile = join(dataDir, "auth_token.txt");
  const fs = await import("node:fs");

  // Read auth token
  if (!fs.existsSync(tokenFile)) {
    notify(
      `Kanban server on port ${port} is running but has no auth token (likely started before multi-project support). ` +
        `Please restart the other pi session so it writes the token, or kill the process on port ${port} and retry.`,
      "error",
    );
    return false;
  }
  let savedToken: string;
  try {
    savedToken = fs.readFileSync(tokenFile, "utf-8").trim();
  } catch (err) {
    log.warn(`[kanban] failed to read auth token: ${err}`);
    notify(`Failed to connect to existing kanban server: ${err}`, "error");
    return false;
  }

  // Verify server is alive (5s timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await globalThis
      .fetch(`http://localhost:${port}/api/projects`, {
        headers: { Authorization: `Bearer ${savedToken}` },
        signal: controller.signal,
      })
      .finally(() => clearTimeout(timeout));

    if (!res.ok) {
      notify(`Kanban server on port ${port} is not responding. Try stopping the other session first.`, "error");
      return false;
    }

    setSharedServer({ server: { close: () => {} } as unknown as Server, port, authToken: savedToken });
    log.info(`[kanban] connected to existing kanban server on port ${port}`);
    notify(`Connected to existing kanban server on port ${port}`, "info");
    return true;
  } catch {
    notify(`Kanban server on port ${port} is not reachable. Try stopping the other session first.`, "error");
    return false;
  }
}

/** Register the kanban UI slash commands (/ff:kanban, /ff:kanban-release). */
export function registerKanbanCommands(pi: ExtensionAPI, ctx: KanbanContext): void {
  const { getDatabase, getTools } = ctx;

  // Register /ff:kanban command
  pi.registerCommand("ff:kanban", {
    description: "Open kanban board in browser (starts HTTP server if needed)",
    async handler(_args, cmdCtx) {
      const database = await getDatabase();
      const config = loadFeatureFlowConfig(DEFAULT_GLOBAL_DIR, NO_CWD_OVERRIDE);
      const desiredPort = config["kanban-port"] ?? 0;
      const dataDir = join(homedir(), ".pi", "feature-flow", "kanban");
      const staticDir = join(__dirname, "../kanban/kanban-board-ui");

      if (!getSharedServer()) {
        try {
          setSharedServer(
            await createServer(database, desiredPort, staticDir, {
              doneHideAfterMs: getSettings().kanbanDoneHideAfterMs ?? null,
              generateTitle: await createGenerateTitleCallback(
                () => ctx.capturedModelRef.model,
                () => ctx.capturedModelRef.registry,
                await import("@earendil-works/pi-agent-core"),
              ),
              dataDir,
            }),
          );
        } catch (err: unknown) {
          if (!isAddressInUseError(err)) throw err;
          if (!(await tryConnectToExistingServer(dataDir, desiredPort, cmdCtx.ui.notify.bind(cmdCtx.ui)))) return;
        }
      }
      // Auto-detect or create project from git repo
      const { detectProject } = await import("../kanban/data/kanban-detect-project.js");
      let projectId = await detectProject(database, process.cwd());
      if (!projectId) {
        // Auto-create project for this repo
        try {
          const { resolveRepoPath } = await import("../kanban/data/kanban-detect-project.js");
          const repoPath = await resolveRepoPath(process.cwd());
          const existing = database.findProjectByRepoPath(repoPath);
          if (existing) {
            projectId = existing.id;
          } else {
            projectId = database.createProject({ name: basename(repoPath), repoPath });
            log.info(`[kanban] auto-created project ${projectId} "${basename(repoPath)}" for repoPath=${repoPath}`);
          }
        } catch (err) {
          log.warn(`[kanban] failed to auto-create project: ${err}`);
        }
      }
      const server = getSharedServer();
      if (!server) {
        log.warn("[kanban] no shared server available, cannot open Kanban board");
        return;
      }
      const url = projectId
        ? `http://localhost:${server.port}?project=${projectId}`
        : `http://localhost:${server.port}`;
      cmdCtx.ui.notify(`Kanban board: ${url}`, "info");
      // Open in browser (platform-specific)
      const { execFile } = await import("node:child_process");
      if (process.platform === "win32") {
        execFile("cmd", ["/c", "start", "", url], () => {});
      } else if (process.platform === "darwin") {
        execFile("open", [url], () => {});
      } else {
        execFile("xdg-open", [url], () => {});
      }
    },
  });

  // Register /ff:kanban-release command
  pi.registerCommand("ff:kanban-release", {
    description: "Release a feature lock so others can pick it up",
    async handler(args, cmdCtx) {
      const featureId = parseInt(args.trim(), 10);
      if (!featureId || featureId <= 0) {
        cmdCtx.ui.notify("Usage: /ff:kanban-release <feature-id>", "warning");
        return;
      }

      try {
        const kanbanTools = await getTools();
        kanbanTools.kanbanRelease({ featureId });
        cmdCtx.ui.notify(`Feature ${featureId} lock released`, "info");
      } catch (err) {
        cmdCtx.ui.notify(`Failed to release feature ${featureId}: ${err}`, "error");
      }
    },
  });
}

/** Helper: find an agent whose current feature matches the given slug. */
export async function findAgentForSlug(
  slug: string,
  autoAgent: AutoAgent | null,
  getDatabase: () => Promise<KanbanDatabase>,
  options: { state: string | string[] | null } | null,
): Promise<AutoAgentMatch> {
  if (!autoAgent) return null;
  const sm = autoAgent;
  if (options?.state) {
    const states = Array.isArray(options.state) ? options.state : [options.state];
    if (!states.includes(sm.getState())) {
      log.debug(`[kanban] findAgentForSlug("${slug}"): agent state=${sm.getState()} not in [${states.join(", ")}]`);
      return null;
    }
  }
  const featureId = sm.getCurrentFeatureId();
  if (featureId === null) return null;
  try {
    const db = await getDatabase();
    const feature = db.getFeature(featureId);
    if (!feature || feature.slug !== slug) {
      log.info(
        `[kanban] findAgentForSlug("${slug}"): feature ${featureId} slug=${feature?.slug ?? "null"} !== ${slug}`,
      );
      return null;
    }
  } catch (err) {
    log.warn(`[kanban] findAgentForSlug: lookup failed for slug "${slug}", featureId=${featureId}: ${err}`);
    return null;
  }
  return { sm, featureId };
}

/** Find an agent for the given slug whose state is in `states`. Shared backing for findAnyActiveAgent/findResumableAgent. */
function findAgentByStates(
  slug: string,
  autoAgent: AutoAgent | null,
  getDatabase: () => Promise<KanbanDatabase>,
  states: readonly string[],
): Promise<AutoAgentMatch> {
  return findAgentForSlug(slug, autoAgent, getDatabase, { state: [...states] });
}

/** Active agent states — any agent that is currently doing work or temporarily paused. */
const ACTIVE_STATES = ["working", "paused", "waiting"] as const;

/** Resumable agent states — agents waiting for user input. */
const RESUMABLE_STATES = ["waiting"] as const;

/**
 * Find any active agent for the given slug (working, paused, or waiting).
 * Convenience wrapper around findAgentForSlug that replaces cascading nullish coalescing.
 */
export function findAnyActiveAgent(
  slug: string,
  autoAgent: AutoAgent | null,
  getDatabase: () => Promise<KanbanDatabase>,
): Promise<AutoAgentMatch> {
  return findAgentByStates(slug, autoAgent, getDatabase, ACTIVE_STATES);
}

/**
 * Find a resumable agent for the given slug (waiting).
 * Convenience wrapper around findAgentForSlug that replaces cascading nullish coalescing.
 */
export function findResumableAgent(
  slug: string,
  autoAgent: AutoAgent | null,
  getDatabase: () => Promise<KanbanDatabase>,
): Promise<AutoAgentMatch> {
  return findAgentByStates(slug, autoAgent, getDatabase, RESUMABLE_STATES);
}

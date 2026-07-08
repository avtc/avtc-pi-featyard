// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Shared test utilities for kanban server tests.
 *
 * Provides server lifecycle management (setup/teardown), temp directory cleanup,
 * and authenticated fetch helper to eliminate boilerplate duplication across
 * server test files.
 */

import * as fs from "node:fs";
import type * as httpType from "node:http";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { afterAll, afterEach, vi } from "vitest";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import { createServer } from "../../src/kanban/kanban-server.js";

const SERVERS: httpType.Server[] = [];
const TEMP_DIRS: string[] = [];

afterEach(async () => {
  for (const server of SERVERS.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

/** Safety net: clean up any leaked servers/dirs when the test file finishes. */
afterAll(async () => {
  for (const server of SERVERS.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

export interface SetupOptions {
  /** Prefix for the temp directory name. Defaults to "kanban-test-". */
  tempDirPrefix?: string;
  /** Optional generateTitle callback for batch import tests. */
  generateTitle?: (description: string, signal?: AbortSignal) => Promise<string>;
  /** Optional doneHideAfterMs for hiding old done features. */
  doneHideAfterMs?: number | null;
}

export interface SetupResult {
  db: KanbanDatabase;
  server: httpType.Server;
  port: number;
  authToken: string;
}

/** Default sentinel for "no setup options" */
export const NO_SETUP_OPTIONS: SetupOptions | null = null;

/**
 * Creates a test server with a fresh in-memory database.
 *
 * Automatically registers cleanup via afterEach/afterAll.
 */
export async function setup(options: SetupOptions | null): Promise<SetupResult> {
  const { generateTitle, doneHideAfterMs } = options ?? {};
  const db = await KanbanDatabase.createInMemory();
  const serverOptions = { generateTitle, doneHideAfterMs };
  const { server, port, authToken } = await createServer(db, 0, null, serverOptions);
  SERVERS.push(server);
  return { db, server, port, authToken };
}

/** Default sentinel for "no HTTP options" */
export const NO_REQUEST_INIT: RequestInit | null = null;

/**
 * Fetch helper that injects the auth token into requests.
 */
export function fetchPort(
  port: number,
  urlPath: string,
  options: RequestInit | null,
  authToken: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) ?? {}),
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return globalThis.fetch(`http://localhost:${port}${urlPath}`, { ...(options ?? {}), headers });
}

/**
 * Creates a mock agentLoop that simulates calling the return_title tool
 * with the given title. Used by generate-title tests.
 */
export function createMockAgentLoop(title: string) {
  return vi
    .fn()
    .mockImplementation(
      (_prompts: AgentMessage[], context: AgentContext, _config: AgentLoopConfig, _signal?: AbortSignal) => {
        const tool = context.tools?.find((t: AgentTool) => t.name === "return_title") as AgentTool | undefined;
        if (tool) {
          // Fire-and-forget — tool.implement sets generatedTitle synchronously before the promise resolves.
          void tool.execute("tc1", { title });
        }
        const events: AgentEvent[] = [{ type: "agent_start" as const }, { type: "agent_end" as const, messages: [] }];
        let i = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (i < events.length) return { value: events[i++], done: false };
                return { value: undefined, done: true };
              },
            };
          },
          result: vi.fn().mockResolvedValue([]),
        };
      },
    );
}

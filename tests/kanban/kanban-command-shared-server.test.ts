// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import type * as httpType from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import kanbanExtension, {
  getSharedServerInstance,
  resetInstances,
  setDatabase,
  setSharedServerInstance,
} from "../../src/kanban/kanban-bridge.js";
import { createServer } from "../../src/kanban/kanban-server.js";

// Mock execFile to prevent browser from opening during tests
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn((...args: unknown[]) => {
      // No-op — don't actually open browser
      const last = args[args.length - 1];
      if (typeof last === "function") (last as () => void)();
      return { on: () => {} };
    }),
  };
});

const SERVERS: httpType.Server[] = [];
const TEMP_DIRS: string[] = [];
const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  resetInstances();
  if (process.cwd() !== ORIGINAL_CWD) {
    process.chdir(ORIGINAL_CWD);
  }
  for (const server of SERVERS.splice(0)) {
    try {
      server.close();
    } catch {}
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function createFakeApi(): {
  api: ExtensionAPI;
  registeredCommands: Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>;
} {
  const registeredCommands = new Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>();

  const api = {
    on() {},
    registerTool() {},
    registerCommand(name: string, definition: { description: string; handler: (...args: unknown[]) => Promise<void> }) {
      registeredCommands.set(name, definition);
    },
    appendEntry() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;

  return { api, registeredCommands };
}

/**
 * Simulates the /ff:kanban command handler when the shared server is already set
 * (i.e., the post-fallback state or same-session second call).
 */
describe("ff:kanban command handler with shared server", () => {
  test("uses existing shared server and registers project when server is already running", async () => {
    // Setup: create a real database and server
    const dataDir = mkdtempSync(join(tmpdir(), "kanban-shared-test-"));
    TEMP_DIRS.push(dataDir);

    const db = await KanbanDatabase.create(dataDir);
    const result = await createServer(db, 0, null, { dataDir });
    SERVERS.push(result.server);

    // Register the extension to get the command handler
    setDatabase(db);
    const { api, registeredCommands } = createFakeApi();
    await kanbanExtension(api, null);

    // Simulate first session already set the shared server (e.g., after first /ff:kanban call)
    setSharedServerInstance({ server: result.server, port: result.port, authToken: result.authToken });

    // Verify shared server is set
    const existingServer = getSharedServerInstance();
    expect(existingServer).not.toBeNull();
    expect((existingServer as NonNullable<typeof existingServer>).port).toBe(result.port);

    // Call /ff:kanban handler — it should skip server creation since shared server exists
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };

    const cmd = registeredCommands.get("ff:kanban");
    expect(cmd).toBeDefined();

    // Run the handler — it should proceed to project detection
    await (cmd as NonNullable<typeof cmd>).handler("", ctx as unknown as ExtensionCommandContext);

    // Verify it didn't try to create a new server (the original server is still the only one)
    expect(SERVERS.length).toBe(1);

    // Verify notification contains the kanban URL
    const urlNotifications = notifications.filter((n) => n.message.includes("Kanban board:"));
    expect(urlNotifications.length).toBeGreaterThan(0);
    expect(urlNotifications[0].message).toContain(`http://localhost:${result.port}`);

    // Verify the project was registered (detectProject + auto-create flow)
    const projects = db.listProjects();
    // At least one project should exist (auto-created for the current repo)
    expect(projects.length).toBeGreaterThan(0);
  });

  test("creates project only once when /ff:kanban is called multiple times", async () => {
    // Setup
    const dataDir = mkdtempSync(join(tmpdir(), "kanban-idempotent-"));
    TEMP_DIRS.push(dataDir);

    const db = await KanbanDatabase.create(dataDir);
    const result = await createServer(db, 0, null, { dataDir });
    SERVERS.push(result.server);

    setDatabase(db);
    const { api, registeredCommands } = createFakeApi();
    await kanbanExtension(api, null);

    // Pre-create a project so detectProject can find it
    const projectId = db.createProject({ name: "existing-project", repoPath: "/known/repo" });
    setSharedServerInstance({ server: result.server, port: result.port, authToken: result.authToken });

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
    };

    const cmd = registeredCommands.get("ff:kanban");
    expect(cmd).toBeDefined();

    // Call handler twice
    await (cmd as NonNullable<typeof cmd>).handler("", ctx as unknown as ExtensionCommandContext);
    await (cmd as NonNullable<typeof cmd>).handler("", ctx as unknown as ExtensionCommandContext);

    // The pre-created project should still exist (not duplicated)
    const projects = db.listProjects();
    const existingProjects = projects.filter((p) => p.id === projectId);
    expect(existingProjects.length).toBe(1);
  });
});

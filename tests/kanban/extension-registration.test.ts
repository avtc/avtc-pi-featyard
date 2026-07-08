// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import kanbanExtension, { resetInstances } from "../../src/kanban/kanban-bridge.js";

// We need to import the extension function — but it initializes sql.js async,
// so we test the registration pattern rather than full DB initialization.
// The actual DB operations are tested in database.test.ts and tools.test.ts.

afterEach(() => {
  resetInstances();
});

function createFakeApi(): {
  api: ExtensionAPI;
  registeredCommands: Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>;
  registeredTools: Map<string, unknown>;
} {
  const registeredCommands = new Map<string, { description: string; handler: (...args: unknown[]) => Promise<void> }>();
  const registeredTools = new Map<string, unknown>();

  const api = {
    on() {},
    registerTool(tool: unknown) {
      const t = tool as { name: string };
      registeredTools.set(t.name, tool);
    },
    registerCommand(name: string, definition: { description: string; handler: (...args: unknown[]) => Promise<void> }) {
      registeredCommands.set(name, definition);
    },
    appendEntry() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;

  return { api, registeredCommands, registeredTools };
}

describe("kanban extension registration", () => {
  test("registers /ff:kanban and /ff:kanban-release commands", async () => {
    // Dynamic import to get fresh module

    const { api, registeredCommands } = createFakeApi();

    // The extension uses async init, but registerCommand is synchronous
    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    expect(registeredCommands.has("ff:kanban")).toBe(true);
    expect(registeredCommands.has("ff:kanban-release")).toBe(true);
  });

  test("ff:kanban command has description", async () => {
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    const kanban = registeredCommands.get("ff:kanban");
    expect(kanban).toBeDefined();
    expect((kanban as NonNullable<typeof kanban>).description.length).toBeGreaterThan(0);
  });

  test("ff:kanban-release command has description", async () => {
    const { api, registeredCommands } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    const release = registeredCommands.get("ff:kanban-release");
    expect(release).toBeDefined();
    expect((release as NonNullable<typeof release>).description.length).toBeGreaterThan(0);
  });

  test("registers add_to_backlog tool", async () => {
    const { api, registeredTools } = createFakeApi();

    const extension = kanbanExtension;
    if (typeof extension === "function") {
      await extension(api, null);
    }

    expect(registeredTools.has("add_to_backlog")).toBe(true);
    const tool = registeredTools.get("add_to_backlog") as { label: string; description: string };
    expect(tool.label).toBe("Add Feature to Backlog");
    expect(tool.description).toContain("kanban board backlog");
  });
});

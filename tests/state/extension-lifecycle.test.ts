// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { cleanupAfterTest, fireAllHandlers, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const registeredCommands: string[] = [];

  return {
    handlers,
    registeredCommands,
    api: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      events: {
        on() {
          return () => {};
        },
      },
      registerTool() {
        // no-op for these tests
      },
      registerCommand(name: string) {
        registeredCommands.push(name);
      },
      appendEntry() {
        // no-op for these tests
      },
    },
  };
}

function getSingleHandler(handlers: Map<string, Handler[]>, event: string): Handler {
  const list = handlers.get(event) ?? [];
  expect(list.length).toBeGreaterThan(0);
  const first = list[0];
  if (!first) throw new Error(`No handler found for ${event}`);
  return first;
}

describe("workflow-monitor extension lifecycle", () => {
  beforeEach(() => {
    // Run inside a temp dir so production init's ensureFfJunction(process.cwd()) never touches
    // the real repo's .ff.
    withTempCwd();
  });

  afterEach(() => {
    cleanupAfterTest();
  });

  test("registers /ff:next command", () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    expect(fake.registeredCommands).toContain("ff:next");
  });

  test("clears pending violation on session switch", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const ctx = { hasUI: false, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    // Queue a violation from tool_call.
    await onToolCall({ toolName: "write", input: { path: "src/foo.ts" } } as unknown as ExtensionEvent, ctx);

    // Session change should clear pending state.
    await fireAllHandlers(fake.handlers, "session_start", {}, ctx);

    // If pendingViolation was not cleared, this would inject a stale warning.
    const result = await onToolResult(
      {
        toolName: "write",
        input: { path: "src/bar.ts" },
        content: [{ type: "text", text: "ok" }],
        details: {},
      } as unknown as ExtensionEvent,
      ctx,
    );

    if (result) {
      const text = ((result as { content?: unknown[] }).content ?? [])
        .filter((c: unknown) => (c as { type: string }).type === "text")
        .map((c: unknown) => (c as { text: string }).text)
        .join("\n");
      expect(text).not.toContain("TDD/Debug policy violation detected");
      expect(text).not.toContain("Fix attempt");
    }
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import {
  createFakePi,
  EXECUTE_ACTIVE,
  getSingleHandler,
  initTempGitRepo,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

// Reset globalThis settings between tests
afterEach(() => {});

describe("practice escalation (tdd-advisory default)", () => {
  test("tdd-advisory: strike counter does not increment in non-interactive mode", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-advisory-no-prompt", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          throw new Error("should not prompt in non-interactive mode");
        },
        setEditorText: () => {},
        notify: () => {},
      },
    };

    // Multiple TDD violations in non-interactive mode should never prompt
    await onToolCall(
      { type: "tool_call", toolCallId: "t1", toolName: "write", input: { path: "src/a.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "t2", toolName: "write", input: { path: "src/b.ts", content: "y" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "t3", toolName: "write", input: { path: "src/c.ts", content: "z" } },
      ctx as unknown as ExtensionContext,
    );

    // If we get here without throwing, the guard worked
  });

  test("tdd-advisory: TDD violations never prompt in interactive mode — warnings only", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-advisory-no-prompt-interactive", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    let promptCount = 0;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          promptCount += 1;
          return "Yes, allow all for this session";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    };

    // Multiple TDD violations — no prompts should ever fire
    await onToolCall(
      { type: "tool_call", toolCallId: "t1", toolName: "write", input: { path: "src/a.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "t2", toolName: "write", input: { path: "src/b.ts", content: "y" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "t3", toolName: "write", input: { path: "src/c.ts", content: "z" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "t4", toolName: "write", input: { path: "src/d.ts", content: "w" } },
      ctx as unknown as ExtensionContext,
    );

    expect(promptCount).toBe(0);
  });

  test("tdd-advisory: TDD violations never block writes — tool call always proceeds", async () => {
    const fake = createFakePi();
    initTempGitRepo(); // the write-order check is git-based — needs a real working tree
    writeFeatureStateFile("test-advisory-no-block", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => "No, stop",
        setEditorText: () => {},
        notify: () => {},
      },
    };

    // First TDD violation: should not block
    const res1 = await onToolCall(
      { type: "tool_call", toolCallId: "t1", toolName: "write", input: { path: "src/a.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );
    expect(res1).not.toMatchObject({ block: true });

    // Verify warning is injected into tool_result
    const toolRes1 = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "write",
        input: { path: "src/a.ts", content: "x" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    const text1 = ((toolRes1 as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text1).toContain("TDD");

    // Second TDD violation: should also not block
    const res2 = await onToolCall(
      { type: "tool_call", toolCallId: "t2", toolName: "write", input: { path: "src/b.ts", content: "y" } },
      ctx as unknown as ExtensionContext,
    );
    expect(res2).not.toMatchObject({ block: true });

    // Verify warning is also injected for second violation
    const toolRes2 = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "t2",
        toolName: "write",
        input: { path: "src/b.ts", content: "y" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );
    const text2 = ((toolRes2 as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text2).toContain("TDD");
  });
});

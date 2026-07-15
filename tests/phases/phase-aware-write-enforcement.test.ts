// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import {
  createFakePi,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

const BRAINSTORM_ACTIVE = {
  phases: {
    design: "in-progress",
    plan: "pending",
    implement: "pending",
    verify: "pending",
    review: "pending",
    finish: "pending",
  },
  currentPhase: "design",
  artifacts: { design: null, plan: null, implement: null, verify: null, review: null, finish: null },
};

describe("phase-aware file write enforcement", () => {
  test("warns when writing outside docs/plans during design", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-write-enforce", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    };

    enableSubagentMode();
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    await onToolCall(
      { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "extensions/foo.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );

    const res = await onToolResult(
      {
        toolCallId: "w1",
        toolName: "write",
        input: { path: "extensions/foo.ts", content: "x" },
        content: [{ type: "text", text: "ok" }],
        details: {},
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );

    const text = ((res as { content?: Array<{ type: string; text: string }> } | undefined)?.content ?? [])
      .filter((c) => (c as { type: string }).type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");

    expect(text).toContain("⚠️ PROCESS VIOLATION");
    expect(text).toContain("docs/featyard/designs/");
  });

  test("writing to./docs/plans is allowed during design", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-write-allowed", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    };

    enableSubagentMode();
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "p1",
        toolName: "write",
        input: { path: "./docs/featyard/designs/x.md", content: "x" },
      },
      ctx as unknown as ExtensionContext,
    );

    const res = await onToolResult(
      {
        toolCallId: "p1",
        toolName: "write",
        input: { path: "./docs/featyard/designs/x.md", content: "x" },
        content: [{ type: "text", text: "ok" }],
        details: {},
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );

    const text = ((res as { content?: Array<{ type: string; text: string }> } | undefined)?.content ?? [])
      .filter((c) => (c as { type: string }).type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");

    expect(text).not.toContain("⚠️ PROCESS VIOLATION");
  });

  test("writing to absolute path under docs/plans/ is allowed during design", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-write-abs", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    };

    enableSubagentMode();
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    const plansPath = `${process.cwd()}/docs/featyard/designs/design.md`;

    await onToolCall(
      { type: "tool_call", toolCallId: "abs1", toolName: "write", input: { path: plansPath, content: "x" } },
      ctx as unknown as ExtensionContext,
    );

    const res = await onToolResult(
      {
        toolCallId: "abs1",
        toolName: "write",
        input: { path: plansPath, content: "x" },
        content: [{ type: "text", text: "ok" }],
        details: {},
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );

    const text = ((res as { content?: Array<{ type: string; text: string }> } | undefined)?.content ?? [])
      .filter((c) => (c as { type: string }).type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");

    expect(text).not.toContain("⚠️ PROCESS VIOLATION");
  });

  test("absolute path containing docs/plans is NOT allowed unless under cwd", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-write-evil", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    };

    enableSubagentMode();
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    const evilPath = "/tmp/evil/docs/plans/attack.ts";

    await onToolCall(
      { type: "tool_call", toolCallId: "e1", toolName: "write", input: { path: evilPath, content: "x" } },
      ctx as unknown as ExtensionContext,
    );

    const res = await onToolResult(
      {
        toolCallId: "e1",
        toolName: "write",
        input: { path: evilPath, content: "x" },
        content: [{ type: "text", text: "ok" }],
        details: {},
      } as unknown as ExtensionEvent,
      ctx as unknown as ExtensionContext,
    );

    const text = ((res as { content?: Array<{ type: string; text: string }> } | undefined)?.content ?? [])
      .filter((c) => (c as { type: string }).type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");

    expect(text).toContain("⚠️ PROCESS VIOLATION");
  });

  test("second process violation hard-blocks (interactive)", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    writeFeatureStateFile("test-write-block", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    let promptCount = 0;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async (_title: string, options: string[]) => {
          promptCount += 1;
          expect(options).toEqual(["Yes, continue", "Yes, allow all for this session", "No, stop"]);
          return "No, stop";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    };

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // 1st violation: allowed
    await onToolCall(
      { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "extensions/a.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );

    // 2nd violation: should block
    const res = await onToolCall(
      { type: "tool_call", toolCallId: "w2", toolName: "write", input: { path: "extensions/b.ts", content: "y" } },
      ctx as unknown as ExtensionContext,
    );

    expect(promptCount).toBe(1);
    expect(res).toMatchObject({ block: true });
  });
});

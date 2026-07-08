// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  disableSubagentMode,
  EXECUTE_ACTIVE,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  initTempGitRepo,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

// Reset globalThis settings between tests
afterEach(() => {});

describe("testingDiscipline controls TDD enforcement", () => {
  beforeEach(() => {
    setTestSettings(null);
  });

  test("tdd-strict blocks source write when no corresponding test is in the change set", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    initTempGitRepo(); // git-based check needs a real working tree
    writeFeatureStateFile("test-tdd-strict", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("testingDiscipline", "tdd-strict");
    setSetting("preCommitDiscipline", "off");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, select: async () => "No, stop" },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Write source file with NO corresponding test in the change set → blocked
    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "export const x = 1;" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).toMatchObject({ block: true });
  });

  test("tdd-strict allows source write in headless mode with warning", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    initTempGitRepo();
    writeFeatureStateFile("test-tdd-strict-headless", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("testingDiscipline", "tdd-strict");
    setSetting("preCommitDiscipline", "off");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // No test in the change set → headless bypasses the block but injects the warning
    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "export const x = 1;" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "export const x = 1;" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const text = ((toolRes as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).toContain("TDD");
  });

  test("tdd-advisory allows source write with warning", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    initTempGitRepo();
    writeFeatureStateFile("test-tdd-advisory", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("testingDiscipline", "tdd-advisory");
    setSetting("preCommitDiscipline", "off");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "x" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    const res = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "x" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );

    const text = ((res as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).toContain("TDD");
  });

  test("tdd-strict allows source write when a corresponding test is in the change set", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    initTempGitRepo();
    writeFeatureStateFile("test-tdd-strict-happy", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("testingDiscipline", "tdd-strict");
    setSetting("preCommitDiscipline", "off");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Write the corresponding test into the working tree FIRST (untracked → in the change set).
    // The test name extends the source name: new-feature.ts ↔ new-feature.test.ts.
    fs.mkdirSync("src", { recursive: true });
    fs.writeFileSync("src/new-feature.test.ts", "import { x } from './new-feature';");

    // Source write — ALLOWED because a corresponding test is in the change set
    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "export const x = 1;" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "export const x = 1;" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const text = ((toolRes as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).not.toContain("TDD");
  });

  test("tdd-strict blocks when the change set has only an UNRELATED test (prefix must match)", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    initTempGitRepo();
    writeFeatureStateFile("test-tdd-unrelated", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("testingDiscipline", "tdd-strict");
    setSetting("preCommitDiscipline", "off");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // A test exists, but for a different source (stems differ, not a prefix extension).
    fs.mkdirSync("src", { recursive: true });
    fs.writeFileSync("src/other-thing.test.ts", "x");

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "x" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).toMatchObject({ block: true });
  });

  test("off mode allows source write without warning", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    initTempGitRepo();
    writeFeatureStateFile("test-off-tdd", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("testingDiscipline", "off");
    setSetting("preCommitDiscipline", "off");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "x" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    const res = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "x" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );

    const text = ((res as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).not.toContain("TDD");
  });

  test("non-git working tree: TDD check silently no-ops (no block, no warning)", async () => {
    // createFakePi() already switched to a temp cwd that is NOT a git repo.
    enableSubagentMode();
    const fake = createFakePi();
    writeFeatureStateFile("test-nongit", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("testingDiscipline", "tdd-strict");
    setSetting("preCommitDiscipline", "off");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "x" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "src/new-feature.ts", content: "x" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const text = ((toolRes as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).not.toContain("TDD");
  });
});

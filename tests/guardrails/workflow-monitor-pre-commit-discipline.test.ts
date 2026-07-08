// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { mockExecSync, restoreExecSync } from "../helpers/mock-exec-sync.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  disableSubagentMode,
  EXECUTE_ACTIVE,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

const execSyncMock = vi.fn();

beforeEach(() => {
  mockExecSync(execSyncMock);
  setTestSettings(null);
});

afterEach(() => {
  restoreExecSync();
  execSyncMock.mockReset();
});

describe("preCommitDiscipline: advisory (default)", () => {
  test("warns on commit without verification, never blocks", async () => {
    disableSubagentMode();
    // Mock execSync to return staged source files (consolidated gate needs them)
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("git branch")) return Buffer.from("feature/test\n");
      if (typeof cmd === "string" && cmd.includes("git rev-parse")) return Buffer.from("abc123\n");
      if (typeof cmd === "string" && cmd.includes("git diff --cached")) return Buffer.from("src/foo.ts\n");
      throw new Error(`unexpected execSync call: ${cmd}`);
    });

    const fake = createFakePi();
    writeFeatureStateFile("test-pcd-advisory", EXECUTE_ACTIVE);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("preCommitDiscipline", "advisory");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => "Skip all and continue",
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // First commit: advisory -> warn only, never prompt
    const res = await onToolCall(
      { toolCallId: "b1", toolName: "bash", input: { command: "git commit -m 'test'" } } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    // Verify warning is injected into tool_result
    const toolRes = await onToolResult(
      {
        toolCallId: "b1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "[ok] committed" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect((toolRes as { content: Array<{ text: string }> }).content[0].text).toContain("PRE-COMMIT GATE");

    // Second commit: still no prompt
    const res2 = await onToolCall(
      { toolCallId: "b2", toolName: "bash", input: { command: "git commit -m 'test2'" } } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res2).not.toMatchObject({ block: true });
  });
});

describe("preCommitDiscipline: strict", () => {
  test("blocks commit without verification in interactive mode", async () => {
    disableSubagentMode();
    // Mock execSync to return staged source files (consolidated gate needs them)
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("git branch")) return Buffer.from("feature/test\n");
      if (typeof cmd === "string" && cmd.includes("git rev-parse")) return Buffer.from("abc123\n");
      if (typeof cmd === "string" && cmd.includes("git diff --cached")) return Buffer.from("src/foo.ts\n");
      throw new Error(`unexpected execSync call: ${cmd}`);
    });

    const fake = createFakePi();
    writeFeatureStateFile("test-pcd-strict", EXECUTE_ACTIVE);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("preCommitDiscipline", "strict");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => "Skip all and continue",
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const res = await onToolCall(
      { toolCallId: "b1", toolName: "bash", input: { command: "git commit -m 'test'" } } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).toMatchObject({ block: true });
    expect((res as { reason: string }).reason).toContain("Pre-commit gate");
  });

  test("blocks commit without verification in headless mode (strict is not bypassable)", async () => {
    enableSubagentMode();
    // Mock execSync to return staged source files (consolidated gate needs them)
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("git branch")) return Buffer.from("feature/test\n");
      if (typeof cmd === "string" && cmd.includes("git rev-parse")) return Buffer.from("abc123\n");
      if (typeof cmd === "string" && cmd.includes("git diff --cached")) return Buffer.from("src/foo.ts\n");
      throw new Error(`unexpected execSync call: ${cmd}`);
    });

    const fake = createFakePi();
    writeFeatureStateFile("test-pcd-strict-headless", EXECUTE_ACTIVE);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("preCommitDiscipline", "strict");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const res = await onToolCall(
      { toolCallId: "b1", toolName: "bash", input: { command: "git commit -m 'test'" } } as unknown as ExtensionEvent,
      ctx,
    );
    // strict mode blocks regardless of session kind (headless/subagent identical to interactive)
    expect(res).toMatchObject({ block: true });
  });

  test("RPC child (hasUI=true, subagent) BLOCKS on strict pre-commit (identical to interactive)", async () => {
    // strict mode blocks regardless of session kind: an RPC subagent (hasUI=true, subagent env set)
    // is blocked identically to an interactive session. The old hasUI:!isSubagentSession() proxy
    // that downgraded subagents to warn is gone — a strict gate must not be bypassable.
    enableSubagentMode();
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("git branch")) return Buffer.from("feature/test\n");
      if (typeof cmd === "string" && cmd.includes("git rev-parse")) return Buffer.from("abc123\n");
      if (typeof cmd === "string" && cmd.includes("git diff --cached")) return Buffer.from("src/foo.ts\n");
      throw new Error(`unexpected execSync call: ${cmd}`);
    });

    const fake = createFakePi();
    writeFeatureStateFile("test-pcd-strict-rpc-child", EXECUTE_ACTIVE);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("preCommitDiscipline", "strict");

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    // RPC child: hasUI=true but IS a subagent (env set).
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, select: async () => undefined, notify: () => {}, setEditorText: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const res = await onToolCall(
      { toolCallId: "b1", toolName: "bash", input: { command: "git commit -m 'test'" } } as unknown as ExtensionEvent,
      ctx,
    );
    // Subagent BLOCKS under strict discipline — identical to interactive.
    expect(res).toMatchObject({ block: true });
  });
});

describe("preCommitDiscipline: off", () => {
  test("allows commit without verification, no warning", async () => {
    enableSubagentMode();
    // Mock execSync (consolidated gate short-circuits on preCommitDiscipline=off)
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("git branch")) return Buffer.from("feature/test\n");
      if (typeof cmd === "string" && cmd.includes("git rev-parse")) return Buffer.from("abc123\n");
      if (typeof cmd === "string" && cmd.includes("git diff --cached")) return Buffer.from("src/foo.ts\n");
      throw new Error(`unexpected execSync call: ${cmd}`);
    });

    const fake = createFakePi();
    writeFeatureStateFile("test-pcd-off", EXECUTE_ACTIVE);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
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
      { toolCallId: "b1", toolName: "bash", input: { command: "git commit -m 'test'" } } as unknown as ExtensionEvent,
      ctx,
    );
    const res = await onToolResult(
      {
        toolCallId: "b1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const text = ((res as { content?: Array<{ type: string; text: string }> })?.content ?? [])
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("\n");
    expect(text).not.toContain("PRE-COMMIT GATE");
  });
});

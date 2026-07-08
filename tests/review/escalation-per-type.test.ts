// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import {
  createFakePi,
  disableSubagentMode,
  EXECUTE_ACTIVE,
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

describe("per-violation-type escalation", () => {
  // Root-session tests: ensure isSubagentSession() returns false
  beforeEach(() => {
    disableSubagentMode();
  });
  test("second process violation of same type prompts user (interactive)", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-escalation", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    let promptCount = 0;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async (_title: string, _options: string[]) => {
          promptCount++;
          return "Yes, continue";
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

    // 1st phase-write-restriction violation: allowed (warn only in unrecoverable)
    await onToolCall(
      { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "src/a.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );
    expect(promptCount).toBe(0);

    // 2nd phase-write-restriction violation (same type): should prompt
    await onToolCall(
      { type: "tool_call", toolCallId: "w2", toolName: "write", input: { path: "src/b.ts", content: "y" } },
      ctx as unknown as ExtensionContext,
    );
    expect(promptCount).toBe(1);
  });

  test("'allow all for this session' suppresses future prompts for that type", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-escalation-session", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => "Yes, allow all for this session",
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

    // 1st + 2nd violation → prompt → allow all
    await onToolCall(
      { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "src/a.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "w2", toolName: "write", input: { path: "src/b.ts", content: "y" } },
      ctx as unknown as ExtensionContext,
    );

    // 3rd violation should NOT prompt (session-allowed)
    const res = await onToolCall(
      { type: "tool_call", toolCallId: "w3", toolName: "write", input: { path: "src/c.ts", content: "z" } },
      ctx as unknown as ExtensionContext,
    );
    expect(res).not.toMatchObject({ block: true });
  });

  test("'No, stop' returns blocked on escalation", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-escalation-stop", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

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

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // 1st violation: allowed
    await onToolCall(
      { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "src/a.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );

    // 2nd violation: prompt → "No, stop" → blocked
    const res = await onToolCall(
      { type: "tool_call", toolCallId: "w2", toolName: "write", input: { path: "src/b.ts", content: "y" } },
      ctx as unknown as ExtensionContext,
    );
    expect(res).toMatchObject({ block: true });
  });

  test("non-interactive mode never prompts", async () => {
    enableSubagentMode(); // simulate subagent so isSubagentSession() returns true
    const fake = createFakePi();
    writeFeatureStateFile("test-escalation-nonint", { workflow: BRAINSTORM_ACTIVE });
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
      },
    };

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    // Multiple violations — no prompts
    await onToolCall(
      { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "src/a.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "w2", toolName: "write", input: { path: "src/b.ts", content: "y" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "w3", toolName: "write", input: { path: "src/c.ts", content: "z" } },
      ctx as unknown as ExtensionContext,
    );
    // If we get here without throwing, the guard worked
  });

  test("RPC child (hasUI=true, subagent) bypasses escalation — never prompts", async () => {
    // RPC children have ctx.hasUI=true. guardrail-tracker keys the escalation bypass on
    // isSubagentSession(), not hasUI, so an RPC subagent must STILL bypass escalation. A
    // revert to ctx.hasUI would prompt (and, with a no-op select in RPC, misbehave).
    enableSubagentMode();
    const fake = createFakePi();
    writeFeatureStateFile("test-escalation-rpc-child", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: true, // RPC child: has UI capability but IS a subagent
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          throw new Error("should not prompt for an RPC subagent");
        },
      },
    };

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", reason: "reload" },
      ctx as unknown as ExtensionContext,
    );

    await onToolCall(
      { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "src/a.ts", content: "x" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "w2", toolName: "write", input: { path: "src/b.ts", content: "y" } },
      ctx as unknown as ExtensionContext,
    );
    // If we get here without throwing, the RPC-child bypass worked
  });

  test("preCommitDiscipline advisory never prompts for verification violations", async () => {
    // With preCommitDiscipline "advisory", the verification gate should
    // never prompt the user regardless of how many commits are attempted.
    // It injects warnings via onToolResult but does not block or escalate.
    const fake = createFakePi();
    writeFeatureStateFile("test-escalation-independent", { workflow: EXECUTE_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const prompts: string[] = [];
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async (title: string) => {
          prompts.push(title);
          return "Yes, continue";
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

    // Default preCommitDiscipline is "advisory" — never prompts for verification
    await onToolCall(
      { type: "tool_call", toolCallId: "b1", toolName: "bash", input: { command: "git commit -m 'test'" } },
      ctx as unknown as ExtensionContext,
    );
    await onToolCall(
      { type: "tool_call", toolCallId: "b2", toolName: "bash", input: { command: "git commit -m 'test2'" } },
      ctx as unknown as ExtensionContext,
    );
    expect(prompts.length).toBe(0); // advisory never prompts
  });
});

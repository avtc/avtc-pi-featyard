// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import type { PiWorkflowMonitorBridge } from "../../src/shared/types.js";
import { mockExecSync, restoreExecSync } from "../helpers/mock-exec-sync.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  cleanupAfterTest,
  createFakePi,
  disableSubagentMode,
  EXECUTE_ACTIVE,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  withTempCwd,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

const execSyncMock = vi.fn();

beforeEach(() => {
  mockExecSync(execSyncMock);
});

afterEach(() => {
  restoreExecSync();
  execSyncMock.mockReset();
  cleanupAfterTest();
});

/** Helper to set up settings + mock execSync + extension + handlers */
async function setupGate(
  slug: string,
  opts: {
    preCommitDiscipline: string;
    testingDiscipline?: string;
    stagedFiles?: string;
    hasUI?: boolean;
  },
) {
  const testingDiscipline = opts.testingDiscipline ?? "tdd-advisory";
  const hasUI = opts.hasUI ?? false;

  // Ensure globalThis bridge is initialized (needed by settings internals)

  // Mock execSync for git commands
  const staged = opts.stagedFiles ?? "";
  execSyncMock.mockImplementation((cmd: string) => {
    if (typeof cmd === "string" && cmd.includes("git branch")) return Buffer.from("feature/test\n");
    if (typeof cmd === "string" && cmd.includes("git rev-parse")) return Buffer.from("abc123\n");
    if (typeof cmd === "string" && cmd.includes("git diff --cached")) return Buffer.from(staged);
    throw new Error(`unexpected execSync call: ${cmd}`);
  });

  const fake = createFakePi();
  writeFeatureStateFile(slug, EXECUTE_ACTIVE);
  workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

  // Apply settings AFTER extension init so loadSettingsIntoMemory doesn't overwrite
  setTestSettings(null);
  setSetting("preCommitDiscipline", opts.preCommitDiscipline);
  setSetting("testingDiscipline", testingDiscipline);

  const onToolCall = getSingleHandler(fake.handlers, "tool_call");
  const onToolResult = getSingleHandler(fake.handlers, "tool_result");

  const ctx = {
    hasUI,
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget: () => {},
      select: async () => {
        throw new Error("should not prompt");
      },
      notify: () => {},
      setEditorText: () => {},
    },
  } as unknown as ExtensionContext;
  // Set subagent mode based on hasUI so isSubagentSession() matches test intent
  if (hasUI) {
    disableSubagentMode();
  } else {
    enableSubagentMode();
  }
  await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

  return { fake, onToolCall, onToolResult, ctx };
}

describe("consolidated pre-commit gate", () => {
  // Scenario 1: off mode — no gate fires
  test("off mode: no gate fires even with staged source files", async () => {
    const { onToolCall, onToolResult, ctx } = await setupGate("test-cpcg-off", {
      preCommitDiscipline: "off",
      stagedFiles: "src/foo.ts\n",
    });

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const text = ((toolRes as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).not.toContain("PRE-COMMIT GATE");
  });

  // Scenario 2: advisory mode — warns on uncovered files
  test("advisory mode: warns on uncovered source files, never blocks", async () => {
    const { onToolCall, onToolResult, ctx } = await setupGate("test-cpcg-advisory", {
      preCommitDiscipline: "advisory",
      stagedFiles: "src/uncovered.ts\n",
    });

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(((toolRes as { content?: Array<{ text?: string }> })?.content?.[0] as { text?: string })?.text).toContain(
      "PRE-COMMIT GATE",
    );
    expect(((toolRes as { content?: Array<{ text?: string }> })?.content?.[0] as { text?: string })?.text).toContain(
      "uncovered.ts",
    );
  });

  // Scenario 3: strict mode — blocks in interactive
  test("strict mode: blocks commit in interactive mode", async () => {
    const { onToolCall, ctx } = await setupGate("test-cpcg-strict", {
      preCommitDiscipline: "strict",
      stagedFiles: "src/uncovered.ts\n",
      hasUI: true,
    });

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).toMatchObject({ block: true });
    expect((res as { reason?: string }).reason).toContain("Pre-commit gate");
    expect((res as { reason?: string }).reason).toContain("uncovered.ts");
  });

  // Scenario 4: strict mode — blocks in headless too (a strict gate is not bypassable by session kind)
  test("strict mode: blocks in headless mode (identical to interactive)", async () => {
    const { onToolCall, ctx } = await setupGate("test-cpcg-strict-headless", {
      preCommitDiscipline: "strict",
      stagedFiles: "src/uncovered.ts\n",
      hasUI: false,
    });

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).toMatchObject({ block: true });
  });

  // Scenario 5: No source files staged → passes
  test("no source files staged: passes without warning", async () => {
    const { onToolCall, onToolResult, ctx } = await setupGate("test-cpcg-no-source", {
      preCommitDiscipline: "strict",
      stagedFiles: "docs/readme.md\npackage.json\n",
    });

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const text = ((toolRes as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).not.toContain("PRE-COMMIT GATE");
  });

  // Scenario 6: Staged source files have tests + verified → passes
  test("covered source files with verified tests: passes", async () => {
    withTempCwd();
    const { onToolCall, onToolResult, ctx } = await setupGate("test-cpcg-covered-verified", {
      preCommitDiscipline: "strict",
      // Coverage is now staged-set-based: the commit must INCLUDE a corresponding test.
      stagedFiles: "src/feature.ts\nsrc/feature.test.ts\n",
    });

    // Run a passing test to set verified=true
    await onToolResult(
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "bash",
        input: { command: "npx vitest run" },
        content: [{ type: "text", text: "1 passed" }],
        details: { exitCode: 0 },
      } as unknown as ExtensionEvent,
      ctx,
    );

    // Now commit should pass
    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const text = ((toolRes as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).not.toContain("PRE-COMMIT GATE");
  });

  // Scenario 7: Verified but uncovered → uncovered listed
  test("verified but uncovered: violation for uncovered only", async () => {
    const { onToolCall, onToolResult, ctx } = await setupGate("test-cpcg-verified-uncovered", {
      preCommitDiscipline: "advisory",
      stagedFiles: "src/uncovered.ts\n",
    });

    // Run a passing test to set verified=true
    await onToolResult(
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "bash",
        input: { command: "npx vitest run" },
        content: [{ type: "text", text: "1 passed" }],
        details: { exitCode: 0 },
      } as unknown as ExtensionEvent,
      ctx,
    );

    // Commit should warn (uncovered) but NOT say "Run tests"
    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const warning = ((toolRes as { content?: Array<{ text?: string }> })?.content?.[0] as { text?: string })?.text;
    expect(warning).toContain("PRE-COMMIT GATE");
    expect(warning).toContain("uncovered.ts");
    expect(warning).toContain("Write tests before committing");
    expect(warning).not.toContain("Run tests before committing");
  });

  // Scenario 8: Uncovered + unverified → single consolidated violation
  test("uncovered and unverified: single consolidated violation", async () => {
    const { onToolCall, ctx } = await setupGate("test-cpcg-both", {
      preCommitDiscipline: "strict",
      stagedFiles: "src/uncovered.ts\n",
      hasUI: true,
    });

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).toMatchObject({ block: true });
    expect((res as { reason?: string }).reason).toContain("Pre-commit gate");
    // Block reason should mention both uncovered and verification
    expect((res as { reason?: string }).reason).toContain("uncovered.ts");
    expect((res as { reason?: string }).reason).toContain("verification");
  });

  // Scenario 8b: Covered but not verified → "Run tests" only
  test("covered but not verified: violation for not verified only", async () => {
    withTempCwd();
    const { onToolCall, onToolResult, ctx } = await setupGate("test-cpcg-notverified", {
      preCommitDiscipline: "advisory",
      // Coverage is staged-set-based: stage the test alongside the source.
      stagedFiles: "src/feature.ts\nsrc/feature.test.ts\n",
    });

    // Do NOT run tests — verified remains false

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const warning = ((toolRes as { content?: Array<{ text?: string }> })?.content?.[0] as { text?: string })?.text;
    expect(warning).toContain("PRE-COMMIT GATE");
    expect(warning).toContain("Run tests before committing");
    expect(warning).not.toContain("Write tests before committing");
    expect(warning).not.toContain("uncovered");
  });

  // Scenario 8c: Covered but not verified → strict mode blocks with verification reason
  test("strict mode: blocks commit when covered but not verified", async () => {
    withTempCwd();
    const { onToolCall, ctx } = await setupGate("test-cpcg-strict-notverified", {
      preCommitDiscipline: "strict",
      stagedFiles: "src/feature.ts\nsrc/feature.test.ts\n",
      hasUI: true,
    });

    // Do NOT run tests — verified remains false

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).toMatchObject({ block: true });
    expect((res as { reason?: string }).reason).toContain("Pre-commit gate");
    // Block reason should mention verification but NOT uncovered files
    expect((res as { reason?: string }).reason).toContain("verification");
    expect((res as { reason?: string }).reason).not.toContain("feature.ts");
  });

  // Scenario 8d: Advisory uncovered + not verified → combined warning
  test("advisory: combined uncovered + not verified warning", async () => {
    const { onToolCall, onToolResult, ctx } = await setupGate("test-cpcg-advisory-both", {
      preCommitDiscipline: "advisory",
      stagedFiles: "src/uncovered.ts\n",
    });

    // Do NOT run tests — verified remains false

    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const warning = ((toolRes as { content?: Array<{ text?: string }> })?.content?.[0] as { text?: string })?.text;
    expect(warning).toContain("PRE-COMMIT GATE");
    // Combined warning should mention both uncovered files AND run tests
    expect(warning).toContain("lack test files");
    expect(warning).toContain("Run tests before committing");
  });

  // Scenario 9: Uncovered + waived → only uncovered
  test("uncovered with waived verification: violation for uncovered only", async () => {
    const { onToolCall, onToolResult, ctx } = await setupGate("test-cpcg-waived", {
      preCommitDiscipline: "advisory",
      stagedFiles: "src/uncovered.ts\n",
    });

    // Trigger waiver via the handler bridge
    const wmGlobal = globalThis.__piWorkflowMonitor as PiWorkflowMonitorBridge;
    expect(wmGlobal).toBeDefined();
    wmGlobal.handler.recordVerificationWaiver();

    // Commit should warn for uncovered but NOT mention "Run tests"
    const res = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });

    const toolRes = await onToolResult(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'test'" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      ctx,
    );
    const warning = ((toolRes as { content?: Array<{ text?: string }> })?.content?.[0] as { text?: string })?.text;
    expect(warning).toContain("PRE-COMMIT GATE");
    expect(warning).toContain("uncovered.ts");
    expect(warning).toContain("Write tests before committing");
    expect(warning).not.toContain("Run tests before committing");
  });

  // Scenario 10: Non-commit commands pass through
  test("non-commit commands pass through pre-commit gate (publish gate is separate)", async () => {
    const { onToolCall, ctx } = await setupGate("test-cpcg-noncommit", {
      preCommitDiscipline: "strict",
      stagedFiles: "src/foo.ts\n",
    });

    // git push is now blocked by the PUBLISH gate (push before finish) — a separate gate
    // from pre-commit discipline. This confirms pre-commit discipline is not what blocks it.
    const pushRes = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git push" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(pushRes).toMatchObject({ block: true });

    // git add is neither a commit nor a publish → passes both gates.
    const addRes = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "c2",
        toolName: "bash",
        input: { command: "git add ." },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(addRes).not.toMatchObject({ block: true });
  });

  // Scenario 11: getVerificationState() returns correct values
  test("getVerificationState returns correct values", async () => {
    const { onToolResult, ctx } = await setupGate("test-cpcg-state", {
      preCommitDiscipline: "advisory",
    });

    const wmGlobal = globalThis.__piWorkflowMonitor as PiWorkflowMonitorBridge;
    expect(wmGlobal).toBeDefined();

    // Initial state: unverified, not waived → "not-run"
    const initial = wmGlobal.handler.getVerificationState();
    expect(initial).toBe("not-run");

    // After passing test: verified → "passed"
    await onToolResult(
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "bash",
        input: { command: "npx vitest run" },
        content: [{ type: "text", text: "1 passed" }],
        details: { exitCode: 0 },
      } as unknown as ExtensionEvent,
      ctx,
    );
    const afterPass = wmGlobal.handler.getVerificationState();
    expect(afterPass).toBe("passed");

    // After waiver: passed takes precedence (a verified run wins over a waiver),
    // so the 3-state gate stays "passed".
    wmGlobal.handler.recordVerificationWaiver();
    const afterWaiver = wmGlobal.handler.getVerificationState();
    expect(afterWaiver).toBe("passed");
  });
});

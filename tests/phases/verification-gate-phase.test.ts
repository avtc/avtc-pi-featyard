// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { PHASE_PROGRESSION_ENTRY_TYPE } from "../../src/phases/phase-progression.js";
import { createFakePi, fireAllHandlers, getSingleHandler } from "../helpers/workflow-monitor-test-helpers.js";

describe("verification gate phase-awareness", () => {
  test("does not inject verification warning for git commit during design", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: PHASE_PROGRESSION_ENTRY_TYPE,
            data: {
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
            },
          },
        ],
      },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;

    await fireAllHandlers(fake.handlers, "session_start", {}, ctx);

    await onToolCall(
      { toolCallId: "c1", toolName: "bash", input: { command: "git commit -m 'docs'" } } as unknown as ExtensionEvent,
      ctx,
    );

    const res = await onToolResult(
      {
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'docs'" },
        content: [{ type: "text", text: "ok" }],
        details: { exitCode: 0 },
      } as unknown as ExtensionEvent,
      ctx,
    );

    const text = ((res as { content?: unknown[] })?.content ?? [])
      .filter((c: unknown) => (c as { type: string }).type === "text")
      .map((c: unknown) => (c as { text: string }).text)
      .join("\n");

    expect(text).not.toContain("VERIFICATION REQUIRED");
    expect(text).not.toContain("without running verification");
  });
});

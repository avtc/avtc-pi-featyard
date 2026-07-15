// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import {
  createFakePi,
  fireAllHandlers,
  getSingleHandler,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

const _BRAINSTORM_ACTIVE = {
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

describe("extension-level agent phase transition guard", () => {
  test("skill file read does not trigger phase transition (agent-initiated transitions removed)", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-skill-read-blocked", {
      workflow: {
        phases: {
          design: "done",
          plan: "in-progress",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "plan",
        artifacts: {
          design: "docs/plans/design.md",
          plan: null,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Agent reads fy-implement skill — no longer triggers phase transition
    const result = await onToolResult(
      {
        toolCallId: "s1",
        toolName: "read",
        input: { path: "skills/fy-implement/SKILL.md" },
        content: [{ type: "text", text: "skill content" }],
      } as unknown as ExtensionEvent,
      ctx,
    );

    // Should NOT inject phase transition warnings or blocks
    const text = ((result as unknown as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n");
    expect(text).not.toContain("PHASE TRANSITION BLOCKED");
    expect(text).not.toContain("PHASE TRANSITION WARNING");
  });

  test("skill file read to next phase is allowed when current has artifact", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-skill-read-allowed", {
      workflow: {
        phases: {
          design: "done",
          plan: "in-progress",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "plan",
        artifacts: {
          design: "docs/plans/design.md",
          plan: "docs/plans/impl.md",
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Agent reads fy-implement skill — plan has artifact, should be allowed
    const result = await onToolResult(
      {
        toolCallId: "s1",
        toolName: "read",
        input: { path: "skills/fy-implement/SKILL.md" },
        content: [{ type: "text", text: "skill content" }],
      } as unknown as ExtensionEvent,
      ctx,
    );

    // Should NOT inject a phase transition warning (may inject other things like branch notice)
    const text = ((result as unknown as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n");
    expect(text).not.toContain("PHASE TRANSITION BLOCKED");
  });
});

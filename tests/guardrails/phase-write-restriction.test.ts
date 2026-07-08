// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { createFakePi, fireAllHandlers, getSingleHandler } from "../helpers/workflow-monitor-test-helpers.js";

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

const PLAN_ACTIVE = {
  phases: {
    design: "completed",
    plan: "in-progress",
    implement: "pending",
    verify: "pending",
    review: "pending",
    finish: "pending",
  },
  currentPhase: "plan",
  artifacts: {
    design: "docs/ff/designs/test-design.md",
    plan: null,
    implement: null,
    verify: null,
    review: null,
    finish: null,
  },
};

describe("phase-write-restriction: allowed paths during design/plan", () => {
  test("docs/plans/ writes are allowed during design", async () => {
    const fake = createFakePi();
    fake.api; // trigger cwd change
    const { writeFeatureStateFile } = await import("../helpers/workflow-monitor-test-helpers.js");
    writeFeatureStateFile("test-pwr-plans", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, select: async () => "Yes, continue", setEditorText: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const res = await onToolCall(
      {
        toolCallId: "w1",
        toolName: "write",
        input: { path: "docs/ff/designs/test-design.md", content: "# Design" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });
  });

  test("ff/reviews/ writes are allowed during design", async () => {
    const fake = createFakePi();
    fake.api;
    const { writeFeatureStateFile } = await import("../helpers/workflow-monitor-test-helpers.js");
    writeFeatureStateFile("test-pwr-reviews", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, select: async () => "Yes, continue", setEditorText: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const res = await onToolCall(
      {
        toolCallId: "w1",
        toolName: "write",
        input: { path: ".ff/reviews/test-feature/test-feature-known-issues.md", content: "# Known Issues" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });
  });

  test("ff/research/ writes are allowed during design", async () => {
    const fake = createFakePi();
    fake.api;
    const { writeFeatureStateFile } = await import("../helpers/workflow-monitor-test-helpers.js");
    writeFeatureStateFile("test-pwr-research", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, select: async () => "Yes, continue", setEditorText: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const res = await onToolCall(
      {
        toolCallId: "w1",
        toolName: "write",
        input: { path: ".ff/research/test-feature/design-initial-1.md", content: "# Research" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });
  });

  test("ff/reviews/ writes are allowed during plan phase", async () => {
    const fake = createFakePi();
    fake.api;
    const { writeFeatureStateFile } = await import("../helpers/workflow-monitor-test-helpers.js");
    writeFeatureStateFile("test-pwr-reviews-plan", { workflow: PLAN_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, select: async () => "Yes, continue", setEditorText: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const res = await onToolCall(
      {
        toolCallId: "w1",
        toolName: "write",
        input: { path: ".ff/reviews/test-feature/test-feature-plan-review-0.md", content: "# Plan Review" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    expect(res).not.toMatchObject({ block: true });
  });

  test("src/ writes are still blocked during design", async () => {
    const fake = createFakePi();
    fake.api;
    const { writeFeatureStateFile } = await import("../helpers/workflow-monitor-test-helpers.js");
    writeFeatureStateFile("test-pwr-src-blocked", { workflow: BRAINSTORM_ACTIVE });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    let promptCount = 0;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          promptCount++;
          return "No, stop";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // First violation: allowed (warn only)
    await onToolCall(
      { toolCallId: "w1", toolName: "write", input: { path: "src/a.ts", content: "x" } } as unknown as ExtensionEvent,
      ctx,
    );
    expect(promptCount).toBe(0);

    // Second violation: prompts and blocks
    const res = await onToolCall(
      { toolCallId: "w2", toolName: "write", input: { path: "src/b.ts", content: "y" } } as unknown as ExtensionEvent,
      ctx,
    );
    expect(promptCount).toBe(1);
    expect(res).toMatchObject({ block: true });
  });
});

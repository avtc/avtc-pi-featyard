// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFERRED_COMPACT_FOLLOWUP_MS } from "../../src/compaction/compact-handler.js";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import type { CompactFollowUp } from "../../src/shared/types.js";
import {
  createFakePi,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  withTempCwd,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("session_compact stored-message pattern", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    withTempCwd();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
    // Clean up any leftover globalThis state
    delete globalThis.__piCompactFollowUp;
    enableSubagentMode();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
    delete globalThis.__piCompactFollowUp;
  });

  test("reads stored __piCompactFollowUp and includes it in followUp", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Advance to execute phase so there's an active skill
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput(
      { type: "input", text: "/skill:fy-implement" } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );

    // Set stored message BEFORE compact
    globalThis.__piCompactFollowUp = {
      message: "Review iteration complete. Continue with next task.",
    };

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Handler should have sent exactly one followUp that includes the stored message
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toContain("Review iteration complete. Continue with next task.");
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-implement"/);

    // Stored message should be deleted after handler runs
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
  });

  test("deletes __piCompactFollowUp after reading even when no active skill", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // No skill active — no workflow state

    // Set stored message
    globalThis.__piCompactFollowUp = {
      message: "Plan tracker continuation",
    };

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Stored message IS sent as followUp (even without skill)
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toContain("Plan tracker continuation");

    // Stored message MUST be deleted after use
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
  });

  test("stored message is sent as followUp when present (even without skill)", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Set stored message
    globalThis.__piCompactFollowUp = {
      message: "Inter-task reset continuation message",
    };

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Stored message should be sent as followUp
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toContain("Inter-task reset continuation message");

    // Deleted after use
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
  });

  test("combines stored message with skill injection", async () => {
    const slug = "test-stored-msg";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        featureSlug: slug,
        activeFeatureSlug: slug,
        executionMode: "checkpoint",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        workflow: {
          currentPhase: "implement",
          designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
          planDoc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
        },
        tdd: { stage: "idle", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: { passed: false, waived: false },
        design: { doc: "docs/featyard/designs/2026-05-10-test-design.md", reviewActive: false, reviewLoopCount: 0 },
        plan: {
          doc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
          verifyLoopCount: 0,
          reviewActive: false,
          reviewLoopCount: 0,
        },
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      }),
    );

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // Set stored message
    globalThis.__piCompactFollowUp = {
      message: "Review loop done. Continue.",
    };

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Single combined followUp with both stored message and skill
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toContain("Review loop done. Continue.");
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-implement"/);
  });

  test("suppress flag no longer exists — handler runs full injection", async () => {
    // Verify that setSuppressSessionCompactInjection is not exported
    const wfModule = await import("../../src/index.js");
    expect((wfModule as Record<string, unknown>).setSuppressSessionCompactInjection).toBeUndefined();
  });

  test("calls onAfterFollowUp callback after sending followUp", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    const onAfterFollowUp = vi.fn();

    // Set stored message WITH callback
    globalThis.__piCompactFollowUp = {
      message: "Post-compact callback test",
      onAfterFollowUp,
    };

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // FollowUp message should be sent
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toContain("Post-compact callback test");

    // Callback should have been called exactly once
    expect(onAfterFollowUp).toHaveBeenCalledOnce();

    // Stored message should be cleaned up
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
  });

  test("handles __piCompactFollowUp = null gracefully", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Set to null
    globalThis.__piCompactFollowUp = undefined;

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    // Should not throw
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Should be cleaned up
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
  });

  test("handles __piCompactFollowUp as string instead of object", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Set to a plain string (malformed)
    globalThis.__piCompactFollowUp = "not-an-object" as unknown as CompactFollowUp;

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    // Should not throw
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Should be cleaned up
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
  });

  test("handles __piCompactFollowUp with missing message property", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Object without message property
    globalThis.__piCompactFollowUp = { source: "test" } as unknown as CompactFollowUp;

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    // Should not throw
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Should be cleaned up
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
    // Should NOT send a followUp (no message to send)
    expect(sendUserMessageCalls.length).toBe(0);
  });

  test("handles __piCompactFollowUp with empty message", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Object with empty message
    globalThis.__piCompactFollowUp = { message: "", source: "test" } as unknown as CompactFollowUp;

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    // Should not throw
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Should be cleaned up
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
    // Empty message is falsy — should NOT send a followUp
    expect(sendUserMessageCalls.length).toBe(0);
  });

  test("appends todo item from pi-todo:ready API when present", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Advance to execute phase
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput(
      { type: "input", text: "/skill:fy-implement" } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );

    // Wire todo integration so getTodoInProgressItem() works after event
    // Emit pi-todo:ready with getInProgressItem API
    piApi.events.emit("pi-todo:ready", {
      disableBuiltInFollowUp: () => {},
      getCompletedItemId: () => null,
      getInProgressItem: () => "▶ 3: Implement feature\nAdd the main implementation",
    });

    // Set stored message
    globalThis.__piCompactFollowUp = {
      message: "Review complete",
    };

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Single combined followUp: skill + stored message + todo
    expect(sendUserMessageCalls.length).toBe(1);
    const msg = sendUserMessageCalls[0];
    expect(msg).toMatch(/^<skill name="fy-implement"/);
    expect(msg).toContain("Review complete");
    expect(msg).toContain("▶ 3: Implement feature");
  });
});

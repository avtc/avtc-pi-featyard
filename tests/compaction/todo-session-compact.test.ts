// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFERRED_COMPACT_FOLLOWUP_MS } from "../../src/compaction/compact-handler.js";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { createFakePi, getSingleHandler, writeFeatureStateFile } from "../helpers/workflow-monitor-test-helpers.js";

describe("workflow-monitor session_compact — todo re-injection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
  });

  function setupReviewFeature(slug: string) {
    process.env.PI_FY_FEATURE = slug;
    writeFeatureStateFile(slug, {
      featureSlug: slug,
      designDoc: "docs/featyard/designs/test-design.md",
      branch: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "done",
          review: "in-progress",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "review",
        artifacts: { design: "docs/featyard/designs/test-design.md" },
      },
    });
  }

  /** No in-progress item available */
  const NO_FOLLOW_UP: string | null = null;

  /** Emit pi-todo:ready with a mock API whose getInProgressItem returns `followUp` (and no completedId). */
  function emitTodoReady(fake: ReturnType<typeof createFakePi>, followUp: string | null) {
    fake.api.events.emit("pi-todo:ready", {
      disableBuiltInFollowUp() {},
      getCompletedItemId: () => null,
      getInProgressItem: () => followUp,
      areAllTodosDone: () => false,
    });
  }

  test("injects in_progress todo item after compaction during review phase", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    setupReviewFeature("2026-05-18-todo-compact-test");
    // pi-todo reports an in_progress item via the bridge
    emitTodoReady(fake, "▶ 1: Build PoC\nCreate proof of concept");

    const compactHandler = getSingleHandler(fake.handlers, "session_compact");
    await compactHandler({} as unknown as ExtensionEvent, { hasUI: false } as unknown as ExtensionContext);
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    const todoMessages = fake.sentMessages.filter(
      (m) => typeof m.message === "string" && m.message.includes("Build PoC"),
    );
    expect(todoMessages.length).toBeGreaterThan(0);
    expect(todoMessages[0].message).toContain("Build PoC");
    expect(todoMessages[0].message).toContain("Create proof of concept");
    expect(todoMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  test("does not inject when no in_progress item exists", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    setupReviewFeature("2026-05-18-todo-no-active");
    // pi-todo reports no in_progress item
    emitTodoReady(fake, NO_FOLLOW_UP);

    const compactHandler = getSingleHandler(fake.handlers, "session_compact");
    await compactHandler({} as unknown as ExtensionEvent, { hasUI: false } as unknown as ExtensionContext);
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Should NOT have sent a followUp
    const followUps = fake.sentMessages.filter(
      (m) => (m.options as { deliverAs?: string } | undefined)?.deliverAs === "followUp",
    );
    expect(followUps).toHaveLength(0);
  });

  test("handles null followUp gracefully", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    setupReviewFeature("2026-05-18-todo-empty");
    emitTodoReady(fake, NO_FOLLOW_UP);

    const compactHandler = getSingleHandler(fake.handlers, "session_compact");
    // Should not throw
    await expect(
      compactHandler({} as unknown as ExtensionEvent, { hasUI: false } as unknown as ExtensionContext),
    ).resolves.not.toThrow();
  });

  test("skips todo re-injection when agentJustFinished is true (manual /compact)", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    setupReviewFeature("2026-05-18-todo-manual-compact");
    emitTodoReady(fake, "▶ 1: Active task\nShould not be injected");

    // Simulate agent_end (sets agentJustFinished = true)
    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd({} as unknown as ExtensionEvent, { hasUI: false } as unknown as ExtensionContext);

    const compactHandler = getSingleHandler(fake.handlers, "session_compact");
    await compactHandler({} as unknown as ExtensionEvent, { hasUI: false } as unknown as ExtensionContext);
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Should NOT have sent the todo followUp — user manually compacted
    const todoMessages = fake.sentMessages.filter(
      (m) => typeof m.message === "string" && m.message.includes("Active task"),
    );
    expect(todoMessages).toHaveLength(0);
  });
});

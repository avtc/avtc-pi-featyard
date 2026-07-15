// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFERRED_COMPACT_FOLLOWUP_MS } from "../../src/compaction/compact-handler.js";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import {
  createFakePi,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  UAT_ACTIVE_STATE,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("compaction during UAT pause", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    enableSubagentMode();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetFeatureState();
  });

  test("injects fy-review skill + framing on compaction during UAT pause (unified)", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("2026-05-16-uat-compact-test", UAT_ACTIVE_STATE);

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Reconstruct handler state
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    const onSessionCompact = getSingleHandler(fake.handlers, "session_compact");

    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;

    await onSessionCompact({} as unknown as ExtensionEvent, mockCtx);
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Unified assembly: UAT resolves to the fy-review skill + framing (no todo active)
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toMatch(/^<skill name="fy-review"/);
    expect(fake.sentMessages[0].message).toContain(
      "Context was compacted. Reminder of planned work: you are in uat phase; continue from where you left off.",
    );
    expect(fake.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  test("sends framed todo followUp on compaction during UAT pause when todo is active", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("2026-05-16-uat-compact-todo-test", UAT_ACTIVE_STATE);

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Simulate pi-todo integration: emit ready with getInProgressItem
    fake.api.events.emit("pi-todo:ready", {
      disableBuiltInFollowUp: () => {},
      getCompletedItemId: () => null,
      getInProgressItem: () => "TODO #5: Some pending task\nDetails here",
    });

    // Reconstruct handler state
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    const onSessionCompact = getSingleHandler(fake.handlers, "session_compact");

    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;

    await onSessionCompact({} as unknown as ExtensionEvent, mockCtx);
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // UAT resolves to the fy-review skill; message = skill + framing + todo item (unified assembly)
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toMatch(/^<skill name="fy-review"/);
    expect(fake.sentMessages[0].message).toContain(
      "Context was compacted. Reminder of planned work: you are in uat phase; continue from where you left off.",
    );
    expect(fake.sentMessages[0].message).toContain("TODO #5: Some pending task\nDetails here");
    expect(fake.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  test("includes stored message and todo followUp during UAT (unified assembly)", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("2026-05-16-uat-compact-both", UAT_ACTIVE_STATE);

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Simulate pi-todo integration
    fake.api.events.emit("pi-todo:ready", {
      disableBuiltInFollowUp: () => {},
      getCompletedItemId: () => null,
      getInProgressItem: () => "TODO #3: Review changes\nCheck all files",
    });

    // Reconstruct handler state
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "new" },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    // Store a pending followUp message (simulating compact trigger)
    globalThis.__piCompactFollowUp = {
      message: "Stored compact message included under unified assembly",
    };

    const onSessionCompact = getSingleHandler(fake.handlers, "session_compact");

    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: { setWidget: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;

    await onSessionCompact({} as unknown as ExtensionEvent, mockCtx);
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Unified assembly: skill + framing + stored note + todo item (single message)
    expect(fake.sentMessages.length).toBe(1);
    expect(fake.sentMessages[0].message).toMatch(/^<skill name="fy-review"/);
    expect(fake.sentMessages[0].message).toContain(
      "Context was compacted. Reminder of planned work: you are in uat phase; continue from where you left off.",
    );
    expect(fake.sentMessages[0].message).toContain("Stored compact message included under unified assembly");
    expect(fake.sentMessages[0].message).toContain("TODO #3: Review changes\nCheck all files");
    expect(fake.sentMessages[0].options).toEqual({ deliverAs: "followUp" });

    // Stored message should be cleaned up
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
  });
});

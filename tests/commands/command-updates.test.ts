// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { createFeatureState, loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  fireAllHandlers,
  getSingleHandler,
  withTempCwd,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("ff:reset with per-feature state", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  test("clears env var and activeFeatureSlug but preserves state file", async () => {
    withTempCwd();
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Create a feature state file
    const slug = "2026-05-08-reset-test";

    // Set up the extension with the feature active
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    // Writing the design doc bootstraps + activates the feature (SOTS: the
    // handler holds the active record). No pre-created file — the write creates it.
    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: `docs/ff/designs/${slug}-design.md` },
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(getActiveFeatureSlug()).toBe(slug);
    expect(loadFeatureState(slug, null)).not.toBeNull();

    // Register ff:reset command from same module-level state
    const commands2 = new Map<string, (args: string, ctx: ExtensionCommandContext) => void>();
    const api = {
      on(event: string, handler: unknown) {
        const list = fake.handlers.get(event) ?? [];
        list.push(handler as (event: ExtensionEvent, ctx: ExtensionContext) => unknown);
        fake.handlers.set(event, list);
      },
      events: {
        on() {
          return () => {};
        },
      },
      registerTool() {},
      appendEntry() {},
      registerCommand(
        name: string,
        opts: { description: string; handler: (input: string, ctx: ExtensionCommandContext) => void },
      ) {
        commands2.set(name, opts.handler);
      },
    };
    delete (globalThis as Record<string, unknown>).__avtcPiFeatureFlowWired;
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const handler = commands2.get("ff:reset");
    expect(handler).toBeDefined();

    if (handler)
      await handler("", {
        hasUI: false,
        ui: { notify: vi.fn(), setWidget: () => {} },
      } as unknown as ExtensionCommandContext);

    // The feature state file should be preserved on disk
    expect(loadFeatureState(slug, null)).not.toBeNull();
    // The active slug should be cleared
    expect(getActiveFeatureSlug()).toBeNull();
    // The env var should be cleared
    expect(process.env.PI_FF_FEATURE).toBeUndefined();
  });
});

describe("ff:next with per-feature state", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  test("completes current phase and advances to next in-session", async () => {
    withTempCwd();
    setTestSettings({ maxFeatureReviewRounds: 3 });
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Create a feature in verify phase
    const slug = "2026-05-08-next-test";
    const state = createFeatureState(slug, `docs/ff/designs/${slug}-design.md`);
    state.workflow.currentPhase = "verify";
    saveFeatureState(state, null);

    // Set the feature active
    process.env.PI_FF_FEATURE = slug;

    let newSessionCalls = 0;
    const mockCtx = {
      hasUI: true,
      sessionManager: {
        getBranch: () => [],
        getSessionFile: () => "/path/to/session.json",
      },
      ui: {
        notify: vi.fn(),
        setWidget: () => {},
        setEditorText: vi.fn(),
      },
      newSession: async (_opts?: { parentSession?: string; withSession?: (ctx: unknown) => Promise<void> }) => {
        newSessionCalls++;
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;

    // Reconstruct state from the file (using the same extension instance)
    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, mockCtx);

    const handler = fake.registeredCommands.get("ff:next");
    expect(handler).toBeDefined();
    if (handler) await (handler as (args: string, ctx: ExtensionCommandContext) => void)("", mockCtx);

    // Should NOT create a new session (old behavior removed)
    expect(newSessionCalls).toBe(0);

    // Should have sent a review skill message (verify → review)
    const reviewMsg = fake.sentMessages.find((m) => m.message.includes("ff-review"));
    expect(reviewMsg).toBeDefined();
  });
});

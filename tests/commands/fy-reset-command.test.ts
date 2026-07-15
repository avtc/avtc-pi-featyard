// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { isPhasePending } from "../../src/phases/phase-progression.js";
import { createFeatureState, loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { cleanupAfterTest, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Boots the extension and returns a map of { commandName → handler }.
 * Also captures appendedEntries so we can inspect persisted state.
 */
function setup() {
  // Run inside a temp dir so production init's ensureFeatyardJunction(process.cwd()) never touches
  // the real repo's .featyard.
  withTempCwd();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];

  const fakePi = {
    on() {},
    events: {
      on() {
        return () => {};
      },
    },
    registerTool() {},
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    registerCommand(name: string, opts: Omit<RegisteredCommand, "name">) {
      commands.set(name, opts.handler);
    },
  };

  workflowMonitorExtension(fakePi as unknown as ExtensionAPI);
  return { commands, appendedEntries };
}

/**
 * Boots both extensions and captures tool/command registrations.
 */
function _setupBoth() {
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const tools = new Map<string, unknown>();

  const fakePi = {
    on() {},
    events: {
      on() {
        return () => {};
      },
    },
    appendEntry() {},
    registerCommand(name: string, opts: Omit<RegisteredCommand, "name">) {
      commands.set(name, opts.handler);
    },
    registerTool(opts: ToolDefinition) {
      tools.set(opts.name, opts);
    },
  };

  workflowMonitorExtension(fakePi as unknown as ExtensionAPI);
  return { commands, tools };
}

describe("fy:reset command", () => {
  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    cleanupAfterTest();
  });

  test("command is registered with the expected name and description", () => {
    withTempCwd();
    const descriptions = new Map<string, string>();
    const fakePi = {
      on() {},
      events: {
        on() {
          return () => {};
        },
      },
      registerTool() {},
      appendEntry() {},
      registerCommand(name: string, opts: Omit<RegisteredCommand, "name">) {
        descriptions.set(name, opts.description ?? "");
      },
    };
    workflowMonitorExtension(fakePi as unknown as ExtensionAPI);
    expect(descriptions.has("fy:reset")).toBe(true);
    expect(descriptions.get("fy:reset")).toMatch(/reset/i);
  });

  test("resets persisted state — workflow, tdd, debug, verification all return to defaults", async () => {
    const { commands, appendedEntries } = setup();

    const ctx = {
      hasUI: false,
      ui: { notify: vi.fn(), setWidget: () => {} },
    } as unknown as ExtensionCommandContext;

    // Call the command
    const handler = commands.get("fy:reset");
    expect(handler).toBeDefined();
    await handler?.("", ctx);

    // State should have been persisted
    expect(appendedEntries.length).toBeGreaterThan(0);
    const lastEntry = appendedEntries.at(-1);
    if (!lastEntry) throw new Error("No appended entry");
    // New wrapper shape: { featureState, guardrailsState }
    expect(
      (lastEntry.data as { phase: string; slug: string; featureState: unknown; guardrailsState: unknown }).featureState,
    ).toBeNull();
    expect(
      (lastEntry.data as { phase: string; slug: string; featureState: unknown; guardrailsState: unknown })
        .guardrailsState,
    ).toBeDefined();

    // No active feature → pointer null → every phase derived pending
    const wfView = { currentPhase: null, completedAt: null };
    for (const phase of ["design", "plan", "implement", "verify", "review", "uat", "finish"]) {
      expect(isPhasePending(wfView, phase as "design")).toBe(true);
    }

    // Verification should be at its neutral default (session-only tier). The
    // TDD write-order check is stateless, so there is no `tdd` slice to reset.
    expect((lastEntry.data as { guardrailsState: { verification: string } }).guardrailsState.verification).toBe(
      "not-run",
    );
  });

  test("notifies user with info level when UI is present", async () => {
    const { commands } = setup();

    const notifications: [string, string][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: (msg: string, level: string) => notifications.push([msg, level]),
        setWidget: () => {},
      },
    } as unknown as ExtensionCommandContext;

    const handler = commands.get("fy:reset");
    await handler?.("", ctx);

    expect(notifications.length).toBe(1);
    expect(notifications[0]?.[1]).toBe("info");
    expect(notifications[0]?.[0]).toMatch(/reset/i);
  });

  test("does not throw and does not notify when UI is absent", async () => {
    const { commands } = setup();

    const ctx = {
      hasUI: false,
      ui: { notify: vi.fn(), setWidget: () => {} },
    } as unknown as ExtensionCommandContext;

    const handler = commands.get("fy:reset");
    await expect(handler?.("", ctx)).resolves.not.toThrow();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("clears PI_FY_FEATURE env var and activeFeatureSlug", async () => {
    process.env.PI_FY_FEATURE = "2026-05-10-test-feature";
    const { commands } = setup();

    const ctx = {
      hasUI: false,
      ui: { notify: vi.fn(), setWidget: () => {} },
    } as unknown as ExtensionCommandContext;

    const handler = commands.get("fy:reset");
    await handler?.("", ctx);

    expect(process.env.PI_FY_FEATURE).toBeUndefined();
    expect(getActiveFeatureSlug()).toBeNull();
  });

  test("preserves state file on disk — does not delete it", async () => {
    try {
      const { commands } = setup();

      const slug = "2026-05-10-persist-test";
      const state = createFeatureState(slug, "docs/featyard/designs/2026-05-10-persist-test-design.md");
      state.workflow.currentPhase = "implement";
      saveFeatureState(state, null);
      process.env.PI_FY_FEATURE = slug;

      // Verify state file exists
      const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
      expect(fs.existsSync(statePath)).toBe(true);

      const ctx = {
        hasUI: false,
        ui: { notify: vi.fn(), setWidget: () => {} },
      } as unknown as ExtensionCommandContext;

      const handler = commands.get("fy:reset");
      await handler?.("", ctx);

      // State file should still exist on disk
      expect(fs.existsSync(statePath)).toBe(true);
      const saved = loadFeatureState(slug, null);
      expect(saved).not.toBeNull();
    } finally {
      cleanupAfterTest();
    }
  });
});

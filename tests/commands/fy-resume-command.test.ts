// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { createFeatureState, loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { cleanupAfterTest, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

type CommandEntry = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>; description: string };

/**
 * Creates a fake pi that tracks registered commands.
 * Optionally tracks appended entries.
 */
function createCommandTrackingPi() {
  const commands = new Map<string, CommandEntry>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];

  const fakePi = {
    on() {},
    events: (() => {
      const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
      return {
        on(channel: string, handler: (data: unknown) => void) {
          const list = eventHandlers.get(channel) ?? [];
          list.push(handler);
          eventHandlers.set(channel, list);
          return () => {
            const list = eventHandlers.get(channel);
            if (list) {
              const idx = list.indexOf(handler);
              if (idx >= 0) list.splice(idx, 1);
            }
          };
        },
      };
    })(),
    registerTool() {},
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    registerCommand(name: string, opts: Omit<RegisteredCommand, "name">) {
      commands.set(name, { handler: opts.handler, description: opts.description ?? "" });
    },
  };

  return { fakePi, commands, appendedEntries };
}

/**
 * Boots the extension and returns a map of { commandName → { handler, description } }.
 * Changes to a temp CWD to avoid state file pollution.
 */
function setup() {
  withTempCwd();
  const { fakePi, commands, appendedEntries } = createCommandTrackingPi();
  workflowMonitorExtension(fakePi as unknown as ExtensionAPI);
  return { commands, appendedEntries };
}

describe("fy:resume command", () => {
  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_STAGE;
    delete process.env.PI_FY_REVIEW_LOOP;
    cleanupAfterTest();
  });

  test("command is registered with the expected name and description", () => {
    // Still need a temp CWD: loading the extension runs init → ensureFeatyardJunction(process.cwd()),
    // which must not touch the real repo's .featyard.
    withTempCwd();
    const { fakePi, commands } = createCommandTrackingPi();
    workflowMonitorExtension(fakePi as unknown as ExtensionAPI);
    expect(commands.has("fy:resume")).toBe(true);
    expect(commands.get("fy:resume")?.description).toMatch(/continue|workflow|feature/i);
  });

  test("requires UI — notifies error when hasUI is false", async () => {
    const { commands } = setup();

    const notifications: [string, string][] = [];
    const ctx = {
      hasUI: false,
      ui: {
        notify: (msg: string, level: string) => notifications.push([msg, level]),
        setWidget: () => {},
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    expect(notifications.length).toBe(1);
    expect(notifications[0]?.[1]).toBe("error");
    expect(notifications[0]?.[0]).toMatch(/interactive/i);
  });

  test("no active features — notifies info and returns", async () => {
    const { commands } = setup();

    const notifications: [string, string][] = [];
    let selectCalled = false;
    const ctx = {
      hasUI: true,
      ui: {
        notify: (msg: string, level: string) => notifications.push([msg, level]),
        setWidget: () => {},
        select: async () => {
          selectCalled = true;
          return "";
        },
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    expect(selectCalled).toBe(false);
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.[1]).toBe("info");
    expect(notifications[0]?.[0]).toMatch(/no active/i);
  });

  test("shows selection dialog with features, Skip, and Manage — selecting first loads it", async () => {
    const { commands, appendedEntries } = setup();

    // Create 2 active features
    const state1 = createFeatureState("2026-05-01-alpha", "docs/featyard/designs/2026-05-01-alpha-design.md");
    state1.updatedAt = "2026-05-01T00:00:00.000Z";
    state1.workflow.currentPhase = "plan";
    saveFeatureState(state1, null);

    const state2 = createFeatureState("2026-05-02-beta", "docs/featyard/designs/2026-05-02-beta-design.md");
    state2.updatedAt = "2026-05-02T00:00:00.000Z";
    state2.workflow.currentPhase = "implement";
    saveFeatureState(state2, null);

    let selectedTitle = "";
    let selectedOptions: string[] = [];
    const notifications: [string, string][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: (msg: string, level: string) => notifications.push([msg, level]),
        setWidget: () => {},
        select: async (title: string, options: string[]) => {
          selectedTitle = title;
          selectedOptions = options;
          return options[0]; // Select first (most recently updated)
        },
        setEditorText: () => {},
        custom: async () => null,
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    // Should show 4 options: 2 features + Skip + Manage
    expect(selectedOptions.length).toBe(4);
    expect(selectedOptions[selectedOptions.length - 2]).toBe("Skip");
    expect(selectedOptions[selectedOptions.length - 1]).toBe("Manage state files");

    // Dialog title should reflect feature count
    expect(selectedTitle).toMatch(/Found 2 active features/);

    // Feature option label format should include prefix and slug
    expect(selectedOptions[0]).toMatch(/^Continue: 2026-05-02-beta/);

    // Should have loaded the most recently updated feature
    expect(getActiveFeatureSlug()).toBe("2026-05-02-beta");
    expect(process.env.PI_FY_FEATURE).toBe("2026-05-02-beta");

    // syncEnvVars should have set the stage env var
    expect(process.env.PI_FY_STAGE).toBe("implement");

    // Should have persisted state
    expect(appendedEntries.length).toBeGreaterThan(0);

    // Should have notified the user
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.[1]).toBe("info");
    expect(notifications[0]?.[0]).toMatch(/2026-05-02-beta/);
    expect(notifications[0]?.[0]).toMatch(/implement/);
  });

  test("Skip — returns without loading anything", async () => {
    const { commands } = setup();

    const state = createFeatureState("2026-05-03-skip", "docs/featyard/designs/2026-05-03-skip-design.md");
    saveFeatureState(state, null);

    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: () => {},
        select: async (_title: string, _options: string[]) => "Skip",
        setEditorText: () => {},
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    expect(getActiveFeatureSlug()).toBeNull();
    expect(process.env.PI_FY_FEATURE).toBeUndefined();
  });

  test("Manage state files — mark completed, loops back, then load remaining", async () => {
    const { commands } = setup();

    const state1 = createFeatureState(
      "2026-05-04-to-complete",
      "docs/featyard/designs/2026-05-04-to-complete-design.md",
    );
    state1.updatedAt = "2026-05-04T00:00:00.000Z";
    saveFeatureState(state1, null);

    const state2 = createFeatureState("2026-05-05-keep", "docs/featyard/designs/2026-05-05-keep-design.md");
    state2.updatedAt = "2026-05-05T00:00:00.000Z";
    state2.workflow.currentPhase = "implement";
    saveFeatureState(state2, null);

    let selectCallCount = 0;
    const capturedOptions: string[][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: () => {},
        select: async (_title: string, options: string[]) => {
          selectCallCount++;
          capturedOptions.push([...options]);
          if (selectCallCount === 1) return "Manage state files";
          return options[0]; // Load remaining feature
        },
        setEditorText: () => {},
        custom: async () => ({
          action: "mark_completed",
          slugs: ["2026-05-04-to-complete"],
        }),
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    // First feature marked done
    const completed = loadFeatureState("2026-05-04-to-complete", null);
    expect(completed?.completedAt).not.toBeNull();

    // Second feature loaded
    expect(getActiveFeatureSlug()).toBe("2026-05-05-keep");
    expect(selectCallCount).toBe(2);

    // First call shows both features + Skip + Manage
    expect(capturedOptions[0].length).toBe(4);
    // Second call (after mark_completed) shows only remaining feature + Skip + Manage
    expect(capturedOptions[1].length).toBe(3);
    expect(capturedOptions[1].some((o) => o.includes("2026-05-04-to-complete"))).toBe(false);
  });

  test("replaces currently active workflow with a different one", async () => {
    const { commands } = setup();

    // Feature A — currently active, most recently updated (sorted first)
    const stateA = createFeatureState("2026-05-06-active", "docs/featyard/designs/2026-05-06-active-design.md");
    stateA.updatedAt = "2026-05-07T00:00:00.000Z";
    stateA.workflow.currentPhase = "implement";
    saveFeatureState(stateA, null);
    process.env.PI_FY_FEATURE = "2026-05-06-active";

    // Feature B — the one we want to switch to (sorted second)
    const stateB = createFeatureState("2026-05-07-switch", "docs/featyard/designs/2026-05-07-switch-design.md");
    stateB.updatedAt = "2026-05-06T00:00:00.000Z";
    stateB.workflow.currentPhase = "plan";
    saveFeatureState(stateB, null);

    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: () => {},
        // Select the second option (Feature B — the one to switch to)
        select: async (_title: string, options: string[]) => options[1],
        setEditorText: () => {},
        custom: async () => null,
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    // Should have switched from Feature A to Feature B
    expect(getActiveFeatureSlug()).toBe("2026-05-07-switch");
    expect(process.env.PI_FY_FEATURE).toBe("2026-05-07-switch");
    expect(process.env.PI_FY_STAGE).toBe("plan");
  });

  test("Manage state files — delete action removes state file, loops back, then load remaining", async () => {
    const { commands } = setup();

    const state1 = createFeatureState("2026-05-08-to-delete", "docs/featyard/designs/2026-05-08-to-delete-design.md");
    state1.updatedAt = "2026-05-08T00:00:00.000Z";
    saveFeatureState(state1, null);

    const state2 = createFeatureState("2026-05-09-keep", "docs/featyard/designs/2026-05-09-keep-design.md");
    state2.updatedAt = "2026-05-09T00:00:00.000Z";
    state2.workflow.currentPhase = "implement";
    saveFeatureState(state2, null);

    let selectCallCount = 0;
    const capturedOptions: string[][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: () => {},
        select: async (_title: string, options: string[]) => {
          selectCallCount++;
          capturedOptions.push([...options]);
          if (selectCallCount === 1) return "Manage state files";
          return options[0]; // Load remaining feature
        },
        setEditorText: () => {},
        custom: async () => ({
          action: "delete",
          slugs: ["2026-05-08-to-delete"],
        }),
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    // First feature's state file deleted
    const deleted = loadFeatureState("2026-05-08-to-delete", null);
    expect(deleted).toBeNull();

    // Second feature loaded
    expect(getActiveFeatureSlug()).toBe("2026-05-09-keep");
    expect(selectCallCount).toBe(2);

    // First call shows both features + Skip + Manage
    expect(capturedOptions[0].length).toBe(4);
    // Second call (after delete) shows only remaining feature + Skip + Manage
    expect(capturedOptions[1].length).toBe(3);
    expect(capturedOptions[1].some((o) => o.includes("2026-05-08-to-delete"))).toBe(false);
  });

  test("Manage state files — cancel (null) loops back without mutating state", async () => {
    const { commands } = setup();

    const state1 = createFeatureState("2026-05-10-persist", "docs/featyard/designs/2026-05-10-persist-design.md");
    state1.updatedAt = "2026-05-10T00:00:00.000Z";
    state1.workflow.currentPhase = "plan";
    saveFeatureState(state1, null);

    let selectCallCount = 0;
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: () => {},
        select: async (_title: string, options: string[]) => {
          selectCallCount++;
          if (selectCallCount === 1) return "Manage state files";
          return options[0]; // Load the feature
        },
        setEditorText: () => {},
        custom: async () => null, // User cancels manage dialog
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    // Feature should still be active (not mutated by cancel)
    const persisted = loadFeatureState("2026-05-10-persist", null);
    expect(persisted?.completedAt).toBeNull();

    // Loop-back occurred: select called twice
    expect(selectCallCount).toBe(2);

    // Feature loaded on second call
    expect(getActiveFeatureSlug()).toBe("2026-05-10-persist");
  });

  test("unrecognized select choice — exits loop without error or loading", async () => {
    const { commands } = setup();

    const state = createFeatureState(
      "2026-05-11-unrecognized",
      "docs/featyard/designs/2026-05-11-unrecognized-design.md",
    );
    saveFeatureState(state, null);

    const notifications: [string, string][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: (msg: string, level: string) => notifications.push([msg, level]),
        setWidget: () => {},
        select: async () => "something-unexpected",
        setEditorText: () => {},
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    // Should not have loaded anything
    expect(getActiveFeatureSlug()).toBeNull();
    expect(process.env.PI_FY_FEATURE).toBeUndefined();

    // Should have warned about unrecognized selection
    expect(notifications.some(([msg, level]) => level === "warning" && msg.includes("Unrecognized"))).toBe(true);
  });

  test("select returns undefined (user cancels) — exits without loading or warning", async () => {
    const { commands } = setup();

    const state = createFeatureState("2026-05-12-cancel", "docs/featyard/designs/2026-05-12-cancel-design.md");
    saveFeatureState(state, null);

    const notifications: [string, string][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: (msg: string, level: string) => notifications.push([msg, level]),
        setWidget: () => {},
        select: async () => undefined,
        setEditorText: () => {},
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    // Should not have loaded anything
    expect(getActiveFeatureSlug()).toBeNull();
    expect(process.env.PI_FY_FEATURE).toBeUndefined();

    // Should NOT have warned — user cancel is silent
    expect(notifications.some(([_msg, level]) => level === "warn")).toBe(false);
  });

  test("switches to last session when feature has sessionFiles", async () => {
    const { commands } = setup();
    const cwd = process.cwd();

    // Create a temp session file that exists on disk
    const sessionDir = path.join(cwd, ".pi", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "test-session.jsonl");
    fs.writeFileSync(sessionPath, "test session content");

    const state = createFeatureState(
      "2026-05-13-session-switch",
      "docs/featyard/designs/2026-05-13-session-switch-design.md",
    );
    state.sessionFiles = [sessionPath];
    saveFeatureState(state, null);

    let switchSessionCalledWith: string | null = null;
    const notifications: [string, string][] = [];
    const ctx = {
      hasUI: true,
      switchSession: async (sp: string, options?: { withSession?: (newCtx: unknown) => Promise<void> }) => {
        switchSessionCalledWith = sp;
        if (options?.withSession) {
          await options.withSession({
            ui: {
              notify: (msg: string, level: string) => notifications.push([msg, level]),
            },
          });
        }
        return { cancelled: false };
      },
      ui: {
        notify: (msg: string, level: string) => notifications.push([msg, level]),
        setWidget: () => {},
        select: async (_title: string, options: string[]) => options[0], // Select first feature
        setEditorText: () => {},
      },
    };

    const handler = commands.get("fy:resume")?.handler;
    await handler?.("", ctx as unknown as ExtensionCommandContext);

    expect(switchSessionCalledWith).toBe(sessionPath);
    expect(process.env.PI_FY_FEATURE).toBe("2026-05-13-session-switch");
    expect(notifications.some(([msg]) => msg.includes("Resumed session"))).toBe(true);
  });
});

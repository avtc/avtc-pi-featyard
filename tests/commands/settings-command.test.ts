// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import settingsExtension, { getSettings } from "../../src/settings/settings-ui.js";

describe("fy:settings command", () => {
  test("command is registered with correct name and description", async () => {
    const commands = new Map<
      string,
      { description: string; handler: (input: string, ctx: ExtensionCommandContext) => void }
    >();
    const fakePi = {
      on() {},
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
        commands.set(name, opts);
      },
    } as unknown as ExtensionAPI;

    settingsExtension(fakePi);

    expect(commands.has("fy:settings")).toBe(true);
    expect(commands.get("fy:settings")?.description).toMatch(/settings/i);
  });

  test("command requires UI — notifies error without UI", async () => {
    const commands = new Map<
      string,
      { description: string; handler: (input: string, ctx: ExtensionCommandContext) => void }
    >();
    const fakePi = {
      on() {},
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
        commands.set(name, opts);
      },
    } as unknown as ExtensionAPI;

    settingsExtension(fakePi);

    const notify = vi.fn();
    const ctx = {
      hasUI: false,
      ui: { notify },
    } as unknown as ExtensionCommandContext;

    const handler = commands.get("fy:settings")?.handler;
    await handler?.("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/interactive/i), "warning");
  });

  test("command opens modal with ctx.ui.custom when UI is present", async () => {
    const commands = new Map<
      string,
      { description: string; handler: (input: string, ctx: ExtensionCommandContext) => void }
    >();
    const fakePi = {
      on() {},
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
        commands.set(name, opts);
      },
    } as unknown as ExtensionAPI;

    settingsExtension(fakePi);

    const customCalls: { factory: unknown; opts: { overlay?: boolean } | undefined }[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        custom: async (factory: unknown, opts: { overlay?: boolean } | undefined) => {
          customCalls.push({ factory, opts });
        },
        notify: vi.fn(),
      },
    } as unknown as ExtensionCommandContext;

    const handler = commands.get("fy:settings")?.handler;
    await handler?.("", ctx);
    expect(customCalls.length).toBe(1);
    expect(customCalls[0]?.opts?.overlay).toBe(true);
  });

  test("settings object includes planReviewMode with valid value", async () => {
    const settings = getSettings();
    expect(settings.planReviewMode).toBeDefined();
    expect(["in-session", "parallel-subagents"]).toContain(settings.planReviewMode);
  });

  test("settings object includes planReviewSubagentsMode with valid value", async () => {
    const settings = getSettings();
    expect(settings.planReviewSubagentsMode).toBeDefined();
    expect(["new", "fork", "new+fork"]).toContain(settings.planReviewSubagentsMode);
  });
});

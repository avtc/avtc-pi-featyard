// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent, Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { createFakePi, getSingleHandler, setupPiCtx, TUI_MODE } from "../helpers/workflow-monitor-test-helpers.js";

type WidgetRenderer = (tui: null, theme: Theme) => Text;

describe("workflow monitor widget", () => {
  test("shows workflow phase strip when a workflow phase is active", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    let renderer: WidgetRenderer | undefined;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: (_id: string, widget: WidgetRenderer | undefined) => {
          renderer = widget;
        },
        select: async () => "Skip design",
        setEditorText: () => {},
      },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0] & { notify?: () => void }, TUI_MODE);

    const onInput = getSingleHandler(fake.handlers, "input");
    await onInput({ source: "user" as const, text: "/skill:fy-plan" } as unknown as ExtensionEvent, ctx);

    expect(renderer).toBeTypeOf("function");

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;

    const textNode = (renderer as (tui: null, theme: Theme) => Text)(null, theme);
    // Merged widget: 🅵 + phase bar (◧ marks the active phase) + active-phase label.
    expect((textNode as unknown as { text: string }).text).toContain("◧");
    expect((textNode as unknown as { text: string }).text).toContain("plan");
  });
});

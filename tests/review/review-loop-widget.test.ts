// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import {
  createFakePi,
  fireAllHandlers,
  setupPiCtx,
  TUI_MODE,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

type WidgetRenderer = (tui: null, theme: Theme) => Text;

afterEach(() => {
  delete globalThis.__piCtx;
});

describe("review loop counter in workflow widget", () => {
  test("shows review loop count when reviewLoopCount > 0 and review phase active", async () => {
    const slug = "2026-05-11-review-widget";
    const fake = createFakePi();
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "review",
        designDoc: "docs/featyard/designs/2026-05-11-review-widget-design.md",
        planDoc: ".featyard/task-plans/2026-05-11-review-widget-task-plan.md",
      },
      review: { reviewLoopCount: 3, reviewHistory: [] },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    let renderer: WidgetRenderer | undefined;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: (_id: string, widget: WidgetRenderer | undefined) => {
          if (_id === "workflow_monitor") renderer = widget;
        },
        select: async () => "",
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    expect(renderer).toBeTypeOf("function");

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;

    const textNode = (renderer ?? (() => []))(null, theme);
    expect((textNode as unknown as { text: string }).text).toContain("review #3");
  });

  test("does not show loop count when reviewLoopCount is 0", async () => {
    const slug = "2026-05-11-review-no-loop";
    const fake = createFakePi();
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "review",
        designDoc: "docs/featyard/designs/2026-05-11-review-no-loop-design.md",
        planDoc: ".featyard/task-plans/2026-05-11-review-no-loop-task-plan.md",
      },
      review: { reviewLoopCount: 0, reviewHistory: [] },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    let renderer: WidgetRenderer | undefined;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: (_id: string, widget: WidgetRenderer | undefined) => {
          if (_id === "workflow_monitor") renderer = widget;
        },
        select: async () => "",
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    expect(renderer).toBeTypeOf("function");

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;

    const textNode = (renderer ?? (() => []))(null, theme);
    expect((textNode as unknown as { text: string }).text).toContain("review");
    expect((textNode as unknown as { text: string }).text).not.toContain("#0");
  });

  test("shows design loop count when designReviewLoopCount > 0 and design phase active", async () => {
    const slug = "2026-05-22-design-widget";
    const fake = createFakePi();
    writeFeatureStateFile(slug, {
      workflow: { currentPhase: "design", designDoc: null, planDoc: null },
      design: { doc: null, reviewActive: false, reviewLoopCount: 2 },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    let renderer: WidgetRenderer | undefined;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: (_id: string, widget: WidgetRenderer | undefined) => {
          if (_id === "workflow_monitor") renderer = widget;
        },
        select: async () => "",
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    expect(renderer).toBeTypeOf("function");

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;

    const textNode = (renderer ?? (() => []))(null, theme);
    expect((textNode as unknown as { text: string }).text).toContain("design #2");
  });

  test("shows plan loop count when planReviewLoopCount > 0 and plan phase active", async () => {
    const slug = "2026-05-22-plan-widget";
    const fake = createFakePi();
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "plan",
        designDoc: "docs/featyard/designs/2026-05-22-plan-widget-design.md",
        planDoc: null,
      },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 3 },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    let renderer: WidgetRenderer | undefined;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: (_id: string, widget: WidgetRenderer | undefined) => {
          if (_id === "workflow_monitor") renderer = widget;
        },
        select: async () => "",
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    expect(renderer).toBeTypeOf("function");

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;

    const textNode = (renderer ?? (() => []))(null, theme);
    expect((textNode as unknown as { text: string }).text).toContain("plan #3");
  });
});

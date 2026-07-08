// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Direct render-validation for the merged workflow widget (17.25).
 * Exercises updateWidget across all states and asserts the visible output
 * (passthrough theme so the rendered string is plain text).
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import type { FeatureSession } from "../../src/state/feature-session.js";
import type { FeatureState } from "../../src/state/feature-state.js";
import { updateWidget } from "../../src/ui/feature-flow-widget.js";
import { setupPiCtx, TUI_MODE } from "../helpers/workflow-monitor-test-helpers.js";

type WidgetRenderer = (tui: null, theme: Theme) => Text;

// Passthrough theme: returns text verbatim so assertions see plain content.
const theme: Theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

interface Opts {
  currentPhase?: string | null;
  slug?: string | null;
  featureId?: number | null;
  reviewLoopCount?: number;
  designReviewLoopCount?: number;
  planReviewLoopCount?: number;
  completedAt?: string | null;
  autoAgent?: { state: string; role: string } | null;
  task?: string | null;
  termWidth?: number;
}

function render(opts: Opts): string | undefined {
  // Auto-agent bridge.
  const g = globalThis as unknown as Record<string, unknown>;
  const prevKanban = g.__piKanban;
  if (opts.autoAgent) {
    const agent = opts.autoAgent;
    g.__piKanban = {
      autoAgent: {
        getState: () => agent.state,
        getRole: () => agent.role,
      },
      gracePeriod: { getRemainingSeconds: () => 12 },
    };
  } else {
    delete g.__piKanban;
  }

  const handler = {
    getWorkflowState: () => (opts.currentPhase ? { currentPhase: opts.currentPhase } : null),
    getActiveFeatureSlug: () => opts.slug ?? null,
    getActiveFeatureState: () =>
      opts.slug
        ? ({
            featureId: opts.featureId ?? null,
            completedAt: opts.completedAt ?? null,
            review: { reviewLoopCount: opts.reviewLoopCount ?? 0 },
            design: { reviewLoopCount: opts.designReviewLoopCount ?? 0 },
            plan: { reviewLoopCount: opts.planReviewLoopCount ?? 0 },
            implement: { taskReviewRounds: {}, currentTask: opts.task ?? null },
          } as FeatureState)
        : null,
  } as unknown as FeatureSession;

  let renderer: WidgetRenderer | undefined;
  const _ctx = {
    hasUI: true,
    ui: {
      setWidget: (_id: string, w: WidgetRenderer | undefined) => {
        if (_id === "workflow_monitor") renderer = w;
      },
    },
  } as unknown as ExtensionContext;

  // Set up the guard so updateWidget can read UI from it
  setupPiCtx(_ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);

  const prevCols = process.stdout.columns;
  // Width is read at RENDER time (inside the setWidget callback), so set it
  // around the renderer call, not around updateWidget.
  updateWidget(handler, null);
  if (opts.termWidth) process.stdout.columns = opts.termWidth;
  const out = renderer ? (renderer(null, theme) as unknown as { text: string }).text : undefined;
  if (opts.termWidth) {
    if (prevCols === undefined) (process.stdout as { columns?: number }).columns = undefined;
    else process.stdout.columns = prevCols;
  }
  if (prevKanban === undefined) delete g.__piKanban;
  else g.__piKanban = prevKanban;

  return out;
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).__piKanban;
});

describe("merged workflow widget render", () => {
  test("no workflow and no auto-agent hides the widget", () => {
    expect(render({})).toBeUndefined();
  });

  test("early design (no slug, no agent): bar + design label only", () => {
    const out = render({ currentPhase: "design" });
    expect(out).toContain("🅵");
    expect(out).toContain("◧"); // active cell
    expect(out).toContain("design");
    expect(out?.includes("task:")).toBe(false); // no task section in design
  });

  test("design with review loop + slug + agent", () => {
    const out = render({
      currentPhase: "design",
      designReviewLoopCount: 2,
      slug: "add-login",
      featureId: 12,
      autoAgent: { state: "working", role: "designer" },
    });
    expect(out).toContain("design #2");
    expect(out).toContain("🤖 auto-designer");
    expect(out).toContain("12. add-login");
  });

  test("implement renders phase bar + slug; no Task segment when no plan-task set", () => {
    const out = render({
      currentPhase: "implement",
      slug: "add-login",
      featureId: 42,
    });
    // No coarse plan-task recorded → no Task segment.
    expect(out).toContain("implement");
    expect(out).toContain("42. add-login");
    expect(out?.includes("▶")).toBe(false);
  });

  test("review renders loop count + slug; no Task segment (only implement shows it)", () => {
    const out = render({
      currentPhase: "review",
      reviewLoopCount: 3,
      slug: "refactor-x",
      featureId: 7,
      task: "3. Fix types",
    });
    expect(out).toContain("review #3");
    expect(out).toContain("7. refactor-x");
    expect(out?.includes("▶")).toBe(false);
  });

  test("implement with plan-task set renders ▶ task segment after feature identity", () => {
    const out = render({
      currentPhase: "implement",
      slug: "add-login",
      featureId: 42,
      task: "3. Wire the login form",
    });
    expect(out).toContain("implement");
    expect(out).toContain("42. add-login");
    expect(out).toContain("▶ 3. Wire the login form");
  });

  test("narrow width proportionally trims slug + Task both, keeping each visible", () => {
    const out = render({
      currentPhase: "implement",
      slug: "improve-start-with-multiple-features",
      featureId: 116,
      task: "3. Wire the login form",
      termWidth: 60,
    });
    expect(out).toContain("implement");
    expect(out).toContain("▶");
    expect(out).toContain("116.");
    // both names elided (middle ellipsis present) but neither dropped
    expect(out).toContain("\u2026");
  });

  test("verify phase shows no Task segment (implement-only)", () => {
    const out = render({
      currentPhase: "verify",
      slug: "add-login",
      featureId: 1,
      task: "3. Should not show in verify",
    });
    expect(out).toContain("verify");
    expect(out?.includes("▶")).toBe(false);
  });

  test("completed feature renders DONE state: all cells filled, 'done' label, identity kept", () => {
    const out = render({
      currentPhase: "finish",
      slug: "2026-06-28-fork-state-propagation",
      featureId: 116,
      completedAt: "2026-06-29T04:27:11.019Z",
    });
    // All 7 cells filled (no ◧ active cell).
    expect(out).toContain("■■■■■■■");
    expect(out?.includes("◧")).toBe(false);
    // 'done' label (not 'finish').
    expect(out).toContain("done");
    // Identity stays (the slot is kept, not cleared).
    expect(out).toContain("116. 2026-06-28-fork-state-propagation");
  });

  test("auto-agent alone (no workflow) still renders", () => {
    const out = render({ autoAgent: { state: "polling", role: "worker" } });
    expect(out).toContain("💤 auto-worker");
  });

  test("elastic middle-elision trims feature slug at narrow width", () => {
    const longSlug = "update-documentation-across-all-modules-end-to-end";
    const out = render({
      currentPhase: "implement",
      slug: longSlug,
      featureId: 99,
      termWidth: 40,
    });
    expect(out).toBeDefined();
    expect(out).toContain("…"); // elided
    // Full slug must NOT fit at width 40.
    expect(out?.includes(longSlug)).toBe(false);
  });

  test("wide terminal shows full slug + full Task without elision", () => {
    const out = render({
      currentPhase: "implement",
      slug: "improve-start-with-multiple-features",
      featureId: 42,
      task: "3. Update the documentation",
      termWidth: 200,
    });
    expect(out).toContain("improve-start-with-multiple-features");
    expect(out).toContain("▶ 3. Update the documentation");
    expect(out?.includes("…")).toBe(false);
  });

  test("long slug elided at medium width", () => {
    const out = render({
      currentPhase: "implement",
      slug: "improve-start-with-multiple-features",
      featureId: 42,
      termWidth: 60,
    });
    expect(out).toBeDefined();
    // Slug elided (kept head + tail with … between), not destroyed or kept whole.
    expect(out?.includes("im")).toBe(true);
    expect(out?.includes("improve-start-with-multiple-features")).toBe(false);
    expect(out?.match(/…/g)?.length ?? 0).toBe(1); // one ellipsis (slug only — no task name)
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type { FeatureState } from "../../src/state/feature-state.js";
import {
  formatFeatureInfo,
  ManageFeaturesComponent,
  type ManageFeaturesResult,
  type TUILike,
} from "../../src/ui/manage-features-dialog.js";

// Stubs
const mockTui: TUILike = { requestRender: () => {} };
const mockTheme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as Theme;

function makeFeature(overrides: Partial<FeatureState>): FeatureState {
  return {
    featureSlug: "2026-05-08-test-feature",
    git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    completedAt: null,
    workflow: {
      currentPhase: "plan",
      designDoc: null,
      planDoc: null,
    },
    design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
    plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
    implement: { taskReviewRounds: {}, currentTask: null },
    verify: { verifyLoopCount: 0 },
    sessionFiles: [],
    featureId: null,
    review: { reviewLoopCount: 0, reviewHistory: [] },
    ...overrides,
  };
}

describe("ManageFeaturesComponent rendering", () => {
  test("renders feature list with unchecked checkboxes", () => {
    const features = [
      makeFeature({ featureSlug: "2026-05-01-alpha" }),
      makeFeature({ featureSlug: "2026-05-02-beta" }),
      makeFeature({ featureSlug: "2026-05-03-gamma" }),
    ];
    const done = () => {};
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, done);
    const lines = component.render(60);

    const text = lines.join("\n");
    expect(text).toContain("2026-05-01-alpha");
    expect(text).toContain("2026-05-02-beta");
    expect(text).toContain("2026-05-03-gamma");
    expect(text).toContain("[ ]");
  });

  test("renders phase name (task counts are owned by the TODO widget)", () => {
    const features = [
      makeFeature({
        featureSlug: "2026-05-08-tasks",
        workflow: { currentPhase: "implement", designDoc: null, planDoc: null },
      }),
    ];
    const done = () => {};
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, done);
    const lines = component.render(60);
    const text = lines.join("\n");
    expect(text).toContain("implement");
    expect(text).not.toContain("task 3/4");
  });

  test("renders phase name when no taskTracker", () => {
    const features = [makeFeature({ featureSlug: "2026-05-08-no-tasks" })];
    const done = () => {};
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, done);
    const lines = component.render(60);
    const text = lines.join("\n");
    expect(text).toContain("plan");
  });

  test("renders Select All when not all checked", () => {
    const features = [makeFeature({})];
    const done = () => {};
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, done);
    const lines = component.render(60);
    const text = lines.join("\n");
    expect(text).toContain("Select All");
  });

  test("renders Deselect All when all checked", () => {
    const features = [makeFeature({})];
    const done = () => {};
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, done);
    // Select the first feature via Space
    component.handleInput(" ");
    const lines = component.render(60);
    const text = lines.join("\n");
    expect(text).toContain("Deselect All");
  });

  test("renders action buttons", () => {
    const features = [makeFeature({})];
    const done = () => {};
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, done);
    const lines = component.render(60);
    const text = lines.join("\n");
    expect(text).toContain("Mark completed");
    expect(text).toContain("Delete");
  });

  test("renders header and footer separators", () => {
    const features = [makeFeature({})];
    const done = () => {};
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, done);
    const lines = component.render(60);
    expect(lines[0]).toContain("─");
    // Find the last separator line (before help text)
    const lastSep = lines.filter((l) => l.includes("─")).at(-1);
    expect(lastSep).toBeDefined();
  });
});

describe("formatFeatureInfo", () => {
  test("shows the current phase name (task counts owned by TODO widget)", () => {
    const f = makeFeature({
      workflow: {
        ...makeFeature({}).workflow,
        currentPhase: "implement",
      },
    });
    expect(formatFeatureInfo(f)).toBe("implement");
  });

  test("shows phase name when all tasks complete", () => {
    const f = makeFeature({
      workflow: {
        ...makeFeature({}).workflow,
        currentPhase: "verify",
      },
    });
    expect(formatFeatureInfo(f)).toBe("verify");
  });

  test("shows phase name when no taskTracker", () => {
    const f = makeFeature({});
    expect(formatFeatureInfo(f)).toBe("plan");
  });
});

describe("ManageFeaturesComponent input handling", () => {
  const INPUT = {
    up: "\x1b[A",
    down: "\x1b[B",
    enter: "\r",
    escape: "\x1b",
    space: " ",
  };

  test("Space toggles checkbox on feature row", () => {
    const features = [makeFeature({ featureSlug: "alpha" }), makeFeature({ featureSlug: "beta" })];
    let result: ManageFeaturesResult | null | string = "not_called";
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, (r) => {
      result = r;
    });

    component.handleInput(INPUT.space);
    expect(component.render(60).join("\n")).toContain("[✓]");

    component.handleInput(INPUT.space);
    expect(component.render(60).join("\n")).toContain("[ ]");
    expect(result).toBe("not_called");
  });

  test("Enter toggles checkbox on feature row", () => {
    const features = [makeFeature({ featureSlug: "alpha" })];
    let result: ManageFeaturesResult | null | string = "not_called";
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, (r) => {
      result = r;
    });

    component.handleInput(INPUT.enter);
    expect(component.render(60).join("\n")).toContain("[✓]");
    expect(result).toBe("not_called");
  });

  test("Select All / Deselect All toggle", () => {
    const features = [makeFeature({ featureSlug: "alpha" }), makeFeature({ featureSlug: "beta" })];
    let result: ManageFeaturesResult | null | string = "not_called";
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, (r) => {
      result = r;
    });

    // Navigate to toggle (index 2 = features.length)
    component.handleInput(INPUT.down);
    component.handleInput(INPUT.down);

    component.handleInput(INPUT.enter);
    const text1 = component.render(60).join("\n");
    expect(text1).toContain("[✓]");
    expect(text1).toContain("Deselect All");

    component.handleInput(INPUT.enter);
    const text2 = component.render(60).join("\n");
    expect(text2).toContain("[ ]");
    expect(text2).toContain("Select All");
    expect(result).toBe("not_called");
  });

  test("Mark completed fires done with correct slugs", () => {
    const features = [makeFeature({ featureSlug: "alpha" }), makeFeature({ featureSlug: "beta" })];
    let result: ManageFeaturesResult | null | string = "not_called";
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, (r) => {
      result = r;
    });

    // Select first feature
    component.handleInput(INPUT.space);
    // Move to second feature and select it
    component.handleInput(INPUT.down);
    component.handleInput(INPUT.space);
    // Move to toggle, then to Mark completed
    component.handleInput(INPUT.down); // toggle
    component.handleInput(INPUT.down); // mark completed
    component.handleInput(INPUT.enter);

    expect(result).toEqual({
      action: "mark_completed",
      slugs: ["alpha", "beta"],
    });
  });

  test("Delete fires done with correct slugs", () => {
    const features = [makeFeature({ featureSlug: "gamma" })];
    let result: ManageFeaturesResult | null | string = "not_called";
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, (r) => {
      result = r;
    });

    // Select the feature
    component.handleInput(INPUT.space);
    // Navigate to Delete (features.length + 2 = 3)
    component.handleInput(INPUT.down); // toggle
    component.handleInput(INPUT.down); // mark completed
    component.handleInput(INPUT.down); // delete
    component.handleInput(INPUT.enter);

    expect(result).toEqual({
      action: "delete",
      slugs: ["gamma"],
    });
  });

  test("Esc fires done with null", () => {
    const features = [makeFeature({})];
    let result: ManageFeaturesResult | null | string = "not_called";
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, (r) => {
      result = r;
    });

    component.handleInput(INPUT.escape);
    expect(result).toBeNull();
  });

  test("Action with no selection is no-op", () => {
    const features = [makeFeature({})];
    let result: ManageFeaturesResult | null | string = "not_called";
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, (r) => {
      result = r;
    });

    // Navigate to Mark completed without selecting anything
    component.handleInput(INPUT.down); // toggle
    component.handleInput(INPUT.down); // mark completed
    component.handleInput(INPUT.enter);

    expect(result).toBe("not_called");
  });

  test("Cursor wraps around", () => {
    const features = [makeFeature({})];
    let _result: ManageFeaturesResult | null | string = "not_called";
    const component = new ManageFeaturesComponent(features, mockTui, mockTheme, (r) => {
      _result = r;
    });

    // 4 positions: feature(0), toggle(1), mark_completed(2), delete(3)
    // Press up from 0 → wraps to 3 (delete)
    component.handleInput(INPUT.up);
    const lines = component.render(60);
    const deleteLine = lines.find((l) => l.includes("[Delete]"));
    expect(deleteLine).toContain(">");
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { createFakePi, fireAllHandlers } from "../helpers/workflow-monitor-test-helpers.js";

// --- Helpers ---

/** Build a fake session branch (array of entries) for getBranch() */
function makeBranch(entries: Array<{ customType?: string; data?: unknown; type?: string } & Record<string, unknown>>) {
  return entries.map((e, i) => ({
    id: `entry-${i}`,
    type: e.type ?? "custom",
    customType: e.customType,
    data: e.data,
    ...e,
  }));
}

/** Create a feature_flow_state entry with full handler state.
 *  New wrapper shape: { featureState, guardrailsState }. Phase status is derived
 *  from currentPhase + completedAt (no phases map). */
function stateEntry(
  overrides: { activeFeatureSlug?: string | null; currentPhase?: string; phases?: Record<string, string> } = {},
) {
  const slug = overrides.activeFeatureSlug ?? null;
  const currentPhase = overrides.currentPhase ?? "design";
  // phases is retained in the signature for back-compat but no longer stored
  // (status is derived from currentPhase + completedAt).
  void overrides.phases;
  return {
    customType: "feature_flow_state",
    data: {
      featureState: slug
        ? {
            featureSlug: slug,
            git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
            createdAt: "2026-05-10T00:00:00.000Z",
            updatedAt: "2026-05-10T00:00:00.000Z",
            completedAt: null,
            workflow: { currentPhase, designDoc: null, planDoc: null },
            sessionFiles: [],
            featureId: null,
            design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
            plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
            implement: { tasks: [] },
            verify: { verifyLoopCount: 0 },
            review: { reviewLoopCount: 0, reviewHistory: [] },
          }
        : null,
      guardrailsState: {
        tdd: { stage: "idle", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: "not-run",
      },
    },
  };
}

/** Create a non-state custom entry (noise) */
function noiseEntry(customType: string) {
  return { customType, data: { foo: "bar" } };
}

function makeMockCtx(branch: ReturnType<typeof makeBranch>, opts: { hasUI?: boolean; selectMock?: unknown } = {}) {
  return {
    hasUI: opts.hasUI ?? true,
    sessionManager: { getBranch: () => branch },
    ui: {
      setWidget: () => {},
      select: opts.selectMock ?? (async () => "checkpoint"),
      info: () => {},
      setEditorText: () => {},
    },
  };
}

// --- Tests ---

describe("session entry restore — resume", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  test("resume restores state from session entries", async () => {
    const branch = makeBranch([
      stateEntry({
        activeFeatureSlug: "2026-05-10-resumed-feature",
        currentPhase: "implement",
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
      }),
    ]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "resume" }, makeMockCtx(branch));

    expect(getActiveFeatureSlug()).toBe("2026-05-10-resumed-feature");
    expect(process.env.PI_FF_FEATURE).toBe("2026-05-10-resumed-feature");
  });

  test("resume with no session entries clears state and does not show prompts", async () => {
    const branch = makeBranch([]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Pre-set env var to simulate stale state from previous session
    process.env.PI_FF_FEATURE = "stale-feature";

    let selectCalled = false;
    const mockCtx = makeMockCtx(branch, {
      selectMock: async () => {
        selectCalled = true;
        return "";
      },
    });

    await fireAllHandlers(fake.handlers, "session_start", { reason: "resume" }, mockCtx);

    // No prompt shown, state cleared
    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBeNull();
    expect(process.env.PI_FF_FEATURE).toBeUndefined();
  });
});

describe("session entry restore — fork", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  test("fork restores state from session entries at fork point", async () => {
    const branch = makeBranch([
      stateEntry({
        activeFeatureSlug: "2026-05-10-forked-feature",
        currentPhase: "plan",
        phases: {
          design: "done",
          plan: "in-progress",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
      }),
    ]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "fork" }, makeMockCtx(branch));

    expect(getActiveFeatureSlug()).toBe("2026-05-10-forked-feature");
    expect(process.env.PI_FF_FEATURE).toBe("2026-05-10-forked-feature");
  });

  test("fork with no session entries clears state", async () => {
    const branch = makeBranch([]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    process.env.PI_FF_FEATURE = "stale-feature";

    let selectCalled = false;
    const mockCtx = makeMockCtx(branch, {
      selectMock: async () => {
        selectCalled = true;
        return "";
      },
    });

    await fireAllHandlers(fake.handlers, "session_start", { reason: "fork" }, mockCtx);

    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBeNull();
    expect(process.env.PI_FF_FEATURE).toBeUndefined();
  });
});

describe("session entry restore — tree", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  test("session_tree restores state from branch entries at new leaf", async () => {
    const branch = makeBranch([
      stateEntry({
        activeFeatureSlug: "2026-05-10-tree-feature",
        currentPhase: "implement",
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
      }),
    ]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_tree",
      { newLeafId: "entry-0", oldLeafId: "entry-old" },
      makeMockCtx(branch),
    );

    expect(getActiveFeatureSlug()).toBe("2026-05-10-tree-feature");
    expect(process.env.PI_FF_FEATURE).toBe("2026-05-10-tree-feature");
  });

  test("session_tree with no entries clears state", async () => {
    const branch = makeBranch([]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    process.env.PI_FF_FEATURE = "stale-feature";

    let selectCalled = false;
    const mockCtx = makeMockCtx(branch, {
      selectMock: async () => {
        selectCalled = true;
        return "";
      },
    });

    await fireAllHandlers(fake.handlers, "session_tree", { newLeafId: null, oldLeafId: "entry-old" }, mockCtx);

    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBeNull();
    expect(process.env.PI_FF_FEATURE).toBeUndefined();
  });
});

describe("session entry restore — reload", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  test("reload restores active workflow state from session entries", async () => {
    const branch = makeBranch([
      stateEntry({
        activeFeatureSlug: "2026-05-10-my-feature",
        currentPhase: "implement",
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
      }),
    ]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, makeMockCtx(branch));

    expect(getActiveFeatureSlug()).toBe("2026-05-10-my-feature");
    expect(process.env.PI_FF_FEATURE).toBe("2026-05-10-my-feature");
  });

  test("reload restores design-phase state with null slug (original bug scenario)", async () => {
    const branch = makeBranch([
      stateEntry({
        activeFeatureSlug: null,
        currentPhase: "design",
      }),
    ]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, makeMockCtx(branch));

    expect(getActiveFeatureSlug()).toBeNull();
    // Env var should NOT be set when slug is null
    expect(process.env.PI_FF_FEATURE).toBeUndefined();
  });

  test("reload with no session entries falls through to env-var path", async () => {
    const branch = makeBranch([]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Set env var + write feature state file to simulate the fallback path
    fs.mkdirSync(path.join(".ff", "feature-state"), { recursive: true });
    const slug = "fallback-feature";
    fs.writeFileSync(
      path.join(".ff", "feature-state", `${slug}.json`),
      JSON.stringify({
        featureSlug: slug,
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        completedAt: null,
        workflow: { currentPhase: "implement", designDoc: null, planDoc: null },
        design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
        plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
      }),
    );
    process.env.PI_FF_FEATURE = slug;

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, makeMockCtx(branch));

    // Falls through to env-var path — loads from file
    expect(getActiveFeatureSlug()).toBe(slug);
    expect(process.env.PI_FF_FEATURE).toBe(slug);
  });

  test("reload restores from last state entry when multiple exist", async () => {
    const branch = makeBranch([
      stateEntry({
        activeFeatureSlug: "old-feature",
        currentPhase: "design",
      }),
      noiseEntry("other_type"),
      stateEntry({
        activeFeatureSlug: "new-feature",
        currentPhase: "implement",
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
      }),
    ]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, makeMockCtx(branch));

    // Should use the LAST state entry (new-feature), not the first
    expect(getActiveFeatureSlug()).toBe("new-feature");
    expect(process.env.PI_FF_FEATURE).toBe("new-feature");
  });

  test("reload does not scan disk or show prompts even when disk features exist", async () => {
    const branch = makeBranch([
      stateEntry({
        activeFeatureSlug: null,
        currentPhase: "design",
      }),
    ]);

    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Create a stale feature state file on disk — reload should ignore it
    fs.mkdirSync(path.join(".ff", "feature-state"), { recursive: true });
    fs.writeFileSync(
      path.join(".ff", "feature-state", "old-feature.json"),
      JSON.stringify({ completedAt: null, featureSlug: "old-feature" }),
    );

    let selectCalled = false;
    const mockCtx = makeMockCtx(branch, {
      selectMock: async () => {
        selectCalled = true;
        return "old-feature";
      },
    });

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, mockCtx);

    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBeNull();
  });
});

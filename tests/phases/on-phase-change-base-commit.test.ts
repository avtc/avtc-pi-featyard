// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultGitRunner, setGitRunner } from "../../src/git/git-queries.js";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { captureBaseCommitSha } from "../../src/state/feature-management.js";
import { createFeatureSession } from "../../src/state/feature-session.js";
import { createFeatureState, DEFAULT_DIR, loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  fireAllHandlers,
  getSingleHandler,
  withTempCwd,
} from "../helpers/workflow-monitor-test-helpers.js";

/** Runner that answers git-queries' (args, cwd) calls with canned values. */
function fakeRunner(revParseHead: string, abbrevRef: string) {
  return vi.fn((args: string[]) => {
    const cmd = args.join(" ");
    if (cmd === "rev-parse HEAD") return `${revParseHead}\n`;
    if (cmd === "symbolic-ref --short HEAD") return `${abbrevRef}\n`;
    if (cmd === "rev-parse --short HEAD") return `${revParseHead.slice(0, 7)}\n`;
    throw new Error(`unexpected git call: ${cmd}`);
  }) as unknown as import("../../src/git/git-queries.js").GitRunner;
}

describe("onPhaseChange captures baseCommitSha on execute phase entry", () => {
  beforeEach(() => {
    setTestSettings(null);
    withTempCwd();
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    setGitRunner(fakeRunner("deadbeef1234567890abcdef1234567890abcdef", "main"));
  });

  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    setGitRunner(defaultGitRunner);
  });

  test("captures baseCommitSha when entering execute phase via /skill:fy-implement", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    // Session start
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // Trigger execute phase via input gating
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput(
      {
        text: "/skill:fy-implement .featyard/task-plans/2026-05-10-my-feature-task-plan.md",
      } as unknown as ExtensionEvent,
      {} as unknown as ExtensionContext,
    );

    // Verify baseCommitSha was captured
    const state = loadFeatureState("2026-05-10-my-feature", null);
    expect(state).toBeDefined();
    expect(state?.git.baseCommitSha).toBe("deadbeef1234567890abcdef1234567890abcdef");
    expect(state?.git.branch).toBe("main");
  });

  test("does not overwrite baseCommitSha on re-entry", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onInput = getSingleHandler(fake.handlers, "input");
    onInput(
      {
        text: "/skill:fy-implement .featyard/task-plans/2026-05-10-my-feature-task-plan.md",
      } as unknown as ExtensionEvent,
      {} as unknown as ExtensionContext,
    );

    // First capture
    const state1 = loadFeatureState("2026-05-10-my-feature", null);
    expect(state1?.git.baseCommitSha).toBe("deadbeef1234567890abcdef1234567890abcdef");

    // Change mock to return different SHA
    setGitRunner(fakeRunner("aaaa111122223333444455556666777788889999", "main"));

    // Trigger execute phase again (e.g., session reload)
    onInput(
      {
        text: "/skill:fy-implement .featyard/task-plans/2026-05-10-my-feature-task-plan.md",
      } as unknown as ExtensionEvent,
      {} as unknown as ExtensionContext,
    );

    // baseCommitSha should NOT have changed
    const state2 = loadFeatureState("2026-05-10-my-feature", null);
    expect(state2?.git.baseCommitSha).toBe("deadbeef1234567890abcdef1234567890abcdef");
  });
});

describe("onPhaseChange callback directly triggers baseCommitSha capture", () => {
  /** Shared onPhaseChange callback factory mirroring production logic */
  function createHandlerWithCallback() {
    const handler = createFeatureSession({
      onPhaseChange: () => {
        const activeSlug = handler.getActiveFeatureSlug();
        if (handler.getWorkflowState()?.currentPhase === "implement" && activeSlug) {
          const featureState = loadFeatureState(activeSlug, DEFAULT_DIR);
          if (featureState && !featureState.git.baseCommitSha) {
            captureBaseCommitSha(featureState);
          }
        }
      },
    });
    return handler;
  }

  beforeEach(() => {
    withTempCwd();
    setGitRunner(fakeRunner("facefeed1234567890abcdef1234567890abcdef", "feature/test"));
    setSetting("branchPolicy", "current-branch");
  });

  afterEach(() => {
    setGitRunner(defaultGitRunner);
  });

  test("captures baseCommitSha when setCurrentPhaseDirect('execute') fires onPhaseChange", () => {
    const slug = "2026-06-06-direct-test";

    const state = createFeatureState(slug, `docs/featyard/designs/${slug}-design.md`);
    saveFeatureState(state, null);

    const handler = createHandlerWithCallback();

    handler.setActiveFeatureState(loadFeatureState(slug, DEFAULT_DIR));
    handler.setCurrentPhase("implement");

    const result = loadFeatureState(slug, DEFAULT_DIR);
    expect(result).toBeDefined();
    expect(result?.git.baseCommitSha).toBe("facefeed1234567890abcdef1234567890abcdef");
    expect(result?.git.branch).toBe("feature/test");
  });

  test("does not capture baseCommitSha when phase changes to non-execute phase", () => {
    const slug = "2026-06-06-non-execute-test";

    const state = createFeatureState(slug, `docs/featyard/designs/${slug}-design.md`);
    saveFeatureState(state, null);

    const handler = createHandlerWithCallback();

    handler.setActiveFeatureState(loadFeatureState(slug, DEFAULT_DIR));
    handler.setCurrentPhase("plan");

    const result = loadFeatureState(slug, DEFAULT_DIR);
    expect(result).toBeDefined();
    expect(result?.git.baseCommitSha).toBeNull();
  });
});

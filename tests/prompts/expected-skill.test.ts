// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _getExpectedSkill, _resetFeatureState } from "../../src/index.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  withTempCwd,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("getExpectedSkill", () => {
  beforeEach(() => {
    setTestSettings(null);
    withTempCwd();
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    enableSubagentMode();
  });

  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
  });

  test("returns null when no workflow state (handler not initialized)", async () => {
    // Don't initialize extension — no handler exists
    // _getExpectedSkill should handle this gracefully
    // Since _getExpectedSkill is in the closure, we need the extension initialized
    // But with no phase set, it should return null
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

    // No phases advanced — currentPhase is null
    expect(_getExpectedSkill()).toBeNull();
  });

  test("returns null when currentPhase is null", async () => {
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

    expect(_getExpectedSkill()).toBeNull();
  });

  test("returns fy-implement when execute phase is active", async () => {
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

    // Advance to plan (sets plan=active)
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:fy-plan" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);

    // Skip plan phase — sets plan=skipped, currentPhase stays 'plan'
    // Use processSkillInput which routes to skipWorkflowPhases
    // Actually, the simplest way: write implementation plan to record artifact,
    // then skip plan phase. But that's complex.
    // Instead, advance to execute which leaves plan as pending (not active)
    // and sets execute as active.
    onInput({ text: "/skill:fy-implement" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);

    // Now execute is active, plan is pending (not active)
    // getExpectedSkill should return fy-implement (for execute active)
    expect(_getExpectedSkill()).toBe("fy-implement");
  });

  test("returns designing for design active", async () => {
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

    // Advance to design via skill read
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:fy-design" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);

    expect(_getExpectedSkill()).toBe("fy-design");
  });

  test("returns fy-plan for plan active", async () => {
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

    // Advance to plan via skill read
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:fy-plan" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);

    expect(_getExpectedSkill()).toBe("fy-plan");
  });

  test("returns fy-implement for execute active with checkpoint mode", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    const slug = "test-checkpoint";
    writeFeatureStateFile(slug, {
      executionMode: "checkpoint",
      workflow: {
        currentPhase: "implement",
        designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
        planDoc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
      },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(_getExpectedSkill()).toBe("fy-implement");
  });

  test("returns fy-implement for execute active with subagent mode", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    const slug = "test-subagent";
    writeFeatureStateFile(slug, {
      executionMode: "subagent",
      workflow: {
        currentPhase: "implement",
        designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
        planDoc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
      },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(_getExpectedSkill()).toBe("fy-implement");
  });

  test("returns fy-implement for execute active with subagent-fork mode", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    const slug = "test-subagent-fork";
    writeFeatureStateFile(slug, {
      executionMode: "subagent-fork",
      workflow: {
        currentPhase: "implement",
        designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
        planDoc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
      },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(_getExpectedSkill()).toBe("fy-implement");
  });

  test("returns fy-implement for execute active with no feature state", async () => {
    // No PI_FY_FEATURE set, no feature state file
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

    // Advance to execute via skill reads
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:fy-implement" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);

    // This sets execute=active but no feature state
    expect(_getExpectedSkill()).toBe("fy-implement");
  });

  test("returns fy-verify for verify active", async () => {
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

    // verify/review/finish skills no longer activate a fresh workflow, so advance
    // through earlier phases first, then invoke the verify skill.
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:fy-implement" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);
    onInput({ text: "/skill:fy-verify" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);

    expect(_getExpectedSkill()).toBe("fy-verify");
  });

  test("returns fy-review for review active", async () => {
    setSetting("maxFeatureReviewRounds", 3);
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // verify/review/finish skills no longer activate a fresh workflow, so advance
    // through earlier phases first, then invoke the review skill.
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:fy-implement" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);
    onInput({ text: "/skill:fy-review" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);

    expect(_getExpectedSkill()).toBe("fy-review");
  });

  test("returns fy-finish for finish active", async () => {
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

    // verify/review/finish skills no longer activate a fresh workflow, so advance
    // through earlier phases first, then invoke the finish skill.
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:fy-implement" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);
    onInput({ text: "/skill:fy-finish" } as unknown as ExtensionEvent, {} as unknown as ExtensionContext);

    expect(_getExpectedSkill()).toBe("fy-finish");
  });

  test("returns fy-design-review when design active and design.reviewLoopCount > 0", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    const slug = "test-design-review-compact";
    writeFeatureStateFile(slug, {
      workflow: { currentPhase: "design", designDoc: null, planDoc: null },
      design: { doc: null, reviewActive: true, reviewLoopCount: 1 },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(_getExpectedSkill()).toBe("fy-design-review");
  });

  test("returns designing when design active and design.reviewLoopCount === 0", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    const slug = "test-design-no-review";
    writeFeatureStateFile(slug, {
      workflow: { currentPhase: "design", designDoc: null, planDoc: null },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(_getExpectedSkill()).toBe("fy-design");
  });

  test("returns fy-plan-review when plan active and plan.reviewLoopCount > 0", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    const slug = "test-plan-review-compact";
    writeFeatureStateFile(slug, {
      workflow: { currentPhase: "plan", designDoc: "docs/featyard/designs/2026-05-10-test-design.md", planDoc: null },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: true, reviewLoopCount: 2 },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(_getExpectedSkill()).toBe("fy-plan-review");
  });

  test("returns fy-plan when plan active and plan.reviewLoopCount === 0", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    const slug = "test-plan-no-review";
    writeFeatureStateFile(slug, {
      workflow: { currentPhase: "plan", designDoc: "docs/featyard/designs/2026-05-10-test-design.md", planDoc: null },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    expect(_getExpectedSkill()).toBe("fy-plan");
  });

  test("returns designing when slug set but feature state file missing", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    const slug = "test-missing-state-file";
    // Write a state file with design active and design.reviewLoopCount > 0 so that if the
    // state existed, we'd get design-review. Then clear the in-memory record to
    // simulate a missing state (SOTS: the handler holds the record in memory).
    writeFeatureStateFile(slug, {
      workflow: { currentPhase: "design", designDoc: null, planDoc: null },
      design: { doc: null, reviewActive: true, reviewLoopCount: 1 },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // SOTS: clear the in-memory active record (deleting the file no longer makes
    // the handler's record missing).
    globalThis.__piWorkflowMonitor?.handler?.setActiveFeatureState(null);

    // Should fall through to PHASE_TO_SKILL map, returning base skill
    expect(_getExpectedSkill()).toBe("fy-design");
  });
});

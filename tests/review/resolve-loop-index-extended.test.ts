// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { getLoopCountForPhase } from "../../src/phases/phase-transitions.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import {
  createFakePi,
  fireAllHandlers,
  withTempCwd,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Loop-index resolution is phase-aware and reads feature-state directly
 * (the durable source of truth). The removed PI_FF_REVIEW_LOOP env var was a
 * pure mirror of getLoopCountForPhase; these tests now exercise that function
 * directly across every phase, which is what subagent-integration + the model
 * resolver read.
 */
describe("getLoopCountForPhase is phase-aware (the durable loop-count source)", () => {
  beforeEach(() => {
    withTempCwd();
    _resetFeatureState();
    delete process.env.PI_FF_FEATURE;
    delete process.env.PI_FF_EXECUTION_MODE;
    delete process.env.PI_FF_STAGE;
  });

  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FF_FEATURE;
    delete process.env.PI_FF_EXECUTION_MODE;
    delete process.env.PI_FF_STAGE;
  });

  function buildCtx() {
    return {
      hasUI: false,
      sessionManager: { getBranch: () => [], getSessionFile: () => "test.json" },
      ui: { setWidget: () => {} },
    };
  }

  test("returns designReviewLoopCount when phase is design", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const slug = "test-feature";
    writeFeatureStateFile(slug, {
      design: { doc: null, reviewActive: false, reviewLoopCount: 3 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 5 },
      review: { reviewLoopCount: 7, reviewHistory: [] },
      workflow: { currentPhase: "design", designDoc: null, planDoc: null },
    });

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", hasUI: false }, buildCtx());

    expect(getLoopCountForPhase(loadFeatureState(slug, null), "design")).toBe(3);
  });

  test("returns planReviewLoopCount when phase is plan", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const slug = "test-feature";
    writeFeatureStateFile(slug, {
      design: { doc: null, reviewActive: false, reviewLoopCount: 3 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 5 },
      review: { reviewLoopCount: 7, reviewHistory: [] },
      workflow: { currentPhase: "plan", designDoc: null, planDoc: null },
    });

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", hasUI: false }, buildCtx());

    expect(getLoopCountForPhase(loadFeatureState(slug, null), "plan")).toBe(5);
  });

  test("returns reviewLoopCount when phase is review", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const slug = "test-feature";
    writeFeatureStateFile(slug, {
      design: { doc: null, reviewActive: false, reviewLoopCount: 3 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 5 },
      review: { reviewLoopCount: 7, reviewHistory: [] },
      workflow: { currentPhase: "review", designDoc: null, planDoc: null },
    });

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", hasUI: false }, buildCtx());

    expect(getLoopCountForPhase(loadFeatureState(slug, null), "review")).toBe(7);
  });

  test("defaults to 0 when phase is design but no loop counts set", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const slug = "test-feature";
    writeFeatureStateFile(slug, {});

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", hasUI: false }, buildCtx());

    expect(getLoopCountForPhase(loadFeatureState(slug, null), "design")).toBe(0);
  });

  test("returns 0 for null feature state", () => {
    expect(getLoopCountForPhase(null, "review")).toBe(0);
  });

  test("uses reviewLoopCount for implement/verify phases (not design/plan counts)", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    for (const currentPhase of ["implement", "verify"]) {
      const slug = "test-feature";
      writeFeatureStateFile(slug, {
        design: { doc: null, reviewActive: false, reviewLoopCount: 3 },
        plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 5 },
        review: { reviewLoopCount: 7, reviewHistory: [] },
        workflow: { currentPhase, designDoc: null, planDoc: null },
      });

      await fireAllHandlers(fake.handlers, "session_start", { source: "user", hasUI: false }, buildCtx());

      // Implement/verify phases use reviewLoopCount (not design/plan counts)
      expect(getLoopCountForPhase(loadFeatureState(slug, null), currentPhase)).toBe(7);

      _resetFeatureState();
      delete process.env.PI_FF_FEATURE;
    }
  });

  test("falls through to reviewLoopCount for unknown/non-design/plan phases", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const slug = "test-feature";
    writeFeatureStateFile(slug, {
      design: { doc: null, reviewActive: false, reviewLoopCount: 3 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 5 },
      review: { reviewLoopCount: 7, reviewHistory: [] },
      workflow: { currentPhase: "finish", designDoc: null, planDoc: null },
    });

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", hasUI: false }, buildCtx());

    // Unknown phase 'finish' falls through to reviewLoopCount (7)
    expect(getLoopCountForPhase(loadFeatureState(slug, null), "finish")).toBe(7);
  });
});

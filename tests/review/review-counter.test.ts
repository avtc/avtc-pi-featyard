// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startReviewIteration } from "../../src/review/review-counter.js";
import { NO_FEATURE_STATE_OVERRIDE } from "../../src/shared/workflow-refs.js";
import type { FeatureSession } from "../../src/state/feature-session.js";
import { clearFeatureStateCache, loadFeatureState } from "../../src/state/feature-state.js";
import { withTempCwd, writeFeatureStateFile } from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Unit tests for startReviewIteration — the shared helper that increments the
 * design/plan review loop counter, sets the reviewActive flag, and persists state.
 */
describe("startReviewIteration", () => {
  beforeEach(() => {
    withTempCwd();
  });

  afterEach(() => {
    clearFeatureStateCache();
    delete process.env.PI_FF_FEATURE;
    vi.restoreAllMocks();
  });

  /** Minimal handler stub — provides the methods the helper now calls.
   *  getActiveFeatureState reads the active feature from disk (the SOTS record
   *  the production handler would hold in memory). */
  function makeHandler(reviewActiveCalls: Array<{ phase: string; value: boolean }>): FeatureSession {
    return {
      setReviewActiveFlag: (phase: string, value: boolean) => reviewActiveCalls.push({ phase, value }),
      getActiveFeatureState: () => {
        const slug = process.env.PI_FF_FEATURE;
        return slug ? loadFeatureState(slug, null) : null;
      },
    } as unknown as FeatureSession;
  }

  describe("design phase", () => {
    it("increments counter 0→1 on first iteration and returns the saved state", () => {
      const slug = writeFeatureStateFile("test-start-design-0", {
        design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
      });
      const calls: Array<{ phase: string; value: boolean }> = [];
      const handler = makeHandler(calls);

      const savedState = startReviewIteration(handler, slug, "design", NO_FEATURE_STATE_OVERRIDE);

      expect(savedState?.design.reviewLoopCount).toBe(1);
      expect(calls).toEqual([{ phase: "design", value: true }]);
      // Returned object reflects the incremented counter
      const state = loadFeatureState(slug, null);
      expect(state?.design.reviewLoopCount).toBe(1);
    });

    it("increments counter N→N+1 on subsequent iterations", () => {
      const slug = writeFeatureStateFile("test-start-design-n", {
        design: { doc: null, reviewActive: false, reviewLoopCount: 2 },
      });
      const handler = makeHandler([]);

      const savedState = startReviewIteration(handler, slug, "design", NO_FEATURE_STATE_OVERRIDE);

      expect(savedState?.design.reviewLoopCount).toBe(3);
      const state = loadFeatureState(slug, null);
      expect(state?.design.reviewLoopCount).toBe(3);
    });
  });

  describe("plan phase", () => {
    it("increments plan.reviewLoopCount and sets plan reviewActive flag", () => {
      const slug = writeFeatureStateFile("test-start-plan", {
        plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
      });
      const calls: Array<{ phase: string; value: boolean }> = [];
      const handler = makeHandler(calls);

      const savedState = startReviewIteration(handler, slug, "plan", NO_FEATURE_STATE_OVERRIDE);

      expect(savedState?.plan.reviewLoopCount).toBe(2);
      expect(calls).toEqual([{ phase: "plan", value: true }]);
    });

    it("does not touch design.reviewLoopCount", () => {
      const slug = writeFeatureStateFile("test-start-plan-isolated", {
        design: { doc: null, reviewActive: false, reviewLoopCount: 5 },
        plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
      });
      const handler = makeHandler([]);

      startReviewIteration(handler, slug, "plan", NO_FEATURE_STATE_OVERRIDE);

      const state = loadFeatureState(slug, null);
      expect(state?.plan.reviewLoopCount).toBe(1);
      expect(state?.design.reviewLoopCount).toBe(5); // unchanged
    });
  });

  describe("persistence", () => {
    it("saves feature state to disk (survives cache clear)", () => {
      const slug = writeFeatureStateFile("test-start-persist", {
        design: { doc: null, reviewActive: false, reviewLoopCount: 3 },
      });
      const handler = makeHandler([]);

      startReviewIteration(handler, slug, "design", NO_FEATURE_STATE_OVERRIDE);
      clearFeatureStateCache(); // force a fresh disk read

      const state = loadFeatureState(slug, null);
      expect(state?.design.reviewLoopCount).toBe(4);
    });

    it("preserves other state fields (e.g. review.reviewHistory)", () => {
      const slug = writeFeatureStateFile("test-start-history", {
        design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
        review: {
          reviewLoopCount: 0,
          reviewHistory: [
            {
              phase: "review",
              loopNumber: 0,
              issuesFound: 2,
              falsePositives: 0,
              cannotFixIssues: 0,
              timestamp: "2026-06-23T00:00:00.000Z",
            },
          ],
        },
      });
      const handler = makeHandler([]);

      startReviewIteration(handler, slug, "design", NO_FEATURE_STATE_OVERRIDE);

      const state = loadFeatureState(slug, null);
      expect(state?.design.reviewLoopCount).toBe(1);
      expect(state?.review.reviewHistory).toHaveLength(1);
      expect(state?.review.reviewHistory?.[0].issuesFound).toBe(2);
    });
  });

  describe("pre-loaded state", () => {
    it("mutates the provided featureState object (preserving unsaved mutations)", () => {
      const slug = writeFeatureStateFile("test-start-preloaded", {
        design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
      });
      // Simulate the phase-ready path: a state object with unsaved reviewHistory.
      const state = loadFeatureState(slug, null);
      if (!state) throw new Error("test setup: feature state must exist");
      state.review.reviewHistory = [
        {
          phase: "review",
          loopNumber: 0,
          issuesFound: 5,
          falsePositives: 0,
          cannotFixIssues: 0,
          timestamp: "2026-06-23T00:00:00.000Z",
        },
      ];
      const handler = makeHandler([]);

      const savedState = startReviewIteration(handler, slug, "design", state);

      expect(savedState?.design.reviewLoopCount).toBe(2);
      // The unsaved reviewHistory mutation must be persisted alongside the increment.
      const reloaded = loadFeatureState(slug, null);
      expect(reloaded?.design.reviewLoopCount).toBe(2);
      expect(reloaded?.review.reviewHistory).toHaveLength(1);
      expect(reloaded?.review.reviewHistory?.[0].issuesFound).toBe(5);
    });
  });

  describe("missing state", () => {
    it("returns null and does not throw when no feature state exists", () => {
      const calls: Array<{ phase: string; value: boolean }> = [];
      const handler = makeHandler(calls);
      const savedState = startReviewIteration(
        handler,
        "nonexistent-slug-start-iter",
        "design",
        NO_FEATURE_STATE_OVERRIDE,
      );
      expect(savedState).toBeNull();
      // : setReviewActiveFlag must NOT be called when state is missing
      expect(calls).toEqual([]);
    });
  });
});

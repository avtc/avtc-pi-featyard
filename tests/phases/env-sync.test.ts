// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, it } from "vitest";
import type { FeatureSession } from "../../src/state/feature-session.js";

/**
 * Tests for env-sync functions: setActiveFeatureEnv, clearActiveFeatureEnv,
 * clearFeatureEnvVars, syncEnvVarsFromState.
 *
 * Only PI_FY_FEATURE (child locates its state file on start) and PI_FY_STAGE
 * (root fork-mode derivation) are env-mirrored. PI_FY_REVIEW_LOOP and the
 * per-task pointer (implement.currentTask) are NOT env-mirrored: they live in
 * feature-state and are read directly by host-side consumers. Accordingly these
 * tests assert stage/feature env behavior only.
 */

import {
  clearActiveFeatureEnv,
  clearFeatureEnvVars,
  setActiveFeatureEnv,
  syncEnvVarsFromState,
} from "../../src/phases/env-sync.js";

function makeHandler(opts: { phase?: string | null; slug?: string | null }): FeatureSession {
  return {
    getWorkflowState: () =>
      opts.phase !== undefined && opts.phase !== null
        ? { currentPhase: opts.phase }
        : opts.phase === null
          ? null
          : { currentPhase: undefined },
    getActiveFeatureSlug: () => opts.slug ?? null,
    getActiveFeatureState: () => null,
  } as unknown as FeatureSession;
}

describe("env-sync", () => {
  afterEach(() => {
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_STAGE;
  });

  describe("setActiveFeatureEnv", () => {
    it("sets PI_FY_FEATURE env var", () => {
      setActiveFeatureEnv("my-feature");
      expect(process.env.PI_FY_FEATURE).toBe("my-feature");
    });

    it("overwrites previous value", () => {
      setActiveFeatureEnv("first");
      setActiveFeatureEnv("second");
      expect(process.env.PI_FY_FEATURE).toBe("second");
    });
  });

  describe("clearActiveFeatureEnv", () => {
    it("deletes PI_FY_FEATURE env var", () => {
      process.env.PI_FY_FEATURE = "existing";
      clearActiveFeatureEnv();
      expect(process.env.PI_FY_FEATURE).toBeUndefined();
    });
  });

  describe("clearFeatureEnvVars", () => {
    it("deletes stage", () => {
      process.env.PI_FY_STAGE = "design";
      clearFeatureEnvVars();
      expect(process.env.PI_FY_STAGE).toBeUndefined();
    });

    it("does not touch PI_FY_FEATURE (owned by clearActiveFeatureEnv)", () => {
      process.env.PI_FY_FEATURE = "keep-me";
      clearFeatureEnvVars();
      expect(process.env.PI_FY_FEATURE).toBe("keep-me");
    });
  });

  describe("syncEnvVarsFromState", () => {
    it("sets PI_FY_STAGE from currentPhase", () => {
      const handler = makeHandler({ phase: "design", slug: null });
      syncEnvVarsFromState(handler);
      expect(process.env.PI_FY_STAGE).toBe("design");
    });

    it("deletes PI_FY_STAGE when workflow state is null", () => {
      process.env.PI_FY_STAGE = "old";
      const handler = makeHandler({ phase: null, slug: null });
      syncEnvVarsFromState(handler);
      expect(process.env.PI_FY_STAGE).toBeUndefined();
    });

    it("sets PI_FY_STAGE regardless of whether a slug is active (stage is slug-independent)", () => {
      const handler = makeHandler({ phase: "review", slug: "my-feature" });
      syncEnvVarsFromState(handler);
      expect(process.env.PI_FY_STAGE).toBe("review");
    });

    it("sets PI_FY_STAGE even with no slug but phase set", () => {
      const handler = makeHandler({ phase: "implement", slug: null });
      syncEnvVarsFromState(handler);
      expect(process.env.PI_FY_STAGE).toBe("implement");
    });
  });
});

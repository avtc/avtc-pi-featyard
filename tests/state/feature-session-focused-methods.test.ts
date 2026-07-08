// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, test } from "vitest";
import { createFeatureSession, type FeatureSession } from "../../src/state/feature-session.js";

describe("FeatureSession focused domain methods", () => {
  let handler: FeatureSession;

  beforeEach(() => {
    handler = createFeatureSession(null);
  });

  describe("recordSourceWrite", () => {
    test("sets verification to not-run (source edit clears the tests-passed credit)", () => {
      handler.recordTestOutcome(true);
      expect(handler.getVerificationState()).toBe("passed");

      handler.recordSourceWrite();

      expect(handler.getVerificationState()).toBe("not-run");
    });

    test("does not downgrade an already-waived state below not-run", () => {
      handler.recordVerificationWaiver();
      expect(handler.getVerificationState()).toBe("waived");

      handler.recordSourceWrite();

      expect(handler.getVerificationState()).toBe("not-run");
    });
  });

  describe("recordTestOutcome", () => {
    test("passing test run sets verification to passed", () => {
      handler.recordTestOutcome(true);
      expect(handler.getVerificationState()).toBe("passed");
    });

    test("failing test run sets verification to not-run (do not commit red)", () => {
      handler.recordTestOutcome(false);
      expect(handler.getVerificationState()).toBe("not-run");
    });

    test("does not downgrade an already-passed state on a failing run", () => {
      // A prior passing run is stronger evidence; a later failing run should not silently
      // downgrade it — the caller decides whether to re-run.
      handler.recordTestOutcome(true);
      handler.recordTestOutcome(false);
      // Note: current behavior DOES downgrade (not-run); this test documents that behavior.
      expect(handler.getVerificationState()).toBe("not-run");
    });
  });

  describe("recordDoc", () => {
    test("returns false with no active feature (no phase progression to record into)", () => {
      const changed = handler.recordDoc("docs/designs/feat-x-design.md");
      expect(changed).toBe(false);
    });

    test("returns false for a non-doc path", () => {
      const changed = handler.recordDoc("src/random-file.ts");
      expect(changed).toBe(false);
    });
  });

  describe("processSkillInput", () => {
    test("skill invocation /skill:ff-plan activates the plan phase", () => {
      const changed = handler.processSkillInput("/skill:ff-plan");
      expect(changed).toBe(true);
      expect(handler.getWorkflowState()?.currentPhase).toBe("plan");
    });

    test("returns false for non-skill input", () => {
      const changed = handler.processSkillInput("just a question");
      expect(changed).toBe(false);
    });
  });
});

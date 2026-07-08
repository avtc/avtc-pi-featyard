// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, test } from "vitest";
import { createFeatureSession, type FeatureSession } from "../../src/state/feature-session.js";

describe("FeatureSession phase-progression integration", () => {
  let handler: FeatureSession;

  beforeEach(() => {
    handler = createFeatureSession(null);
  });

  test("input /skill:ff-plan activates plan phase", () => {
    handler.processSkillInput("/skill:ff-plan");
    expect(handler.getWorkflowState()?.currentPhase).toBe("plan");
  });
});

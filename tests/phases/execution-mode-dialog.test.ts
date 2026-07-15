// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Execution-mode application on phase_ready(plan).
 *
 * Formerly triggered by task_tracker init; after task_tracker removal the
 * plan→implement execution-mode application lives in the phase_ready(plan)
 * branch (maxPlanReviewRounds=0 applies it directly). These tests verify that
 * each implementMode setting dispatches the fy-implement skill.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createPiWithToolCapture,
  fireAllHandlers,
  settleAndDrainPostTurnFollowUp,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

const PLAN_SLUG = "2026-05-20-exec-mode";

async function firePlanReady() {
  const { fake, registeredTools, api } = createPiWithToolCapture();
  setTestSettings(null);
  await workflowMonitorExtension(api as unknown as ExtensionAPI);
  setSetting("maxPlanReviewRounds", 0);

  writeFeatureStateFile(PLAN_SLUG, {
    workflow: { currentPhase: "plan", designDoc: "docs/featyard/designs/test-design.md", planDoc: null },
  });
  await fireAllHandlers(
    fake.handlers,
    "session_start",
    { reason: "reload" },
    {
      hasUI: false,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: async () => "Continue" },
    },
  );

  const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as {
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<unknown>;
  };
  await phaseReady.execute("tc-1", {}, undefined, undefined, {
    hasUI: false,
    ui: { setWidget: () => {}, select: async () => "Continue" },
  });
  // fy-implement is staged for agent_settled delivery — settle + drain it so callers can assert on it.
  await fireAllHandlers(
    fake.handlers,
    "agent_end",
    {},
    {
      hasUI: false,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: async () => "Continue" },
    },
  );
  await settleAndDrainPostTurnFollowUp(fake.handlers);
  return { fake };
}

describe("Execution mode applied on phase_ready(plan)", () => {
  beforeEach(() => {
    setTestSettings(null);
  });

  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_EXECUTION_MODE;
  });

  test("current-session (checkpoint) mode dispatches fy-implement skill", async () => {
    setSetting("implementMode", "current-session");
    const { fake } = await firePlanReady();
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    expect(fake.sentMessages[fake.sentMessages.length - 1].message).toContain("fy-implement");
  });

  test("subagent-driven mode dispatches fy-implement skill", async () => {
    setSetting("implementMode", "subagent-driven");
    const { fake } = await firePlanReady();
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    expect(fake.sentMessages[fake.sentMessages.length - 1].message).toContain("fy-implement");
  });

  test("subagent-driven-fork mode dispatches fy-implement skill (auto-proceed, no dialog)", async () => {
    setSetting("implementMode", "subagent-driven-fork");
    const { fake } = await firePlanReady();
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    expect(fake.sentMessages[fake.sentMessages.length - 1].message).toContain("fy-implement");
  });
});

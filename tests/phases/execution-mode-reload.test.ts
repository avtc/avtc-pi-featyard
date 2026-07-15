// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { createFakePi, fireAllHandlers, writeFeatureStateFile } from "../helpers/workflow-monitor-test-helpers.js";

describe("Execution mode on session reload", () => {
  afterEach(() => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
  });

  test("does not show an execution mode dialog on session_start — mode comes from settings", async () => {
    // The executionModePending parking flag + re-trigger dialog were removed.
    // A feature left in plan with tasks but no executionMode (a session that ended
    // mid-transition) is an acceptable v1.0.0 edge case; no dialog is shown on reload.
    const fake = createFakePi();

    writeFeatureStateFile("2026-05-11-test-reload", {
      workflow: {
        currentPhase: "plan",
        phases: {
          design: "done",
          plan: "done",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        artifacts: {
          design: "docs/featyard/designs/2026-05-11-test-reload-design.md",
          plan: ".featyard/task-plans/2026-05-11-test-reload-task-plan.md",
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Simulate session_start with reason="startup" — env var is set, so it loads
    // feature state. No execution mode dialog should appear (mode is settings-driven).
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "startup" },
      {
        hasUI: true,
        cwd: process.cwd(),
        sessionManager: { getBranch: () => [] },
        ui: {
          setWidget: () => {},
          select: async () => {
            expect.unreachable("no execution mode dialog should be shown on reload");
            return "";
          },
          setEditorText: () => {},
        },
      },
    );
  });

  test("does not show a dialog when feature is mid-implement on session_start", async () => {
    const fake = createFakePi();

    writeFeatureStateFile("2026-05-11-test-no-pending", {
      workflow: {
        currentPhase: "implement",
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        artifacts: {
          design: "docs/featyard/designs/2026-05-11-test-no-pending-design.md",
          plan: ".featyard/task-plans/2026-05-11-test-no-pending-task-plan.md",
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    let selectCalled = false;
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { reason: "startup" },
      {
        hasUI: true,
        cwd: process.cwd(),
        sessionManager: { getBranch: () => [] },
        ui: {
          setWidget: () => {},
          select: async () => {
            selectCalled = true;
            return "";
          },
          setEditorText: () => {},
        },
      },
    );

    expect(selectCalled).toBe(false);
  });
});

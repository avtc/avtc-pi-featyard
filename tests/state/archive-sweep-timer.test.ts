// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { cleanupAfterTest, createFakePi, fireAllHandlers } from "../helpers/workflow-monitor-test-helpers.js";

const ORIGINAL_PID = process.env.PI_SUBAGENT_PARENT_PID;

// Each test starts in MAIN-session mode (timer setup only runs there). Unconditional delete so an
// ambient PI_SUBAGENT_PARENT_PID (e.g. tests run inside a pi subagent) does not skip timer setup.
// Mirrors the state-migration.test.ts pattern. Tests that need subagent mode set it in their body.
beforeEach(() => {
  delete process.env.PI_SUBAGENT_PARENT_PID;
});

afterEach(() => {
  // Restore subagent env so a stray set never leaks to later files (isolate:false).
  if (ORIGINAL_PID === undefined) delete process.env.PI_SUBAGENT_PARENT_PID;
  else process.env.PI_SUBAGENT_PARENT_PID = ORIGINAL_PID;
  // Clear any timer left on the bridge + reset the bridge field so tests are independent.
  const bridge = globalThis.__piWorkflowMonitor;
  if (bridge?.archiveTimer) {
    clearInterval(bridge.archiveTimer);
    bridge.archiveTimer = undefined;
  }
  cleanupAfterTest();
});

/**
 *  background sweep timer lifecycle (#10). The sweep itself
 * (archiveStaleArtifacts) is unit-tested in archive-feature.test.ts; these tests pin the
 * activation wiring: timer starts on the bridge in the main session, subagents skip it,
 * session_shutdown clears it, and re-activation clears the prior handle (no stacked timers).
 */
describe("archive sweep timer lifecycle", () => {
  test("main-session activation starts the 24h sweep timer on the bridge", async () => {
    const fake = createFakePi();
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    expect(globalThis.__piWorkflowMonitor?.archiveTimer).toBeDefined();
    // It's a real interval handle (a Timeout/object), not undefined.
    expect(typeof globalThis.__piWorkflowMonitor?.archiveTimer).toBe("object");
    // The interval period is 24h — pin the cadence so a regression (e.g. 24s) is caught.
    // Node's Timeout exposes its configured delay via `_idleTimeout` (ms).
    const handle = globalThis.__piWorkflowMonitor?.archiveTimer as unknown as { _idleTimeout?: number };
    expect(handle._idleTimeout).toBe(24 * 60 * 60 * 1000);
  });

  test("subagent-session activation starts NO timer (skipped)", async () => {
    process.env.PI_SUBAGENT_PARENT_PID = String(process.pid);
    const fake = createFakePi();
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    expect(globalThis.__piWorkflowMonitor?.archiveTimer).toBeUndefined();
  });

  test("session_shutdown clears the sweep timer", async () => {
    const fake = createFakePi();
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    expect(globalThis.__piWorkflowMonitor?.archiveTimer).toBeDefined();

    await fireAllHandlers(fake.handlers, "session_shutdown");

    expect(globalThis.__piWorkflowMonitor?.archiveTimer).toBeUndefined();
  });

  test("re-activation clears the prior timer (no stacked duplicate)", async () => {
    const fake = createFakePi();
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const first = globalThis.__piWorkflowMonitor?.archiveTimer;
    expect(first).toBeDefined();

    // Watch clearInterval so we can assert the PRIOR handle was actually cleared (not merely
    // replaced — a regression dropping clearInterval(first) would leave a stacked timer).
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    // Re-activate (simulates /reload re-evaluating the module).
    delete (globalThis as Record<string, unknown>).__avtcPiFeatureFlowWired;
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const second = globalThis.__piWorkflowMonitor?.archiveTimer;

    expect(second).toBeDefined();
    // A fresh handle was installed; the old one was cleared (not the same identity).
    expect(second).not.toBe(first);
    // The prior handle was passed to clearInterval (no leak).
    expect(clearSpy).toHaveBeenCalledWith(first);
    clearSpy.mockRestore();
  });
});

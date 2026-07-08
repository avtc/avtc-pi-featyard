// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../src/index.js";
import { cleanupAfterTest, createFakePi, type FakePi } from "./helpers/workflow-monitor-test-helpers.js";

const WIRED_FLAG = "__avtcPiFeatureFlowWired";

// Idempotency guard tests. feature-flow can be bundled into the avtc-pi umbrella AND installed
// standalone — whichever copy loads first wires, the rest must no-op. We assert the
// globalThis sentinel is set on first load and a second load returns without re-wiring.

describe("extension idempotent wiring guard", () => {
  let fake: FakePi;

  beforeEach(() => {
    // Start every test unwired so the first call always performs a real wiring.
    delete (globalThis as Record<string, unknown>)[WIRED_FLAG];
    fake = createFakePi();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[WIRED_FLAG];
    cleanupAfterTest();
  });

  test("first call does not throw and sets the globalThis flag", async () => {
    await expect(workflowMonitorExtension(fake.api as unknown as ExtensionAPI)).resolves.not.toThrow();
    expect((globalThis as Record<string, unknown>)[WIRED_FLAG]).toBe(true);
  });

  test("second call is a no-op (returns early without re-wiring)", async () => {
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    expect((globalThis as Record<string, unknown>)[WIRED_FLAG]).toBe(true);

    // Snapshot the handlers registered by the first (real) wiring.
    const firstHandlerCounts = new Map<string, number>();
    for (const [event, list] of fake.handlers) firstHandlerCounts.set(event, list.length);

    // Second call must short-circuit: no additional handlers get registered.
    await expect(workflowMonitorExtension(fake.api as unknown as ExtensionAPI)).resolves.not.toThrow();

    for (const [event, count] of firstHandlerCounts) {
      expect(fake.handlers.get(event)?.length ?? 0).toBe(count);
    }
    // Flag stays set.
    expect((globalThis as Record<string, unknown>)[WIRED_FLAG]).toBe(true);
  });

  test("globalThis flag is the wiring sentinel", async () => {
    expect((globalThis as Record<string, unknown>)[WIRED_FLAG]).toBeUndefined();
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    expect((globalThis as Record<string, unknown>)[WIRED_FLAG]).toBe(true);
  });

  test("session_shutdown resets the guard so /reload can re-wire", async () => {
    // First call performs a real wiring and sets the globalThis guard.
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    expect((globalThis as Record<string, unknown>)[WIRED_FLAG]).toBe(true);

    // Second call is a no-op: the guard short-circuits before re-wiring.
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    expect((globalThis as Record<string, unknown>)[WIRED_FLAG]).toBe(true);

    // Capture every session_shutdown handler registered via pi.on. The entry function registers
    // its own shutdown handler that resets the guard; firing all of them simulates the shutdown
    // that pi emits before a /reload re-evaluates this module.
    const shutdownHandlers = fake.handlers.get("session_shutdown") ?? [];
    expect(shutdownHandlers.length).toBeGreaterThan(0);
    for (const handler of shutdownHandlers) {
      await (handler as () => unknown)();
    }

    // The guard is cleared by the entry function's shutdown handler — without this, a /reload
    // re-evaluation would short-circuit and leave the extension dead.
    expect((globalThis as Record<string, unknown>)[WIRED_FLAG]).toBe(false);

    // Third call simulates a reload re-evaluation: it must re-wire and re-set the guard.
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    expect((globalThis as Record<string, unknown>)[WIRED_FLAG]).toBe(true);
  });
});

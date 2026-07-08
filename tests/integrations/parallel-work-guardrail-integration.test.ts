// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initGuardrailIntegration } from "../../src/integrations/parallel-work-guardrail-integration.js";
import type { PiWorkflowMonitorBridge } from "../../src/shared/types.js";

/** Generic event-handler signature used by the fake pi mock. */
type MockHandler = (...args: unknown[]) => unknown;

/** API emitted on the guardrail ready event. */
interface GuardrailReadyApi {
  addWhitelistCheck: (check: unknown) => void;
}

describe("initGuardrailIntegration", () => {
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__piWorkflowMonitor;
  });

  function createFakePi() {
    const eventHandlers = new Map<string, MockHandler[]>();
    return {
      eventHandlers,
      fakePi: {
        events: {
          on(channel: string, handler: MockHandler) {
            const list = eventHandlers.get(channel) ?? [];
            list.push(handler);
            eventHandlers.set(channel, list);
            return () => {
              const handlers = eventHandlers.get(channel);
              if (handlers) {
                const idx = handlers.indexOf(handler);
                if (idx >= 0) handlers.splice(idx, 1);
              }
            };
          },
          off: vi.fn(),
        },
        on: vi.fn((_event: string, _handler: MockHandler) => () => {}),
      } as unknown as ExtensionAPI,
    };
  }

  function createFakePiWithShutdown(shutdownHandlers: MockHandler[]) {
    const eventHandlers = new Map<string, MockHandler[]>();
    return {
      eventHandlers,
      fakePi: {
        events: {
          on(channel: string, handler: MockHandler) {
            const list = eventHandlers.get(channel) ?? [];
            list.push(handler);
            eventHandlers.set(channel, list);
            return () => {
              const handlers = eventHandlers.get(channel);
              if (handlers) {
                const idx = handlers.indexOf(handler);
                if (idx >= 0) handlers.splice(idx, 1);
              }
            };
          },
          off: vi.fn(),
        },
        on(event: string, handler: MockHandler) {
          if (event === "session_shutdown") {
            shutdownHandlers.push(handler);
          }
          return () => {
            const idx = shutdownHandlers.indexOf(handler);
            if (idx >= 0) shutdownHandlers.splice(idx, 1);
          };
        },
      } as unknown as ExtensionAPI,
    };
  }

  /** Captured hooks from the guardrail ready event. */
  type CapturedHooks = {
    isWhitelisted?: (categoryId: string) => boolean;
  };

  function emitReadyAndCaptureHooks(eventHandlers: Map<string, MockHandler[]>): CapturedHooks {
    const handlers = eventHandlers.get("pi-parallel-work-guardrail:ready");
    const captured: CapturedHooks = {};
    const mockApi: GuardrailReadyApi = {
      addWhitelistCheck: vi.fn((fn: unknown) => {
        captured.isWhitelisted = fn as (categoryId: string) => boolean;
      }),
    };
    if (handlers) {
      const first = handlers[0] as ((api: GuardrailReadyApi) => unknown) | undefined;
      first?.(mockApi);
    }
    return captured;
  }

  test("subscribes to pi-parallel-work-guardrail:ready and registers addWhitelistCheck", () => {
    const { eventHandlers, fakePi } = createFakePi();
    initGuardrailIntegration(fakePi);

    expect(eventHandlers.has("pi-parallel-work-guardrail:ready")).toBe(true);
    const hooks = emitReadyAndCaptureHooks(eventHandlers) as CapturedHooks & {
      isWhitelisted: (categoryId: string) => boolean;
    };

    expect(typeof hooks.isWhitelisted).toBe("function");
  });

  test("isWhitelisted returns false when finishPhaseWhitelisted is false", () => {
    const { eventHandlers, fakePi } = createFakePi();
    initGuardrailIntegration(fakePi);
    const hooks = emitReadyAndCaptureHooks(eventHandlers) as CapturedHooks & {
      isWhitelisted: (categoryId: string) => boolean;
    };

    expect(hooks.isWhitelisted("branch-switch")).toBe(false);
    expect(hooks.isWhitelisted("merge")).toBe(false);
  });

  test("isWhitelisted returns true for branch-switch and merge when finishPhaseWhitelisted is true", () => {
    const { eventHandlers, fakePi } = createFakePi();
    initGuardrailIntegration(fakePi);
    const hooks = emitReadyAndCaptureHooks(eventHandlers) as CapturedHooks & {
      isWhitelisted: (categoryId: string) => boolean;
    };

    if (!globalThis.__piWorkflowMonitor) {
      (globalThis as unknown as Record<string, unknown>).__piWorkflowMonitor = {
        finishPhaseWhitelisted: false,
      } as unknown as PiWorkflowMonitorBridge;
    }
    const bridge = globalThis.__piWorkflowMonitor;
    if (bridge) bridge.finishPhaseWhitelisted = true;

    expect(hooks.isWhitelisted("branch-switch")).toBe(true);
    expect(hooks.isWhitelisted("merge")).toBe(true);
  });

  test("isWhitelisted returns false for unknown categoryId even when whitelisted", () => {
    const { eventHandlers, fakePi } = createFakePi();
    initGuardrailIntegration(fakePi);
    const hooks = emitReadyAndCaptureHooks(eventHandlers) as CapturedHooks & {
      isWhitelisted: (categoryId: string) => boolean;
    };

    if (!globalThis.__piWorkflowMonitor) {
      (globalThis as unknown as Record<string, unknown>).__piWorkflowMonitor = {
        finishPhaseWhitelisted: false,
      } as unknown as PiWorkflowMonitorBridge;
    }
    const bridge2 = globalThis.__piWorkflowMonitor;
    if (bridge2) bridge2.finishPhaseWhitelisted = true;

    expect(hooks.isWhitelisted("unknown")).toBe(false);
    expect(hooks.isWhitelisted("git-push")).toBe(false);
  });

  test("session_shutdown cleanup removes :ready listener, preventing duplicate hooks on reload", () => {
    const shutdownHandlers: MockHandler[] = [];
    const { eventHandlers, fakePi } = createFakePiWithShutdown(shutdownHandlers);

    // First subscription
    initGuardrailIntegration(fakePi);
    expect(eventHandlers.get("pi-parallel-work-guardrail:ready")?.length).toBe(1);

    // Fire session_shutdown — should clean up :ready listener
    for (const h of shutdownHandlers) h();
    expect(eventHandlers.get("pi-parallel-work-guardrail:ready")?.length ?? 0).toBe(0);

    // Re-subscribe (simulates reload)
    initGuardrailIntegration(fakePi);
    expect(eventHandlers.get("pi-parallel-work-guardrail:ready")?.length).toBe(1);

    // Fire :ready and verify addWhitelistCheck fires exactly once
    let whitelistCheckCallCount = 0;
    const handlers = eventHandlers.get("pi-parallel-work-guardrail:ready");
    if (!handlers) throw new Error("no ready handlers");
    const firstHandler = handlers[0] as ((api: GuardrailReadyApi) => unknown) | undefined;
    if (!firstHandler) throw new Error("no first handler");
    firstHandler({
      addWhitelistCheck: () => {
        whitelistCheckCallCount++;
      },
    });
    expect(whitelistCheckCallCount).toBe(1);
  });
});

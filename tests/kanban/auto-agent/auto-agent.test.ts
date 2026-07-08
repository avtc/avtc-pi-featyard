// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, test, vi } from "vitest";
import { AutoAgentStateMachine } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { log } from "../../../src/log.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AutoAgentStateMachine", () => {
  test("initial state is idle", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    expect(sm.getState()).toBe("idle");
  });

  test("worker transitions: idle → working → idle", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    expect(sm.start()).toBe(true);
    expect(sm.getState()).toBe("working");
    expect(sm.start()).toBe(false); // already working
    sm.complete();
    expect(sm.getState()).toBe("idle");
  });

  test("waiting transition", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.block();
    expect(sm.getState()).toBe("waiting");
    sm.unblock();
    expect(sm.getState()).toBe("working");
  });

  test("polling transition when no feature available", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.noFeatureAvailable();
    expect(sm.getState()).toBe("polling");
    sm.featureFound();
    expect(sm.getState()).toBe("working");
  });

  test("requestStop immediately transitions working → stopped", () => {
    // requestStop is unconditional and immediate (no deferred "finish first" behavior):
    // from any state it clears timers/overlay and lands in "stopped".
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    expect(sm.getState()).toBe("working");
    sm.requestStop();
    expect(sm.getState()).toBe("stopped");
  });

  test("requestStop immediately transitions waiting → stopped", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.block();
    expect(sm.getState()).toBe("waiting");
    sm.requestStop();
    expect(sm.getState()).toBe("stopped");
  });

  test("requestStop immediately transitions paused → stopped", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.pause();
    expect(sm.getState()).toBe("paused");
    sm.requestStop();
    expect(sm.getState()).toBe("stopped");
  });

  test("requestStop from waiting clears the waiting-for-response overlay", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    const overlayCalls: Array<{ featureId: number; status: string | null }> = [];
    sm.setOverlayCallback((featureId, status) => overlayCalls.push({ featureId, status }));

    sm.start();
    sm.adoptFeature(7, "in-progress");
    sm.block(); // sets the "waiting-for-response" overlay via overlayCallback
    expect(sm.getState()).toBe("waiting");
    // block() should have pushed the waiting-for-response status for feature 7
    expect(overlayCalls.some((c) => c.featureId === 7 && c.status === "waiting-for-response")).toBe(true);

    sm.requestStop();
    // requestStop must clear the overlay (status -> null) for the same feature
    expect(overlayCalls.some((c) => c.featureId === 7 && c.status === null)).toBe(true);
    expect(sm.getState()).toBe("stopped");
  });

  test("stop requested during polling", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.noFeatureAvailable();
    sm.requestStop();
    expect(sm.getState()).toBe("stopped");
  });

  test("error transitions to error state", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.error("Something went wrong");
    expect(sm.getState()).toBe("error");
  });

  test("reset returns to idle", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.error("test");
    sm.reset();
    expect(sm.getState()).toBe("idle");
  });

  test("setRole switches role in place and preserves state, feature, and lock identity", () => {
    // Role switch should NOT tear down the agent: the same SM keeps running,
    // its current feature and session identity (and thus its lock) are preserved.
    // Only getLanes() changes, so the NEXT feature pick uses the new role's lanes.
    const sessionId = "role-switch-session";
    const sm = new AutoAgentStateMachine("worker", 1, sessionId);
    sm.start();
    sm.adoptFeature(42, "in-progress");
    expect(sm.getRole()).toBe("worker");

    sm.setRole("designer");

    // Role updated...
    expect(sm.getRole()).toBe("designer");
    // ...but everything else preserved.
    expect(sm.getState()).toBe("working");
    expect(sm.getCurrentFeatureId()).toBe(42);
    expect(sm.sessionId).toBe(sessionId);
    // Lanes now reflect the designer role.
    expect(sm.getLanes()).toEqual(["design"]);
  });

  test("setRole with the same role is a no-op (no change, no 'role changed' log)", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const sessionId = "no-op-role-session";
    const sm = new AutoAgentStateMachine("worker", 1, sessionId);
    sm.start();
    sm.adoptFeature(7, "in-progress");
    infoSpy.mockClear();

    sm.setRole("worker"); // same role — early-returns

    // Nothing changes...
    expect(sm.getRole()).toBe("worker");
    expect(sm.getState()).toBe("working");
    expect(sm.getCurrentFeatureId()).toBe(7);
    expect(sm.sessionId).toBe(sessionId);
    // ...and the "role changed" log is NOT emitted (confirms the early return,
    // not merely that the fields happen to still match).
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});

describe("AutoAgentStateMachine heartbeat timer", () => {
  test("startHeartbeat sets up interval that calls heartbeatFn", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    const heartbeatFn = vi.fn();
    const featureId = 42;

    sm.start();
    sm.startHeartbeat(featureId, heartbeatFn, 60000);

    // Not called immediately
    expect(heartbeatFn).not.toHaveBeenCalled();

    // Called after 60s
    vi.advanceTimersByTime(60_000);
    expect(heartbeatFn).toHaveBeenCalledTimes(1);
    expect(heartbeatFn).toHaveBeenCalledWith(featureId);

    // Called again after another 60s
    vi.advanceTimersByTime(60_000);
    expect(heartbeatFn).toHaveBeenCalledTimes(2);

    sm.stopHeartbeat();
    vi.useRealTimers();
  });

  test("complete clears heartbeat timer", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    const heartbeatFn = vi.fn();

    sm.start();
    sm.startHeartbeat(42, heartbeatFn, 60000);
    sm.complete();

    // Timer should be cleared — no more calls
    vi.advanceTimersByTime(120_000);
    expect(heartbeatFn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("error clears heartbeat timer", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    const heartbeatFn = vi.fn();

    sm.start();
    sm.startHeartbeat(42, heartbeatFn, 60000);
    sm.error("crash");

    vi.advanceTimersByTime(120_000);
    expect(heartbeatFn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("requestStop clears heartbeat timer", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    const heartbeatFn = vi.fn();

    sm.start();
    sm.startHeartbeat(42, heartbeatFn, 60000);
    sm.requestStop();

    vi.advanceTimersByTime(120_000);
    expect(heartbeatFn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("requestStop clears wait timeout timer", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    const timeoutCalls: Array<{ featureId: number; reason: string }> = [];

    sm.start();
    (sm as unknown as Record<string, unknown>).currentFeatureId = 42;
    sm.setWaitTimeoutConfig(600_000, (featureId, reason) => {
      timeoutCalls.push({ featureId, reason });
    });
    sm.startWaitTimeoutForFeature(42);
    sm.block(); // waiting state with active timer

    sm.requestStop();
    vi.advanceTimersByTime(600_000);
    expect(timeoutCalls).toEqual([]); // Timer was cancelled by requestStop

    vi.useRealTimers();
  });

  test("pause stops auto-loop but keeps current feature", () => {
    const sm = new AutoAgentStateMachine("designer", 1, "test-session");
    sm.start();
    (sm as unknown as Record<string, unknown>).currentFeatureId = 99;
    (sm as unknown as Record<string, unknown>).currentFeatureLane = "design";

    sm.pause();

    expect(sm.getState()).toBe("paused");
    expect(sm.getCurrentFeatureId()).toBe(99); // Feature preserved
    expect(sm.getCurrentFeatureLane()).toBe("design");
  });

  test("pause stops auto-loop from waiting state", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    (sm as unknown as Record<string, unknown>).currentFeatureId = 50;
    (sm as unknown as Record<string, unknown>).currentFeatureLane = "ready";
    sm.block();

    expect(sm.getState()).toBe("waiting");
    sm.pause();

    expect(sm.getState()).toBe("paused");
    expect(sm.getCurrentFeatureId()).toBe(50);
  });

  test("pause from idle state preserves no-feature state", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();

    sm.pause();

    expect(sm.getState()).toBe("paused");
    expect(sm.getCurrentFeatureId()).toBeNull();
  });

  test("pause stops polling timer", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.noFeatureAvailable(); // transitions to polling

    expect(sm.getState()).toBe("polling");
    sm.pause();

    expect(sm.getState()).toBe("paused");
  });

  test("reset clears heartbeat timer", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    const heartbeatFn = vi.fn();

    sm.start();
    sm.startHeartbeat(42, heartbeatFn, 60000);
    sm.reset();

    vi.advanceTimersByTime(120_000);
    expect(heartbeatFn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("stopHeartbeat is idempotent", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    // Should not throw when called without startHeartbeat
    expect(() => sm.stopHeartbeat()).not.toThrow();
  });

  describe("overlay status on block/unblock", () => {
    test("block sets waiting-for-response overlay via callback", () => {
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      // Simulate feature picked
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const overlayCalls: Array<{ featureId: number; status: string | null }> = [];
      sm.setOverlayCallback((featureId, status) => {
        overlayCalls.push({ featureId, status });
      });

      sm.block();
      expect(sm.getState()).toBe("waiting");
      expect(overlayCalls).toEqual([{ featureId: 42, status: "waiting-for-response" }]);
    });

    test("unblock clears overlay via callback", () => {
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const overlayCalls: Array<{ featureId: number; status: string | null }> = [];
      sm.setOverlayCallback((featureId, status) => {
        overlayCalls.push({ featureId, status });
      });

      sm.block();
      sm.unblock();
      expect(sm.getState()).toBe("working");
      expect(overlayCalls).toEqual([
        { featureId: 42, status: "waiting-for-response" },
        { featureId: 42, status: null },
      ]);
    });

    test("complete clears overlay when in waiting state", () => {
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const overlayCalls: Array<{ featureId: number; status: string | null }> = [];
      sm.setOverlayCallback((featureId, status) => {
        overlayCalls.push({ featureId, status });
      });

      sm.block();
      sm.complete();
      expect(overlayCalls).toEqual([
        { featureId: 42, status: "waiting-for-response" },
        { featureId: 42, status: null },
      ]);
    });

    test("error clears overlay", () => {
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const overlayCalls: Array<{ featureId: number; status: string | null }> = [];
      sm.setOverlayCallback((featureId, status) => {
        overlayCalls.push({ featureId, status });
      });

      sm.block();
      sm.error("test error");
      expect(overlayCalls).toEqual([
        { featureId: 42, status: "waiting-for-response" },
        { featureId: 42, status: null },
      ]);
    });

    test("block without overlay callback does not throw", () => {
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;
      expect(() => sm.block()).not.toThrow();
      expect(sm.getState()).toBe("waiting");
    });

    test("block without current feature does not call callback", () => {
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      // currentFeatureId is null

      const overlayCalls: Array<{ featureId: number; status: string | null }> = [];
      sm.setOverlayCallback((featureId, status) => {
        overlayCalls.push({ featureId, status });
      });

      sm.block();
      expect(sm.getState()).toBe("waiting");
      expect(overlayCalls).toEqual([]);
    });
  });

  describe("wait timeout behavior", () => {
    test("worker timeout fires after autoWorkerWaitTimeoutMs", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const timeoutCalls: Array<{ featureId: number; reason: string }> = [];
      sm.startWaitTimeout(42, 600_000, (featureId, reason) => {
        timeoutCalls.push({ featureId, reason });
      });

      sm.block();
      expect(timeoutCalls).toEqual([]);

      // Advance past timeout
      vi.advanceTimersByTime(600_000);
      expect(timeoutCalls).toEqual([{ featureId: 42, reason: "timeout" }]);

      vi.useRealTimers();
    });

    test("setWaitTimeoutMs updates the duration while keeping the original onTimeout callback", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const timeoutCalls: Array<{ featureId: number; reason: string }> = [];
      // Configure with an initial duration + callback.
      sm.setWaitTimeoutConfig(600_000, (featureId, reason) => {
        timeoutCalls.push({ featureId, reason });
      });
      // Role switch: update ONLY the duration; the onTimeout callback must be retained.
      sm.setWaitTimeoutMs(30_000);

      // Start the wait timeout using the stored config (new duration + original callback).
      sm.startWaitTimeoutForFeature(42);
      sm.block();

      // The OLD duration has NOT elapsed yet...
      vi.advanceTimersByTime(30_000 - 1);
      expect(timeoutCalls).toEqual([]);

      // ...but the NEW (shorter) duration has, and the ORIGINAL callback fires.
      vi.advanceTimersByTime(1);
      expect(timeoutCalls).toEqual([{ featureId: 42, reason: "timeout" }]);

      vi.useRealTimers();
    });

    test("designer with null timeout never fires", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const timeoutCalls: Array<{ featureId: number; reason: string }> = [];
      // null timeout = infinite wait
      sm.startWaitTimeout(42, null, (featureId, reason) => {
        timeoutCalls.push({ featureId, reason });
      });

      sm.block();

      // Advance way past any reasonable timeout
      vi.advanceTimersByTime(86_400_000); // 24 hours
      expect(timeoutCalls).toEqual([]);

      vi.useRealTimers();
    });

    test("unblock cancels timeout timer", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const timeoutCalls: Array<{ featureId: number; reason: string }> = [];
      sm.startWaitTimeout(42, 600_000, (featureId, reason) => {
        timeoutCalls.push({ featureId, reason });
      });

      sm.block();
      sm.unblock(); // cancels timeout

      vi.advanceTimersByTime(600_000);
      expect(timeoutCalls).toEqual([]); // no timeout fired

      vi.useRealTimers();
    });

    test("complete cancels timeout timer", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const timeoutCalls: Array<{ featureId: number; reason: string }> = [];
      sm.startWaitTimeout(42, 600_000, (featureId, reason) => {
        timeoutCalls.push({ featureId, reason });
      });

      sm.block();
      sm.complete();

      vi.advanceTimersByTime(600_000);
      expect(timeoutCalls).toEqual([]);

      vi.useRealTimers();
    });

    test("error cancels timeout timer", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const timeoutCalls: Array<{ featureId: number; reason: string }> = [];
      sm.startWaitTimeout(42, 600_000, (featureId, reason) => {
        timeoutCalls.push({ featureId, reason });
      });

      sm.block();
      sm.error("test error");

      vi.advanceTimersByTime(600_000);
      expect(timeoutCalls).toEqual([]);

      vi.useRealTimers();
    });

    test("restart behavior: startWaitTimeout after unblock clears old timer and starts fresh", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const timeoutCalls: Array<{ featureId: number; reason: string }> = [];
      const onTimeout = (featureId: number, reason: "timeout") => {
        timeoutCalls.push({ featureId, reason });
      };

      // First block cycle
      sm.startWaitTimeout(42, 600_000, onTimeout);
      sm.block();

      // Advance 300ms (halfway through first timeout)
      vi.advanceTimersByTime(300_000);
      expect(timeoutCalls).toEqual([]); // no timeout yet

      // Unblock cancels first timeout
      sm.unblock();
      expect(timeoutCalls).toEqual([]); // still no timeout

      // Re-block with new timeout
      sm.startWaitTimeout(42, 600_000, onTimeout);
      sm.block();

      // Advance 300ms — this is 600ms from the FIRST startWaitTimeout call,
      // but only 300ms from the SECOND. Old timer was cleared.
      vi.advanceTimersByTime(300_000);
      expect(timeoutCalls).toEqual([]); // old timer was cleared, this is only halfway through new timer

      // Advance remaining 300ms to complete the new timeout
      vi.advanceTimersByTime(300_000);
      expect(timeoutCalls).toEqual([{ featureId: 42, reason: "timeout" }]);

      vi.useRealTimers();
    });
  });

  describe("startWaitTimeoutForFeature production path", () => {
    test("uses stored config from setWaitTimeoutConfig", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const timeoutCalls: Array<{ featureId: number; reason: string }> = [];
      sm.setWaitTimeoutConfig(600_000, (featureId, reason) => {
        timeoutCalls.push({ featureId, reason });
      });
      sm.startWaitTimeoutForFeature(42);

      sm.block();
      expect(timeoutCalls).toEqual([]);

      vi.advanceTimersByTime(600_000);
      expect(timeoutCalls).toEqual([{ featureId: 42, reason: "timeout" }]);

      vi.useRealTimers();
    });

    test("does nothing when config not set", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("worker", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      // No setWaitTimeoutConfig call
      sm.startWaitTimeoutForFeature(42);

      sm.block();
      vi.advanceTimersByTime(600_000);
      // No timeout fired because config was never set
      expect(sm.getState()).toBe("waiting");

      vi.useRealTimers();
    });

    test("does nothing when timeoutMs is null", () => {
      vi.useFakeTimers();
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      (sm as unknown as Record<string, unknown>).currentFeatureId = 42;

      const timeoutCalls: Array<{ featureId: number; reason: string }> = [];
      sm.setWaitTimeoutConfig(null, (featureId, reason) => {
        timeoutCalls.push({ featureId, reason });
      });
      sm.startWaitTimeoutForFeature(42);

      sm.block();
      vi.advanceTimersByTime(86_400_000); // 24 hours
      expect(timeoutCalls).toEqual([]); // null timeout = no timer

      vi.useRealTimers();
    });
  });
});

describe("AutoAgentStateMachine polling timer", () => {
  test("setPollingTimer stores timer and clears previous", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();

    // Set first timer
    const cb1 = vi.fn();
    sm.setPollingTimer(setTimeout(cb1, 1000));

    // Set second timer — should clear first
    const cb2 = vi.fn();
    sm.setPollingTimer(setTimeout(cb2, 2000));

    // Advance past first timer's duration — cb1 should NOT fire (cleared)
    vi.advanceTimersByTime(1500);
    expect(cb1).not.toHaveBeenCalled();

    // Advance past second timer — cb2 should fire
    vi.advanceTimersByTime(1000);
    expect(cb2).toHaveBeenCalledOnce();
  });

  test("stopPollingTimer clears active timer", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();

    const cb = vi.fn();
    sm.setPollingTimer(setTimeout(cb, 5000));

    // Stop the timer before it fires
    sm.stopPollingTimer();

    // Advance past the timer duration — callback should NOT fire
    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled();
  });

  test("stopPollingTimer is safe to call when no timer active", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    // Should not throw
    expect(() => sm.stopPollingTimer()).not.toThrow();
  });

  test("stop clears polling timer", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.noFeatureAvailable(); // enter polling state

    const cb = vi.fn();
    sm.setPollingTimer(setTimeout(cb, 5000));

    // Request stop + complete should clear the timer
    sm.requestStop();
    // After requestStop during polling, state becomes stopped immediately

    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled();
  });

  test("error clears polling timer", () => {
    vi.useFakeTimers();
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.noFeatureAvailable(); // enter polling state

    const cb = vi.fn();
    sm.setPollingTimer(setTimeout(cb, 5000));

    sm.error("test error");

    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("complete guard for invalid states", () => {
  test("complete from idle state is a no-op", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    // Don't start — state is idle
    sm.complete();
    expect(sm.getState()).toBe("idle");
  });

  test("complete from polling state is a no-op", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.noFeatureAvailable(); // polling
    expect(sm.getState()).toBe("polling");
    sm.complete();
    expect(sm.getState()).toBe("polling"); // unchanged
  });

  test("complete from stopped state is a no-op", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.requestStop();
    sm.complete();
    expect(sm.getState()).toBe("stopped");
    sm.complete(); // call again from stopped
    expect(sm.getState()).toBe("stopped"); // unchanged
  });

  test("complete from error state is a no-op", () => {
    const sm = new AutoAgentStateMachine("worker", 1, "test-session");
    sm.start();
    sm.error("test");
    expect(sm.getState()).toBe("error");
    sm.complete();
    expect(sm.getState()).toBe("error"); // unchanged
  });

  describe("grace-period state", () => {
    test("enterGracePeriod from polling state", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      sm.noFeatureAvailable(); // working → polling
      expect(sm.getState()).toBe("polling");
      sm.enterGracePeriod();
      expect(sm.getState()).toBe("grace-period");
    });

    test("enterGracePeriod from working state", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      expect(sm.getState()).toBe("working");
      sm.enterGracePeriod();
      expect(sm.getState()).toBe("grace-period");
    });

    test("enterGracePeriod from idle is no-op", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.enterGracePeriod();
      expect(sm.getState()).toBe("idle");
    });

    test("enterGracePeriod from waiting is no-op", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      sm.block();
      sm.enterGracePeriod();
      expect(sm.getState()).toBe("waiting");
    });

    test("enterGracePeriod from paused is no-op", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      sm.pause();
      sm.enterGracePeriod();
      expect(sm.getState()).toBe("paused");
    });

    test("enterGracePeriod from stopped is no-op", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      sm.noFeatureAvailable(); // working → polling
      sm.requestStop(); // polling → stopped
      expect(sm.getState()).toBe("stopped");
      sm.enterGracePeriod();
      expect(sm.getState()).toBe("stopped");
    });

    test("exitGracePeriod transitions to working", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      sm.enterGracePeriod();
      expect(sm.getState()).toBe("grace-period");
      sm.exitGracePeriod();
      expect(sm.getState()).toBe("working");
    });

    test("exitGracePeriod from non-grace-period is no-op", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      sm.exitGracePeriod();
      expect(sm.getState()).toBe("working");
    });

    test("requestStop from grace-period transitions to stopped", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      sm.noFeatureAvailable();
      sm.enterGracePeriod();
      sm.requestStop();
      expect(sm.getState()).toBe("stopped");
    });

    test("pause from grace-period transitions to paused", () => {
      const sm = new AutoAgentStateMachine("designer", 1, "test-session");
      sm.start();
      sm.noFeatureAvailable();
      sm.enterGracePeriod();
      sm.pause();
      expect(sm.getState()).toBe("paused");
    });
  });
});

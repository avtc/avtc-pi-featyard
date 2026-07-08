// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, test, vi } from "vitest";

// We test the class directly
import { GracePeriodManager } from "../../../src/kanban/auto-agent/auto-agent-grace-period.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("GracePeriodManager", () => {
  test("starts countdown and expires after duration", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 5000 });
    mgr.start();

    expect(mgr.isActive()).toBe(true);
    expect(onTick).toHaveBeenCalledWith(5); // Initial tick

    // Advance 4 seconds (4 interval ticks at 1s, 2s, 3s, 4s)
    vi.advanceTimersByTime(4000);
    expect(onTick).toHaveBeenCalledWith(1); // remainingMs=1000 → ceil(1)=1
    expect(onExpired).not.toHaveBeenCalled();

    // Advance past expiry (5th tick: remainingMs=0 → expire)
    vi.advanceTimersByTime(2000);
    expect(onTick).toHaveBeenCalledWith(0); // Final tick before stop
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(mgr.isActive()).toBe(false);
  });

  test("onEnd called on expire", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 1000 });
    mgr.start();

    vi.advanceTimersByTime(1500);
    expect(onEnd).toHaveBeenCalled();
  });

  test("user activity resets timer to full duration", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 3000 });
    mgr.start();

    // Advance 2 seconds
    vi.advanceTimersByTime(2000);
    expect(onTick).toHaveBeenLastCalledWith(1); // remainingMs=1000 → ceil(1)=1

    // User activity resets
    mgr.onUserActivity();
    expect(onTick).toHaveBeenLastCalledWith(3); // reset to full duration (3000ms → ceil(3)=3)

    // Advance 2 more seconds — should NOT have expired (reset to 3s)
    vi.advanceTimersByTime(2000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(mgr.isActive()).toBe(true);

    // Advance past the new expiry
    vi.advanceTimersByTime(2000);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  test("pause stops countdown ticks", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 5000 });
    mgr.start();

    vi.advanceTimersByTime(1000);
    mgr.pause();

    const tickCountBefore = onTick.mock.calls.length;
    vi.advanceTimersByTime(10000);
    // No new ticks while paused
    expect(onTick.mock.calls.length).toBe(tickCountBefore);
    expect(onExpired).not.toHaveBeenCalled();

    // Resume
    mgr.resume();
    vi.advanceTimersByTime(5000);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  test("stop prevents onExpired from being called", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 3000 });
    mgr.start();

    vi.advanceTimersByTime(1000);
    mgr.stop();

    vi.advanceTimersByTime(10000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalled();
    expect(mgr.isActive()).toBe(false);
  });

  test("multiple user activities keep resetting timer", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 3000 });
    mgr.start();

    // Activity every 2 seconds — should never expire
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(2000);
      mgr.onUserActivity();
    }
    expect(onExpired).not.toHaveBeenCalled();
    expect(mgr.isActive()).toBe(true);
  });

  test("getRemainingSeconds returns correct countdown", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 5000 });
    mgr.start();
    expect(mgr.getRemainingSeconds()).toBe(5);

    vi.advanceTimersByTime(2500);
    expect(mgr.getRemainingSeconds()).toBe(3); // ceil(2.5) = 3

    vi.advanceTimersByTime(2000);
    expect(mgr.getRemainingSeconds()).toBe(1); // ceil(0.5) = 1
  });

  test("onExpired errors are caught (no unhandled rejection)", async () => {
    vi.useFakeTimers();
    const { log } = await import("../../../src/log.js");
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const onExpired = vi.fn().mockRejectedValue(new Error("test error"));
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 1000 });
    mgr.start();

    vi.advanceTimersByTime(1500);
    expect(onExpired).toHaveBeenCalled();

    // Flush microtasks
    await vi.advanceTimersByTimeAsync(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("GracePeriodManager"), expect.any(Error));
    errorSpy.mockRestore();
  });

  test("onEnd called on stop", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 5000 });
    mgr.start();
    mgr.stop();
    expect(onEnd).toHaveBeenCalled();
  });

  test("onEnd NOT called when stop is invoked on inactive manager", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 5000 });
    // stop without start — should NOT call onEnd (wasActive=false)
    mgr.stop();
    expect(onEnd).not.toHaveBeenCalled();
  });

  test("onUserActivity during pause resets timer for when resumed", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 5000 });
    mgr.start();
    vi.advanceTimersByTime(3000); // 2s remaining
    expect(mgr.getRemainingSeconds()).toBe(2);

    mgr.pause();
    const tickCallsBefore = onTick.mock.calls.length;
    mgr.onUserActivity(); // Resets remainingMs even while paused
    // onTick should NOT fire while paused (fix)
    expect(onTick.mock.calls.length).toBe(tickCallsBefore);
    // Timer was reset to 5s by onUserActivity
    expect(mgr.getRemainingSeconds()).toBe(5);

    mgr.resume();
    // After resume, countdown continues from 5s (reset by onUserActivity)
    vi.advanceTimersByTime(1000);
    expect(mgr.getRemainingSeconds()).toBe(4);

    vi.useRealTimers();
  });

  test("resume without onUserActivity continues from paused position", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn().mockResolvedValue(undefined);
    const onTick = vi.fn();
    const onEnd = vi.fn();

    const mgr = new GracePeriodManager(onExpired, onTick, onEnd, { durationMs: 5000 });
    mgr.start();
    vi.advanceTimersByTime(3000); // 2s remaining
    expect(mgr.getRemainingSeconds()).toBe(2);

    mgr.pause();
    vi.advanceTimersByTime(10000); // paused — no countdown
    expect(mgr.getRemainingSeconds()).toBe(2); // unchanged

    mgr.resume();
    expect(mgr.getRemainingSeconds()).toBe(2); // still 2, not reset
    vi.advanceTimersByTime(2000); // remaining 2s elapses
    expect(onExpired).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

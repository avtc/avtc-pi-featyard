// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearPostTurnFollowUp,
  hasPostTurnFollowUp,
  schedulePostTurnDrain,
  schedulePostTurnFollowUp,
} from "../../src/state/post-turn-dispatch.js";

/** Build a fake pi that records sendUserMessage calls. */
function makeFakePi(): { pi: ExtensionAPI; sent: { text: string; deliverAs?: string }[] } {
  const sent: { text: string; deliverAs?: string }[] = [];
  const pi = {
    sendUserMessage(text: string, options: { deliverAs?: string } | null) {
      sent.push({ text, deliverAs: options?.deliverAs });
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

describe("post-turn-dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPostTurnFollowUp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("schedule then drain delivers exactly one followUp after the delay", () => {
    const { pi, sent } = makeFakePi();
    schedulePostTurnFollowUp("fy-design-review #2");

    // Nothing delivered immediately when drain is scheduled...
    schedulePostTurnDrain(pi);
    expect(sent).toHaveLength(0);

    // ...and nothing before the delay elapses.
    vi.advanceTimersByTime(499);
    expect(sent).toHaveLength(0);

    // Delivered exactly once when the delay fires.
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ text: "fy-design-review #2", deliverAs: "followUp" });
  });

  test("schedulePostTurnDrain is a no-op when nothing is staged", () => {
    const { pi, sent } = makeFakePi();
    schedulePostTurnDrain(pi);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });

  test("a followUp is delivered at most once — a second drain after delivery sends nothing", () => {
    const { pi, sent } = makeFakePi();
    schedulePostTurnFollowUp("fy-plan");
    schedulePostTurnDrain(pi);
    vi.advanceTimersByTime(500);
    // Slot is cleared on delivery; scheduling drain again (nothing staged) is a no-op.
    schedulePostTurnDrain(pi);
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(1);
  });

  test("a newer schedule supersedes a stale one (only the latest is delivered)", () => {
    const { pi, sent } = makeFakePi();
    schedulePostTurnFollowUp("first");
    schedulePostTurnFollowUp("second");
    schedulePostTurnDrain(pi);
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("second");
  });

  test("clear drops a staged followUp and cancels a pending drain", () => {
    const { pi, sent } = makeFakePi();
    schedulePostTurnFollowUp("fy-review");
    schedulePostTurnDrain(pi);
    clearPostTurnFollowUp();
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });

  test("hasPostTurnFollowUp reflects whether a followUp is staged", () => {
    const { pi } = makeFakePi();
    expect(hasPostTurnFollowUp()).toBe(false);
    schedulePostTurnFollowUp("fy-review");
    expect(hasPostTurnFollowUp()).toBe(true);
    // Still staged while a drain is pending (not yet fired)...
    schedulePostTurnDrain(pi);
    vi.advanceTimersByTime(499);
    expect(hasPostTurnFollowUp()).toBe(true);
    // ...and cleared once the drain fires.
    vi.advanceTimersByTime(1);
    expect(hasPostTurnFollowUp()).toBe(false);
  });

  test("hasPostTurnFollowUp is false after clearPostTurnFollowUp", () => {
    schedulePostTurnFollowUp("fy-review");
    expect(hasPostTurnFollowUp()).toBe(true);
    clearPostTurnFollowUp();
    expect(hasPostTurnFollowUp()).toBe(false);
  });

  test("a second schedulePostTurnDrain while one is pending is a no-op (no double delivery)", () => {
    const { pi, sent } = makeFakePi();
    schedulePostTurnFollowUp("fy-review");
    schedulePostTurnDrain(pi);
    schedulePostTurnDrain(pi); // pending drain already exists — ignored
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(1);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _resetCompactGuard, triggerContextCompact } from "../../src/compaction/compact-trigger.js";

/**
 * Unit tests for the shared context-compaction helper.
 *
 * ctx.compact({onError}) is fire-and-forget (void) and aborts the current turn; pi
 * emits session_compact on success (the compaction.ts handler delivers the follow-up
 * and clears the guard) or routes failure to onError. On failure the agent's turn was
 * already aborted, so the injected `recover` (the compaction module's recoverCompactFailure,
 * supplied by the caller's deps) resumes it with the full follow-up. This module owns only
 * the policy + guard/follow-up state; recovery is a pure injected dependency.
 */

/** A ctx.compact mock that captures the options (so a test can fire onError). */
function makeCtx(opts: { tokens?: number } = {}) {
  let captured: { onError?: (err: Error) => void } | undefined;
  const ctx = {
    hasUI: false,
    ui: { setWidget: vi.fn() },
    sessionManager: { getBranch: () => [] },
    compact: (options?: { onError?: (err: Error) => void }) => {
      captured = options;
    },
    getContextUsage: opts.tokens === undefined ? undefined : () => ({ tokens: opts.tokens }),
  };
  return { ctx: ctx as unknown as ExtensionContext, fireOnError: (err: Error) => captured?.onError?.(err) };
}

/** Payload builder. */
function payload(settingValue: string, logLabel: string) {
  return { settingValue, message: "continue after compact", logLabel };
}

describe("triggerContextCompact", () => {
  beforeEach(() => {
    _resetCompactGuard();
    delete (globalThis as unknown as Record<string, unknown>).__piCompactFollowUp;
  });

  afterEach(() => {
    _resetCompactGuard();
    delete (globalThis as unknown as Record<string, unknown>).__piCompactFollowUp;
  });

  test("initiates the compact, stores the follow-up, and passes an onError hook", async () => {
    const recover = vi.fn();
    const { ctx } = makeCtx({ tokens: 200_000 });
    const result = await triggerContextCompact(ctx, payload("compact>100K", "test boundary"), null, recover);
    expect(result).toBe(true);
    expect((globalThis as unknown as Record<string, unknown>).__piCompactFollowUp).toBeDefined();
  });

  test("returns false when mode is none (no compaction configured)", async () => {
    const recover = vi.fn();
    const { ctx } = makeCtx();
    const result = await triggerContextCompact(ctx, payload("none", "test boundary"), null, recover);
    expect(result).toBe(false);
    expect((globalThis as unknown as Record<string, unknown>).__piCompactFollowUp).toBeUndefined();
  });

  test("returns false when below the configured token threshold", async () => {
    const recover = vi.fn();
    const { ctx } = makeCtx({ tokens: 1_000 });
    const result = await triggerContextCompact(ctx, payload("compact>100K", "test boundary"), null, recover);
    expect(result).toBe(false);
    expect((globalThis as unknown as Record<string, unknown>).__piCompactFollowUp).toBeUndefined();
  });

  test("returns false when already in progress (re-entrancy guard)", async () => {
    const recover = vi.fn();
    const { ctx } = makeCtx({ tokens: 200_000 });
    const first = await triggerContextCompact(ctx, payload("compact>100K", "test boundary"), null, recover);
    expect(first).toBe(true);
    const second = await triggerContextCompact(ctx, payload("compact>100K", "test boundary"), null, recover);
    expect(second).toBe(false);
  });

  test("on compact failure, invokes the injected recover (compaction.recoverCompactFailure)", async () => {
    const recover = vi.fn();
    const { ctx, fireOnError } = makeCtx({ tokens: 200_000 });
    await triggerContextCompact(ctx, payload("compact>100K", "test boundary"), null, recover);
    expect((globalThis as unknown as Record<string, unknown>).__piCompactFollowUp).toBeDefined();
    fireOnError(new Error("compact failed"));
    expect(recover).toHaveBeenCalledTimes(1);
  });

  test("on synchronous compact throw, cleans up guard + follow-up and returns false (no deadlock)", async () => {
    const recover = vi.fn();
    // A ctx whose compact() throws synchronously (before onError can fire) would leak the
    // re-entrancy guard + orphan the follow-up if uncaught — the try/catch must clean up.
    const ctx = {
      hasUI: false,
      ui: { setWidget: vi.fn() },
      sessionManager: { getBranch: () => [] },
      compact: () => {
        throw new Error("compact threw before firing");
      },
      getContextUsage: () => ({ tokens: 200_000 }),
    } as unknown as ExtensionContext;
    const result = await triggerContextCompact(ctx, payload("compact>100K", "test boundary"), null, recover);
    expect(result).toBe(false);
    // Follow-up deleted so a later compact is not orphaned.
    expect((globalThis as unknown as Record<string, unknown>).__piCompactFollowUp).toBeUndefined();
    // Guard reset: a subsequent triggerContextCompact proceeds (returns true), not skipped.
    const okCtx = {
      hasUI: false,
      ui: { setWidget: vi.fn() },
      sessionManager: { getBranch: () => [] },
      compact: () => {},
      getContextUsage: () => ({ tokens: 200_000 }),
    } as unknown as ExtensionContext;
    const second = await triggerContextCompact(okCtx, payload("compact>100K", "test boundary"), null, recover);
    expect(second).toBe(true);
  });

  test("the re-entrancy guard is cleared by the compaction lifecycle, not by triggerContextCompact itself", async () => {
    const recover = vi.fn();
    const { ctx } = makeCtx({ tokens: 200_000 });
    const first = await triggerContextCompact(ctx, payload("compact>100K", "test boundary"), null, recover);
    expect(first).toBe(true);
    const stored = (globalThis as { __piCompactFollowUp?: { onAfterFollowUp: () => void } }).__piCompactFollowUp;
    expect(stored).toBeDefined();
    stored?.onAfterFollowUp(); // session_compact runs this on success.
    const second = await triggerContextCompact(ctx, payload("compact>100K", "test boundary"), null, recover);
    expect(second).toBe(true);
  });
});

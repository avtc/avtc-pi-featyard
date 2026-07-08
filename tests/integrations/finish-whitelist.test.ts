// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for feature-flow's finish-phase whitelist integration.
 *
 * Feature-flow provides a whitelist check function to guardrail that reads
 * globalThis.__piWorkflowMonitor.finishPhaseWhitelisted and allows branch-switch
 * and merge categories when the flag is true.
 *
 * These tests verify ONLY feature-flow's whitelist function — not guardrail's
 * command→category mapping (tested in pi-parallel-work-guardrail).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isFinishPhaseWhitelisted, setFinishPhaseWhitelisted } from "../../src/git/worktrees/worktree-lifecycle.js";
import { finishPhaseWhitelistCheck as whitelistCheck } from "../../src/integrations/parallel-work-guardrail-integration.js";
import type { PiWorkflowMonitorBridge } from "../../src/shared/types.js";

const IS_WHITELISTED = true;
const IS_NOT_WHITELISTED = false;

describe("finish-phase whitelist check function", () => {
  beforeEach(() => {
    if (!globalThis.__piWorkflowMonitor) {
      globalThis.__piWorkflowMonitor = { finishPhaseWhitelisted: false } as PiWorkflowMonitorBridge;
    }
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
  });

  afterEach(() => {
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
  });

  // --- Flag setting ---

  test("setFinishPhaseWhitelisted(IS_WHITELISTED) sets flag", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    expect(isFinishPhaseWhitelisted()).toBe(true);
  });

  test("setFinishPhaseWhitelisted(IS_NOT_WHITELISTED) clears flag", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    setFinishPhaseWhitelisted(IS_NOT_WHITELISTED);
    expect(isFinishPhaseWhitelisted()).toBe(false);
  });

  // --- Whitelist check: branch-switch ---

  test("allows branch-switch when flag is true", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    expect(whitelistCheck("branch-switch")).toBe(true);
  });

  test("blocks branch-switch when flag is false", () => {
    expect(whitelistCheck("branch-switch")).toBe(false);
  });

  // --- Whitelist check: merge ---

  test("allows merge when flag is true", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    expect(whitelistCheck("merge")).toBe(true);
  });

  test("blocks merge when flag is false", () => {
    expect(whitelistCheck("merge")).toBe(false);
  });

  // --- Non-whitelisted categories ---

  test("push NOT whitelisted even when flag is true", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    expect(whitelistCheck("push")).toBe(false);
  });

  test("reset-hard NOT whitelisted even when flag is true", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    expect(whitelistCheck("reset-hard")).toBe(false);
  });

  test("stash NOT whitelisted even when flag is true", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    expect(whitelistCheck("stash")).toBe(false);
  });

  test("rebase NOT whitelisted even when flag is true", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    expect(whitelistCheck("rebase")).toBe(false);
  });

  test("checkout-restore NOT whitelisted even when flag is true", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    expect(whitelistCheck("checkout-restore")).toBe(false);
  });

  test("unknown category NOT whitelisted even when flag is true", () => {
    setFinishPhaseWhitelisted(IS_WHITELISTED);
    expect(whitelistCheck("anything-else")).toBe(false);
  });

  // --- Edge cases ---

  test("returns false when __piWorkflowMonitor is undefined", () => {
    delete (globalThis as unknown as Record<string, unknown>).__piWorkflowMonitor;
    expect(whitelistCheck("branch-switch")).toBe(false);
    expect(whitelistCheck("merge")).toBe(false);
  });
});

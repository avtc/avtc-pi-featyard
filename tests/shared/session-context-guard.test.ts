// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiCtx } from "../../src/shared/types.js";

describe("PiCtx", () => {
  it("returns undefined before refresh", () => {
    const guard = new PiCtx();
    expect(guard.newSession).toBeUndefined();
    expect(guard.switchSession).toBeUndefined();
    expect(guard.sessionManager).toBeUndefined();
    expect(guard.model).toBeUndefined();
    expect(guard.modelRegistry).toBeUndefined();
    expect(guard.cwd).toBeUndefined();
  });

  it("stashes functions from ctx on refresh", () => {
    const guard = new PiCtx();
    const mockNewSession = vi.fn();
    const mockSwitchSession = vi.fn();
    const mockNotify = vi.fn();
    const mockSessionManager = { getSessionCount: vi.fn() };
    const mockModel = { id: "test-model" };
    const mockModelRegistry = { find: vi.fn() };

    guard.refresh({
      newSession: mockNewSession,
      switchSession: mockSwitchSession,
      sessionManager: mockSessionManager,
      ui: { notify: mockNotify },
      model: mockModel,
      modelRegistry: mockModelRegistry,
      cwd: "/test/path",
    } as unknown as ExtensionCommandContext);

    expect(guard.cwd).toBe("/test/path");
    expect(guard.newSession).toBeDefined();
    expect(guard.switchSession).toBeDefined();
    expect(guard.sessionManager).toBe(mockSessionManager);
    expect(guard.model).toBe(mockModel);
    expect(guard.modelRegistry).toBe(mockModelRegistry);
    // Verify bound functions work — calling the stashed version delegates to the mock
    const newSession = guard.newSession;
    if (newSession) newSession();
    expect(mockNewSession).toHaveBeenCalled();
  });

  it("notify is no-op when not refreshed", () => {
    const guard = new PiCtx();
    expect(() => guard.notify("test", "info")).not.toThrow();
    expect(() => guard.notify("test", "error")).not.toThrow();
  });

  it("notify calls stashed function when refreshed", () => {
    const guard = new PiCtx();
    const mockNotify = vi.fn();
    guard.refresh({
      newSession: vi.fn(),
      ui: { notify: mockNotify },
      cwd: "/test",
    } as unknown as ExtensionCommandContext);

    guard.notify("hello", "warning");
    expect(mockNotify).toHaveBeenCalledWith("hello", "warning");
  });

  it("overwrites on second refresh", () => {
    const guard = new PiCtx();
    guard.refresh({ cwd: "/first", newSession: vi.fn() } as unknown as ExtensionCommandContext);
    guard.refresh({ cwd: "/second", newSession: vi.fn() } as unknown as ExtensionCommandContext);
    expect(guard.cwd).toBe("/second");
  });

  it("handles ctx without ui gracefully", () => {
    const guard = new PiCtx();
    guard.refresh({
      newSession: vi.fn(),
      cwd: "/test",
    } as unknown as ExtensionCommandContext);
    // notify should be no-op since ui was not provided
    expect(() => guard.notify("test", "info")).not.toThrow();
  });

  it("notify getter returns stable identity when not refreshed", () => {
    const guard = new PiCtx();
    expect(guard.notify).toBe(guard.notify);
  });

  it("notify getter returns stable identity after refresh", () => {
    const guard = new PiCtx();
    const mockNotify = vi.fn();
    guard.refresh({
      newSession: vi.fn(),
      ui: { notify: mockNotify },
      cwd: "/test",
    } as unknown as ExtensionCommandContext);

    // Repeated access should return the same bound function identity
    const first = guard.notify;
    const second = guard.notify;
    expect(first).toBe(second);
    // And calling it should still delegate to the original mock
    first("test-msg", "warning");
    expect(mockNotify).toHaveBeenCalledWith("test-msg", "warning");
  });

  it("handles ctx without switchSession gracefully", () => {
    const guard = new PiCtx();
    guard.refresh({
      newSession: vi.fn(),
      cwd: "/test",
    } as unknown as ExtensionCommandContext);
    expect(guard.switchSession).toBeUndefined();
  });

  it("skips non-function newSession/switchSession values", () => {
    const guard = new PiCtx();
    guard.refresh({
      newSession: "not-a-function" as unknown as ExtensionCommandContext["newSession"],
      switchSession: 42 as unknown as ExtensionCommandContext["switchSession"],
      cwd: "/test",
    } as unknown as ExtensionCommandContext);
    expect(guard.newSession).toBeUndefined();
    expect(guard.switchSession).toBeUndefined();
    expect(guard.cwd).toBe("/test");
  });

  it("skips undefined notify on refresh but keeps previous stash", () => {
    const guard = new PiCtx();
    const mockNotify = vi.fn();
    guard.refresh({
      newSession: vi.fn(),
      ui: { notify: mockNotify },
      cwd: "/first",
    } as unknown as ExtensionCommandContext);
    // Second refresh without ui — should NOT overwrite notify since ui?.notify is falsy
    guard.refresh({
      newSession: vi.fn(),
      cwd: "/second",
    } as unknown as ExtensionCommandContext);
    guard.notify("still works", "info");
    expect(mockNotify).toHaveBeenCalledWith("still works", "info");
  });

  it("preserves previous cwd when refresh receives undefined cwd", () => {
    const guard = new PiCtx();
    guard.refresh({
      newSession: vi.fn(),
      cwd: "/original",
    } as unknown as ExtensionCommandContext);
    expect(guard.cwd).toBe("/original");

    // Second refresh with undefined cwd — should keep previous value
    guard.refresh({
      newSession: vi.fn(),
    } as unknown as ExtensionCommandContext);
    expect(guard.cwd).toBe("/original");
  });

  it("preserves previous cwd when refresh receives empty string cwd", () => {
    const guard = new PiCtx();
    guard.refresh({
      newSession: vi.fn(),
      cwd: "/original",
    } as unknown as ExtensionCommandContext);
    expect(guard.cwd).toBe("/original");

    // Empty string is falsy — should keep previous value
    guard.refresh({
      newSession: vi.fn(),
      cwd: "",
    } as unknown as ExtensionCommandContext);
    expect(guard.cwd).toBe("/original");
  });
});

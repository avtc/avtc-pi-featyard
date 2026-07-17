// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { resetInstances } from "../../src/kanban/kanban-bridge.js";
import { type AgentLoopDeps, createGenerateTitleCallback } from "../../src/kanban/kanban-generate-title.js";
import { createMockAgentLoop } from "../helpers/server-test-helpers.js";

afterEach(() => {
  resetInstances();
});

describe("createGenerateTitleCallback", () => {
  test("throws when no model captured", async () => {
    const callback = createGenerateTitleCallback(
      () => undefined,
      () => undefined,
      { agentLoop: createMockAgentLoop("test") as unknown as AgentLoopDeps["agentLoop"] },
    );

    await expect(callback("some description", undefined)).rejects.toThrow(
      "Start a conversation with pi first to enable AI-powered import",
    );
  });

  test("throws when no model registry captured", async () => {
    const callback = createGenerateTitleCallback(
      () => ({ provider: "test", id: "model-1" }) as unknown as Model<Api>,
      () => undefined,
      { agentLoop: createMockAgentLoop("test") as unknown as AgentLoopDeps["agentLoop"] },
    );

    await expect(callback("some description", undefined)).rejects.toThrow(
      "Start a conversation with pi first to enable AI-powered import",
    );
  });

  test("throws when auth fails (no API key)", async () => {
    const mockRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: false, apiKey: null }),
    } as unknown as ModelRegistry;
    const callback = createGenerateTitleCallback(
      () => ({ provider: "test-provider", id: "model-1" }) as unknown as Model<Api>,
      () => mockRegistry,
      { agentLoop: createMockAgentLoop("test") as unknown as AgentLoopDeps["agentLoop"] },
    );

    await expect(callback("some description", undefined)).rejects.toThrow('No API key for provider "test-provider"');
  });

  test("passes correct auth info to generateTitleCore", async () => {
    const mockRegistry = {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "test-key-123",
        headers: { "X-Custom": "header" },
      }),
    } as unknown as ModelRegistry;
    const model = { provider: "test-provider", id: "model-1" } as unknown as Model<Api>;
    const mockLoop = createMockAgentLoop("Generated Title");

    const callback = createGenerateTitleCallback(
      () => model,
      () => mockRegistry,
      { agentLoop: mockLoop as unknown as AgentLoopDeps["agentLoop"] },
    );

    const result = await callback("Build auth system", undefined);
    expect(result).toBe("Generated Title");

    // Verify agentLoop was called with correct auth info in config
    expect(mockLoop).toHaveBeenCalledTimes(1);
    const [_prompts, _context, config] = mockLoop.mock.calls[0];
    expect(config.apiKey).toBe("test-key-123");
    expect(config.headers).toEqual({ "X-Custom": "header" });
    expect(config.model).toBe(model);
  });

  test("forwards AbortSignal to agentLoop", async () => {
    const mockRegistry = {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "key",
        headers: {},
      }),
    } as unknown as ModelRegistry;
    const mockLoop = createMockAgentLoop("Title");

    const callback = createGenerateTitleCallback(
      () => ({ provider: "p", id: "m" }) as unknown as Model<Api>,
      () => mockRegistry,
      { agentLoop: mockLoop as unknown as AgentLoopDeps["agentLoop"] },
    );

    const controller = new AbortController();
    await callback("test", controller.signal);

    expect(mockLoop).toHaveBeenCalledTimes(1);
    const signal = mockLoop.mock.calls[0][3];
    expect(signal).toBe(controller.signal);
  });
});

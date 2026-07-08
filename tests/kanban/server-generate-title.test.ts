// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, test, vi } from "vitest";
import { resetRateLimits } from "../../src/kanban/kanban-server.js";
import { fetchPort, NO_SETUP_OPTIONS, setup } from "../helpers/server-test-helpers.js";

describe("POST /api/generate-title", () => {
  afterEach(() => {
    resetRateLimits();
  });
  test("returns generated title for valid description", async () => {
    const generateTitle = vi.fn().mockResolvedValue("Add login page");
    const { port, authToken } = await setup({ generateTitle });

    const res = await fetchPort(
      port,
      "/api/generate-title",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "We need a login page with email and password fields" }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.title).toBe("Add login page");
    expect(generateTitle).toHaveBeenCalledOnce();
  });

  test("truncates long descriptions before sending to LLM", async () => {
    const generateTitle = vi.fn().mockResolvedValue("Short title");
    const { port, authToken } = await setup({ generateTitle });

    const longDescription = "x".repeat(3000);
    const res = await fetchPort(
      port,
      "/api/generate-title",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: longDescription }),
      },
      authToken,
    );
    expect(res.status).toBe(200);
    // Verify description was truncated to MAX_LLM_DESCRIPTION_LENGTH (2000)
    expect(generateTitle).toHaveBeenCalledOnce();
    const sentDescription = generateTitle.mock.calls[0][0] as string;
    expect(sentDescription.length).toBe(2000);
  });

  test("returns 400 when description is missing", async () => {
    const generateTitle = vi.fn().mockResolvedValue("Title");
    const { port, authToken } = await setup({ generateTitle });

    const res = await fetchPort(
      port,
      "/api/generate-title",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/description/i);
    expect(generateTitle).not.toHaveBeenCalled();
  });

  test("returns 400 when description is empty string", async () => {
    const generateTitle = vi.fn().mockResolvedValue("Title");
    const { port, authToken } = await setup({ generateTitle });

    const res = await fetchPort(
      port,
      "/api/generate-title",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "   " }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/description/i);
    expect(generateTitle).not.toHaveBeenCalled();
  });

  test("returns 400 when description is not a string", async () => {
    const generateTitle = vi.fn().mockResolvedValue("Title");
    const { port, authToken } = await setup({ generateTitle });

    const res = await fetchPort(
      port,
      "/api/generate-title",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: 123 }),
      },
      authToken,
    );
    expect(res.status).toBe(400);
    expect(generateTitle).not.toHaveBeenCalled();
  });

  test("returns 503 when generateTitle callback is not configured", async () => {
    const { port, authToken } = await setup(NO_SETUP_OPTIONS); // no generateTitle

    const res = await fetchPort(
      port,
      "/api/generate-title",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Some description" }),
      },
      authToken,
    );
    expect(res.status).toBe(503);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/pi session/i);
  });

  test("returns 500 when LLM generation fails", async () => {
    const generateTitle = vi.fn().mockRejectedValue(new Error("LLM timeout"));
    const { port, authToken } = await setup({ generateTitle });

    const res = await fetchPort(
      port,
      "/api/generate-title",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Build a dashboard" }),
      },
      authToken,
    );
    expect(res.status).toBe(500);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toMatch(/title generation failed/i);
  });

  test("returns 400 for invalid JSON body", async () => {
    const generateTitle = vi.fn().mockResolvedValue("Title");
    const { port, authToken } = await setup({ generateTitle });

    const res = await globalThis.fetch(`http://localhost:${port}/api/generate-title`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect(generateTitle).not.toHaveBeenCalled();
  });

  test("returns 429 when rate limit exceeded", async () => {
    const generateTitle = vi.fn().mockResolvedValue("Title");
    const { port, authToken } = await setup({ generateTitle });
    resetRateLimits(); // start fresh

    // Exhaust the 10-request limit
    for (let i = 0; i < 10; i++) {
      const res = await globalThis.fetch(`http://localhost:${port}/api/generate-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ description: `Request ${i}` }),
      });
      expect(res.status).toBe(200);
    }

    // 11th request should be rate-limited
    const res = await globalThis.fetch(`http://localhost:${port}/api/generate-title`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ description: "One more" }),
    });
    expect(res.status).toBe(429);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toContain("Rate limit");
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { findLatestCustomEntry } from "../../src/shared/session-entries.js";

function mockCtx(branch: unknown[]) {
  return {
    sessionManager: {
      getBranch: () => branch as SessionEntry[],
    },
  } as unknown as ExtensionContext;
}

describe("findLatestCustomEntry", () => {
  test("returns undefined for empty branch", () => {
    const ctx = mockCtx([]);
    expect(findLatestCustomEntry(ctx, "my-type")).toBeUndefined();
  });

  test("returns undefined when no matching customType exists", () => {
    const ctx = mockCtx([
      { type: "user", content: "hello" },
      { type: "custom", customType: "other-type", data: { foo: 1 } },
      { type: "assistant", content: "hi" },
    ]);
    expect(findLatestCustomEntry(ctx, "my-type")).toBeUndefined();
  });

  test("returns data from latest matching custom entry", () => {
    const ctx = mockCtx([
      { type: "custom", customType: "my-type", data: { version: 1 } },
      { type: "user", content: "hello" },
      { type: "custom", customType: "my-type", data: { version: 2 } },
    ]);
    expect(findLatestCustomEntry(ctx, "my-type")).toEqual({ version: 2 });
  });

  test("returns data from only matching entry", () => {
    const ctx = mockCtx([
      { type: "user", content: "hello" },
      { type: "custom", customType: "my-type", data: { solo: true } },
      { type: "assistant", content: "hi" },
    ]);
    expect(findLatestCustomEntry(ctx, "my-type")).toEqual({ solo: true });
  });

  test("skips non-custom entries", () => {
    const ctx = mockCtx([
      { type: "user", content: "hello" },
      { type: "assistant", content: "world" },
      { type: "tool_result", content: "result" },
    ]);
    expect(findLatestCustomEntry(ctx, "my-type")).toBeUndefined();
  });

  test("returns undefined when getBranch throws", () => {
    const ctx = {
      sessionManager: {
        getBranch: () => {
          throw new Error("session expired");
        },
      },
    } as unknown as ExtensionContext;
    expect(findLatestCustomEntry(ctx, "my-type")).toBeUndefined();
  });

  test("returns typed data with generic parameter", () => {
    interface MyData {
      items: string[];
      count: number;
    }
    const data: MyData = { items: ["a", "b"], count: 2 };
    const ctx = mockCtx([{ type: "custom", customType: "my-type", data }]);
    const result = findLatestCustomEntry<MyData>(ctx, "my-type");
    expect(result).toEqual(data);
    expect(result?.items).toEqual(["a", "b"]);
    expect(result?.count).toBe(2);
  });

  test("returns first match when multiple custom types exist", () => {
    const ctx = mockCtx([
      { type: "custom", customType: "type-a", data: { a: 1 } },
      { type: "custom", customType: "type-b", data: { b: 2 } },
      { type: "custom", customType: "type-a", data: { a: 3 } },
    ]);
    expect(findLatestCustomEntry(ctx, "type-a")).toEqual({ a: 3 });
    expect(findLatestCustomEntry(ctx, "type-b")).toEqual({ b: 2 });
  });
});

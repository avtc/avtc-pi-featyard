// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { readBody } from "../../src/kanban/kanban-server.js";

function makeReq(body: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.push(Buffer.from(body));
  req.push(null);
  return req;
}

describe("readBody", () => {
  test("reads body within default 1MB limit", async () => {
    const req = makeReq("hello");
    const result = await readBody(req, null);
    expect(result).toBe("hello");
  });
  test("rejects body exceeding custom maxSize", async () => {
    const req = makeReq("a".repeat(100));
    await expect(readBody(req, 50)).rejects.toThrow("Request body too large");
  });
  test("accepts body within custom maxSize", async () => {
    const req = makeReq("a".repeat(100));
    const result = await readBody(req, 200);
    expect(result.length).toBe(100);
  });
});

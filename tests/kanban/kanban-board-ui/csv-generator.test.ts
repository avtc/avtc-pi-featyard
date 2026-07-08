// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { csvQuote, generateCsv } from "../../../src/kanban/kanban-server.js";

describe("csvQuote", () => {
  test("passes through simple text", () => {
    expect(csvQuote("hello")).toBe("hello");
  });
  test("quotes fields with commas", () => {
    expect(csvQuote("a,b")).toBe('"a,b"');
  });
  test("quotes fields with newlines", () => {
    expect(csvQuote("line1\nline2")).toBe('"line1\nline2"');
  });
  test("quotes fields with CRLF line endings", () => {
    expect(csvQuote("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
  test("escapes internal double quotes", () => {
    expect(csvQuote('say "hello"')).toBe('"say ""hello"""');
  });
  test("handles empty string", () => {
    expect(csvQuote("")).toBe("");
  });
  test("handles null", () => {
    expect(csvQuote(null)).toBe("");
  });
  test("defends against formula injection with leading =", () => {
    expect(csvQuote("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
  });
  test("defends against formula injection with leading +", () => {
    expect(csvQuote("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
  });
  test("defends against formula injection with leading", () => {
    expect(csvQuote("-1+1|cmd")).toBe("'-1+1|cmd");
  });
  test("defends against formula injection with leading @", () => {
    expect(csvQuote("@SUM(A1)")).toBe("'@SUM(A1)");
  });
  test("defends against formula injection with leading tab", () => {
    expect(csvQuote("\t=SUM(A1)")).toBe("'\t=SUM(A1)");
  });
  test("defends against formula injection with leading CR", () => {
    expect(csvQuote("\r=SUM(A1)")).toBe('"\'\r=SUM(A1)"');
  });
  test("defends against formula injection with leading space", () => {
    expect(csvQuote(" =SUM(A1)")).toBe("' =SUM(A1)");
  });
  test("formula defense works with commas in value", () => {
    expect(csvQuote("=SUM(A1,B1)")).toBe('"\'=SUM(A1,B1)"');
  });
  test("does not prefix safe values", () => {
    expect(csvQuote("hello world")).toBe("hello world");
    expect(csvQuote("123")).toBe("123");
  });
});

describe("generateCsv", () => {
  test("generates CSV with headers and rows", () => {
    const headers = ["Title", "Lane"];
    const rows = [
      ["Add auth", "backlog"],
      ["Fix bug", "done"],
    ];
    expect(generateCsv(headers, rows)).toBe("Title,Lane\nAdd auth,backlog\nFix bug,done\n");
  });
  test("quotes multiline description", () => {
    const headers = ["Title", "Description"];
    const rows = [["Auth", "line1\nline2"]];
    expect(generateCsv(headers, rows)).toBe('Title,Description\nAuth,"line1\nline2"\n');
  });
});

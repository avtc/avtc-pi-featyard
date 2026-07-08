// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import parseCSV from "../../../src/kanban/kanban-board-ui/csv-parser.js";

describe("parseCSV", () => {
  test("parses simple single-column CSV", () => {
    expect(parseCSV("hello\nworld")).toEqual(["hello", "world"]);
  });
  test("handles quoted multiline fields", () => {
    expect(parseCSV('"line1\nline2"')).toEqual(["line1\nline2"]);
  });
  test("handles escaped quotes", () => {
    expect(parseCSV('say ""hello""')).toEqual(['say "hello"']);
  });
  test("handles multi-column CSV — returns first column", () => {
    expect(parseCSV("a,b\nc,d")).toEqual(["a", "c"]);
  });
  test("handles CRLF line endings", () => {
    expect(parseCSV("a\r\nb")).toEqual(["a", "b"]);
  });
  test("handles empty input", () => {
    expect(parseCSV("")).toEqual([]);
  });
  test("handles unterminated quote — returns partial field", () => {
    expect(parseCSV('"unterminated')).toEqual(["unterminated"]);
  });
  test("handles unterminated quote with newline inside", () => {
    expect(parseCSV('"line1\nline2')).toEqual(["line1\nline2"]);
  });
  test("handles quoted fields containing commas", () => {
    expect(parseCSV('"hello, world"')).toEqual(["hello, world"]);
  });
  test("handles quoted fields with commas across multiple rows", () => {
    expect(parseCSV('"a, b"\n"c, d"')).toEqual(["a, b", "c, d"]);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { generateSlug } from "../../src/kanban/kanban-server.js";

describe("generateSlug", () => {
  test("generates date-prefixed slug from title", () => {
    const slug = generateSlug("Add auth system");
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-add-auth-system$/);
  });
  test("lowercases and replaces special chars", () => {
    const slug = generateSlug("Fix: Bug #123!");
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-fix-bug-123$/);
  });
  test("strips leading/trailing hyphens from feature part", () => {
    const slug = generateSlug("---test---");
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-test$/);
  });
  test("handles title that sanitizes to empty — uses 'untitled' fallback", () => {
    const slug = generateSlug("!!!");
    // Feature part is empty after sanitization, fallback to "untitled"
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-untitled$/);
  });
});

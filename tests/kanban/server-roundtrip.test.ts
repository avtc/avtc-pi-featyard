// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// tests/extension/kanban/server-roundtrip.test.ts
import { describe, expect, test } from "vitest";
import { fetchPort, setup } from "../helpers/server-test-helpers.js";

describe("Import → Export round-trip", () => {
  test("imported features appear in CSV export with correct data", async () => {
    const generateTitle = async (desc: string) => `Title: ${desc.slice(0, 30)}`;
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-roundtrip-test-", generateTitle });
    const projectId = db.createProject({ name: "round-trip", repoPath: "/test" });

    // Import 3 features via batch endpoint
    const importRes = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [
            { description: "Build authentication system" },
            { description: "Add dark mode toggle" },
            { description: "Write API documentation" },
          ],
        }),
      },
      authToken,
    );

    expect(importRes.status).toBe(200);
    const importData = await importRes.json();
    expect((importData as { imported: number }).imported).toBe(3);
    expect((importData as { skipped: number }).skipped).toBe(0);

    // Export the board as CSV
    const exportRes = await fetchPort(port, `/api/board/${projectId}/export`, null, authToken);
    expect(exportRes.status).toBe(200);

    const csv = await exportRes.text();

    // Verify header row
    expect(csv.startsWith("Title,Description,Lane,Priority,Slug,Created,Updated\n")).toBe(true);

    // Verify each imported feature appears in export
    expect(csv).toContain("Title: Build authentication system");
    expect(csv).toContain("Title: Add dark mode toggle");
    expect(csv).toContain("Title: Write API documentation");

    // Count data rows by counting non-header occurrences of "backlog"
    // (robust against multiline descriptions that would break split("\n"))
    const backlogCount = (csv.match(/\bbacklog\b/g) || []).length;
    expect(backlogCount).toBe(3);
  });

  test("round-trip preserves multiline descriptions", async () => {
    const generateTitle = async (desc: string) => `Title: ${desc.split("\n")[0]}`;
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-roundtrip-test-", generateTitle });
    const projectId = db.createProject({ name: "multiline-rt", repoPath: "/test" });

    const multilineDesc = "First line of description\nSecond line of description\nThird line with, comma";
    const importRes = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [{ description: multilineDesc }],
        }),
      },
      authToken,
    );

    expect(importRes.status).toBe(200);
    const importData = await importRes.json();
    expect((importData as { imported: number }).imported).toBe(1);

    // Export and verify the multiline description is preserved
    const exportRes = await fetchPort(port, `/api/board/${projectId}/export`, null, authToken);
    expect(exportRes.status).toBe(200);

    const csv = await exportRes.text();
    // The multiline description should be properly quoted in CSV
    expect(csv).toContain("First line of description");
    expect(csv).toContain("Second line of description");
    expect(csv).toContain("Third line with, comma");
    // Verify the feature was stored with full description
    expect((importData as { features: Array<{ description: string }> }).features[0].description).toBe(multilineDesc);
  });
});

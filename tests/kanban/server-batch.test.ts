// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// tests/extension/kanban/server-batch.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { resetRateLimits } from "../../src/kanban/kanban-server.js";
import { fetchPort, setup } from "../helpers/server-test-helpers.js";

describe("POST /api/features/batch", () => {
  afterEach(() => {
    resetRateLimits();
  });
  test("imports features with generated titles", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc.slice(0, 20)}`,
    });
    const projectId = db.createProject({ name: "test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: projectId,
          rows: [{ description: "Build auth system" }, { description: "Add dark mode" }],
        }),
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(2);
    expect(data.skipped).toBe(0);
    expect(data.features).toHaveLength(2);
    // Verify feature content
    expect(data.features[0].title).toBe("Title: Build auth system");
    expect(data.features[0].description).toBe("Build auth system");
    expect(data.features[0].lane).toBe("backlog");
    expect(data.features[0].slug).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    expect(data.features[1].title).toBe("Title: Add dark mode");
    expect(data.features[1].description).toBe("Add dark mode");
    expect(data.features[1].lane).toBe("backlog");
  });

  test("skips rows with empty descriptions", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    const projectId = db.createProject({ name: "test2", repoPath: "/test2" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: projectId,
          rows: [{ description: "Good task" }, { description: "" }],
        }),
      },
      authToken,
    );

    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.skippedRows[0].row).toBe(2);
    expect(data.skippedRows[0].description).toBe("");
    expect(data.skippedRows[0].reason).toContain("Empty");
  });

  test("skips rows with whitespace-only descriptions", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    const projectId = db.createProject({ name: "ws-test", repoPath: "/ws-test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [{ description: "   " }, { description: "Good task" }],
        }),
      },
      authToken,
    );

    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.skippedRows[0].row).toBe(1);
    expect(data.skippedRows[0].description).toBe("   ");
    expect(data.skippedRows[0].reason).toContain("Empty");
  });

  test("skips rows when title generation fails", async () => {
    let callCount = 0;
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (_desc) => {
        callCount++;
        if (callCount === 1) throw new Error("LLM timeout");
        return "Second title";
      },
    });
    const projectId = db.createProject({ name: "test3", repoPath: "/test3" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: projectId,
          rows: [{ description: "Fail this" }, { description: "Succeed this" }],
        }),
      },
      authToken,
    );

    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.skippedRows[0].reason).toBe("Title generation failed");
    expect(data.skippedRows[0].row).toBe(1);
    expect(data.skippedRows[0].description).toBe("Fail this");
  });

  test("passes AbortSignal to generateTitle and handles abort as skipped row", async () => {
    const receivedSignals: AbortSignal[] = [];
    let callCount = 0;
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (_desc, signal) => {
        callCount++;
        if (signal) receivedSignals.push(signal);
        if (callCount === 1) {
          // Simulate abort error
          const err = new DOMException("The operation was aborted", "AbortError");
          throw err;
        }
        return "Second title";
      },
    });
    const projectId = db.createProject({ name: "abort-test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: projectId,
          rows: [{ description: "Will be aborted" }, { description: "Will succeed" }],
        }),
      },
      authToken,
    );

    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    // Both rows should have been processed
    expect(callCount).toBe(2);
    // AbortSignal should have been passed to each call
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals[0]).toBeInstanceOf(AbortSignal);
    // First row (aborted) should be skipped
    expect(data.skipped).toBe(1);
    expect(data.skippedRows[0].row).toBe(1);
    expect(data.skippedRows[0].reason).toBe("Title generation failed");
    // Second row should be imported
    expect(data.imported).toBe(1);
    expect(data.features[0].title).toBe("Second title");
  });

  test("rejects unauthenticated request with 401", async () => {
    const { db, port } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    const projectId = db.createProject({ name: "auth-test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, rows: [{ description: "test" }] }),
      },
      null,
    ); // no authToken
    expect(res.status).toBe(401);
  });

  test("rejects invalid auth token with 401", async () => {
    const { db, port } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    const projectId = db.createProject({ name: "auth-test2", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, rows: [{ description: "test" }] }),
      },
      "wrong-token",
    );
    expect(res.status).toBe(401);
  });

  test("returns 503 when generateTitle not configured", async () => {
    const { db, port, authToken } = await setup({ tempDirPrefix: "kanban-batch-test-" }); // no generateTitle
    const projectId = db.createProject({ name: "test4", repoPath: "/test4" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: projectId, rows: [{ description: "test" }] }),
      },
      authToken,
    );

    expect(res.status).toBe(503);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.error).toContain("active pi session");
  });

  test("returns 400 for invalid JSON body", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    db.createProject({ name: "json-test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{{",
      },
      authToken,
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.error).toContain("Invalid JSON");
  });

  test("returns 413 for body exceeding 10MB limit", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    db.createProject({ name: "big-test", repoPath: "/test" });

    // Build a JSON body just over 10MB
    const bigDesc = "x".repeat(11 * 1024 * 1024);
    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: 1, rows: [{ description: bigDesc }] }),
      },
      authToken,
    );

    expect(res.status).toBe(413);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.error).toContain("too large");
  });

  test("returns 400 for missing projectId", async () => {
    const { port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [{ description: "test" }] }),
      },
      authToken,
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.error).toContain("projectId must be a positive integer");
  });

  test("returns 400 for negative projectId", async () => {
    const { port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: -1, rows: [{ description: "test" }] }),
      },
      authToken,
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.error).toContain("projectId must be a positive integer");
  });

  test("returns 400 for non-array rows", async () => {
    const { port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: 1, rows: "not an array" }),
      },
      authToken,
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.error).toContain("rows must be an array");
  });

  test("succeeds with empty rows array", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    const projectId = db.createProject({ name: "empty-rows", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, rows: [] }),
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(0);
    expect(data.skipped).toBe(0);
    expect(data.features).toEqual([]);
    expect(data.skippedRows).toEqual([]);
  });

  test("skips non-object row entries", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    const projectId = db.createProject({ name: "non-obj", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [null, 42, "not an object", { description: "Valid" }],
        }),
      },
      authToken,
    );

    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(3);
    expect(data.skippedRows[0].row).toBe(1);
    expect(data.skippedRows[1].row).toBe(2);
    expect(data.skippedRows[2].row).toBe(3);
    expect(data.features[0].title).toBe("Title: Valid");
  });

  test("handles non-existent projectId — skips row due to DB error", async () => {
    const { port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: 99999, rows: [{ description: "orphan" }] }),
      },
      authToken,
    );

    // FK constraints are enforced — the row is skipped because projectId 99999 doesn't exist.
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(0);
    expect(data.skipped).toBe(1);
    expect(data.skippedRows[0].row).toBe(1);
    expect(data.skippedRows[0].reason).toBe("Database error");
  });

  test("deduplicates slugs on collision within batch", async () => {
    // All rows get the same title → same base slug → collision retry appends -1, -2, etc.
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (_desc) => "Same Title",
    });
    const projectId = db.createProject({ name: "collision-test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [{ description: "First item" }, { description: "Second item" }, { description: "Third item" }],
        }),
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(3);
    expect(data.skipped).toBe(0);
    // All features should have unique slugs
    const slugs = data.features.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(3);
    // First slug is the base, subsequent ones get -1, -2 suffix
    expect(slugs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-same-title$/);
    expect(slugs[1]).toMatch(/^\d{4}-\d{2}-\d{2}-same-title-1$/);
    expect(slugs[2]).toMatch(/^\d{4}-\d{2}-\d{2}-same-title-2$/);
  });

  test("deduplicates slugs on collision with pre-existing DB feature", async () => {
    // Pre-create a feature with a slug that matches what generateTitle will produce
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (_desc) => "Same Title",
    });
    const projectId = db.createProject({ name: "collision-test", repoPath: "/test" });

    // Insert a feature with the slug that the batch import would generate
    const today = new Date().toISOString().slice(0, 10);
    const existingSlug = `${today}-same-title`;
    db.createFeature({
      projectId,
      slug: existingSlug,
      title: "Same Title",
      description: "pre-existing feature",
      lane: "backlog",
    });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [{ description: "New item with same title" }],
        }),
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(0);
    // The imported feature should get a -1 suffix since the base slug already exists
    expect(data.features[0].slug).toBe(`${existingSlug}-1`);
  });

  test("skips rows with non-string description types (number, null, undefined)", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    const projectId = db.createProject({ name: "non-string-desc", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [
            { description: 123 },
            { description: null },
            { description: undefined },
            { description: true },
            { description: "Valid task" },
          ],
        }),
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(4);
    expect(data.features[0].title).toBe("Title: Valid task");
    // All non-string descriptions should be skipped with "Empty description" reason
    expect(data.skippedRows[0].row).toBe(1);
    expect(data.skippedRows[0].reason).toContain("Empty");
    expect(data.skippedRows[1].row).toBe(2);
    expect(data.skippedRows[1].reason).toContain("Empty");
    expect(data.skippedRows[2].row).toBe(3);
    expect(data.skippedRows[2].reason).toContain("Empty");
    expect(data.skippedRows[3].row).toBe(4);
    expect(data.skippedRows[3].reason).toContain("Empty");
  });

  test("truncates long descriptions before sending to generateTitle", async () => {
    let receivedDesc = "";
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => {
        receivedDesc = desc;
        return "Truncated Title";
      },
    });
    const projectId = db.createProject({ name: "truncate-test", repoPath: "/test" });

    // Create a description longer than 2000 chars
    const longDesc = "A".repeat(3000);

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [{ description: longDesc }],
        }),
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(1);
    // generateTitle should receive truncated description
    expect(receivedDesc.length).toBeLessThanOrEqual(2000);
    expect(receivedDesc).toBe("A".repeat(2000));
    // But the stored feature should have the full description
    const feature = db.getFeature(parseInt(data.features[0].id, 10));
    if (!feature) throw new Error("feature not found");
    expect(feature.description).toBe(longDesc);
  });

  test("skips row when slug collision exhausts all 10 retries", async () => {
    // generateTitle returns the same title for every description
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (_desc) => "Same Title",
    });
    const projectId = db.createProject({ name: "slug-exhaust", repoPath: "/test" });

    // Pre-create features occupying all possible slugs the retry loop would try:
    // base slug + slug-1 through slug-11 (attempt 0 tries base, attempts 1-10 try slug-N where N = attempt+1)
    const today = new Date().toISOString().slice(0, 10);
    const baseSlug = `${today}-same-title`;
    const slugsToBlock = [baseSlug];
    for (let i = 1; i <= 11; i++) {
      slugsToBlock.push(`${baseSlug}-${i}`);
    }
    // slugsToBlock has 12 entries: base, -1, -2, ..., -11
    // The retry loop tries: attempt 0 = base, attempt 1 = -1, ..., attempt 10 = -11
    // All 11 attempts (0..10) will fail with UNIQUE → exhausted
    for (const slug of slugsToBlock) {
      db.createFeature({
        projectId,
        slug,
        title: "Blocker",
        description: `pre-existing for ${slug}`,
        lane: "backlog",
      });
    }

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [{ description: "This should be skipped" }],
        }),
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(0);
    expect(data.skipped).toBe(1);
    expect(data.skippedRows[0].row).toBe(1);
    expect(data.skippedRows[0].reason).toContain("Slug collision after 10 retries");
  });

  test("does not leak internal error details in skip reasons", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (_desc) => {
        throw new Error("SQLITE_CONSTRAINT_UNIQUE: table.features(slug) Internal DB path: /secret/data/kanban.db");
      },
    });
    const projectId = db.createProject({ name: "sanitize-test", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [{ description: "Should not leak internals" }],
        }),
      },
      authToken,
    );

    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.skipped).toBe(1);
    const reason = data.skippedRows[0].reason;
    // Must NOT contain raw error internals
    expect(reason).not.toContain("SQLITE");
    expect(reason).not.toContain("/secret/");
    expect(reason).not.toContain("kanban.db");
    // Should be a generic message
    expect(reason).toBe("Title generation failed");
  });

  test("sends full description in skipped rows (not truncated)", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (_desc) => {
        throw new Error("fail");
      },
    });
    const projectId = db.createProject({ name: "full-desc-test", repoPath: "/test" });

    // Create a description longer than 100 chars
    const longDesc = "A".repeat(500);

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [{ description: longDesc }],
        }),
      },
      authToken,
    );

    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.skipped).toBe(1);
    // Full description should be preserved, not truncated to 100 chars
    expect(data.skippedRows[0].description).toBe(longDesc);
    expect(data.skippedRows[0].description).toHaveLength(500);
  });

  test("handles batch where all rows are skipped", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (_desc) => {
        throw new Error("always fail");
      },
    });
    const projectId = db.createProject({ name: "all-skipped", repoPath: "/test" });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          rows: [{ description: "First" }, { description: "Second" }, { description: "Third" }],
        }),
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.imported).toBe(0);
    expect(data.skipped).toBe(3);
    expect(data.features).toEqual([]);
    expect(data.skippedRows).toHaveLength(3);
    expect(data.skippedRows[0]).toEqual({ row: 1, description: "First", reason: "Title generation failed" });
    expect(data.skippedRows[1]).toEqual({ row: 2, description: "Second", reason: "Title generation failed" });
    expect(data.skippedRows[2]).toEqual({ row: 3, description: "Third", reason: "Title generation failed" });
  });

  test("returns 413 when row count exceeds MAX_BATCH_ROWS", async () => {
    const { db, port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });
    const projectId = db.createProject({ name: "row-limit-test", repoPath: "/test" });

    // Create 501 minimal rows to exceed the 500 limit
    const rows = Array.from({ length: 501 }, (_, i) => ({ description: `Row ${i}` }));
    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, rows }),
      },
      authToken,
    );

    expect(res.status).toBe(413);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.error).toMatch(/Too many rows.*max 500/);
  });

  test("rejects projectId: 0 with 400", async () => {
    const { port, authToken } = await setup({
      tempDirPrefix: "kanban-batch-test-",
      generateTitle: async (desc) => `Title: ${desc}`,
    });

    const res = await fetchPort(
      port,
      "/api/features/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: 0,
          rows: [{ description: "test" }],
        }),
      },
      authToken,
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as {
      imported: number;
      skipped: number;
      skippedRows: Array<{ row: number; description: string; reason: string }>;
      features: Array<{ slug: string; title: string; description: string; lane: string; id: string }>;
      error?: string;
    };
    expect(data.error).toContain("projectId must be a positive integer");
  });
});

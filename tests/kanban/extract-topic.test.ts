// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { extractTopicFromTask } from "../../src/kanban/kanban-generate-topic.js";

describe("extractTopicFromTask", () => {
  // ── Edge cases ──────────────────────────────────────────────────
  test("returns 'unknown' for empty string", () => {
    expect(extractTopicFromTask("")).toBe("unknown");
  });

  test("returns 'unknown' for null input", () => {
    expect(extractTopicFromTask(null)).toBe("unknown");
  });

  test("returns 'unknown' for undefined input", () => {
    expect(extractTopicFromTask(undefined)).toBe("unknown");
  });

  test("returns dash-only for whitespace-only string", () => {
    // "   ".split(/\s+/) → ["", ""] → join("-") → "-" → replace → "-" (truthy)
    expect(extractTopicFromTask("   ")).toBe("-");
  });

  // ── Pattern 1: refactor/refactoring ──────────────────────────────
  test("matches 'refactor' keyword", () => {
    expect(extractTopicFromTask("Refactor the authentication module")).toBe("refactoring");
  });

  test("matches 'refactoring' keyword", () => {
    expect(extractTopicFromTask("Complete refactoring of the data layer")).toBe("refactoring");
  });

  // ── Pattern 2: performance/perf ──────────────────────────────────
  test("matches 'performance' keyword", () => {
    expect(extractTopicFromTask("Improve performance of the query engine")).toBe("performance");
  });

  test("matches 'perf' keyword", () => {
    expect(extractTopicFromTask("Run perf analysis on hot path")).toBe("performance");
  });

  // ── Pattern 3: security/sec ─────────────────────────────────────
  test("matches 'security' keyword", () => {
    expect(extractTopicFromTask("Fix security vulnerability in auth")).toBe("security");
  });

  test("matches 'sec' keyword", () => {
    expect(extractTopicFromTask("Review sec headers on API responses")).toBe("security");
  });

  // ── Pattern 4: test/testing ──────────────────────────────────────
  test("matches 'test' keyword", () => {
    expect(extractTopicFromTask("Add test coverage for parser")).toBe("testing");
  });

  test("matches 'testing' keyword", () => {
    expect(extractTopicFromTask("Set up testing infrastructure")).toBe("testing");
  });

  // ── Pattern 5: type/typing ──────────────────────────────────────
  test("matches 'type' keyword", () => {
    expect(extractTopicFromTask("Add type annotations to public API")).toBe("typing");
  });

  test("matches 'typing' keyword", () => {
    expect(extractTopicFromTask("Improve typing for the config module")).toBe("typing");
  });

  test("'types' does NOT match typ(e|ing) pattern — falls through", () => {
    // /\b(typ(e|ing))\b/ matches 'type' and 'typing' but NOT 'types'
    // Falls to fallback with first 4 words
    const result = extractTopicFromTask("Export types for internal usage");
    expect(result).toBe("export-types-for-internal");
  });

  // ── Pattern 6: lint/linting ─────────────────────────────────────
  test("matches 'lint' keyword", () => {
    expect(extractTopicFromTask("Fix lint errors in utils")).toBe("linting");
  });

  test("matches 'linting' keyword", () => {
    expect(extractTopicFromTask("Configure linting rules for the project")).toBe("linting");
  });

  // ── Pattern 7: style/styling/format ─────────────────────────────
  test("matches 'style' keyword", () => {
    expect(extractTopicFromTask("Fix style inconsistencies in CSS")).toBe("styling");
  });

  test("matches 'styling' keyword", () => {
    expect(extractTopicFromTask("Update styling for the modal component")).toBe("styling");
  });

  test("matches 'format' keyword", () => {
    expect(extractTopicFromTask("Run format on all source files")).toBe("styling");
  });

  // ── Pattern 8: docs/documentation ───────────────────────────────
  test("matches 'docs' keyword", () => {
    expect(extractTopicFromTask("Update docs for the new API")).toBe("documentation");
  });

  test("matches 'documentation' keyword", () => {
    expect(extractTopicFromTask("Write documentation for the settings module")).toBe("documentation");
  });

  // ── Pattern 9: config/configuration/settings ────────────────────
  test("matches 'config' keyword", () => {
    expect(extractTopicFromTask("Update config defaults for production")).toBe("configuration");
  });

  test("matches 'configuration' keyword", () => {
    expect(extractTopicFromTask("Simplify configuration management")).toBe("configuration");
  });

  test("matches 'settings' keyword", () => {
    expect(extractTopicFromTask("Add settings modal for user preferences")).toBe("configuration");
  });

  // ── Pattern 10: api/endpoint ────────────────────────────────────
  test("matches 'api' keyword", () => {
    expect(extractTopicFromTask("Design API for the payment module")).toBe("api");
  });

  test("matches 'endpoint' keyword", () => {
    expect(extractTopicFromTask("Add new endpoint for user registration")).toBe("api");
  });

  // ── Pattern 11: ui/interface/component ──────────────────────────
  test("matches 'ui' keyword", () => {
    expect(extractTopicFromTask("Redesign UI for the dashboard")).toBe("ui");
  });

  test("matches 'interface' keyword", () => {
    expect(extractTopicFromTask("Define interface for the repository pattern")).toBe("ui");
  });

  test("matches 'component' keyword", () => {
    expect(extractTopicFromTask("Create reusable component for data tables")).toBe("ui");
  });

  // ── Pattern 12: workflow ────────────────────────────────────────
  test("matches 'workflow' keyword", () => {
    expect(extractTopicFromTask("Optimize workflow for code review")).toBe("workflow");
  });

  // ── Pattern 13: kanban/board/feature ────────────────────────────
  test("matches 'kanban' keyword", () => {
    expect(extractTopicFromTask("Fix kanban board lane transition")).toBe("kanban");
  });

  test("matches 'board' keyword", () => {
    expect(extractTopicFromTask("Update board columns for sprint planning")).toBe("kanban");
  });

  test("matches 'feature' keyword", () => {
    expect(extractTopicFromTask("Implement feature flag system")).toBe("kanban");
  });

  // ── Pattern 14: build/compile/bundle ────────────────────────────
  test("matches 'build' keyword", () => {
    expect(extractTopicFromTask("Fix build pipeline for production")).toBe("build");
  });

  test("matches 'compile' keyword", () => {
    expect(extractTopicFromTask("Speed up compile times for TypeScript")).toBe("build");
  });

  test("matches 'bundle' keyword", () => {
    expect(extractTopicFromTask("Reduce bundle size by tree-shaking")).toBe("build");
  });

  // ── Pattern 15: deps/dependencies/package ───────────────────────
  test("matches 'deps' keyword", () => {
    expect(extractTopicFromTask("Update deps to latest versions")).toBe("dependencies");
  });

  test("matches 'dependencies' keyword", () => {
    expect(extractTopicFromTask("Audit dependencies for vulnerabilities")).toBe("dependencies");
  });

  test("matches 'package' keyword", () => {
    expect(extractTopicFromTask("Configure package.json exports")).toBe("dependencies");
  });

  // ── Pattern 16: migrate/migration ───────────────────────────────
  test("matches 'migrate' keyword", () => {
    expect(extractTopicFromTask("Migrate database to new schema")).toBe("migration");
  });

  test("matches 'migration' keyword", () => {
    expect(extractTopicFromTask("Complete migration from REST to GraphQL")).toBe("migration");
  });

  // ── Pattern 17: ci/cd/deploy/deployment ─────────────────────────
  test("matches 'ci' keyword", () => {
    expect(extractTopicFromTask("Fix CI pipeline flaky tests")).toBe("deployment");
  });

  test("matches 'cd' keyword", () => {
    expect(extractTopicFromTask("Set up CD pipeline for staging")).toBe("deployment");
  });

  test("matches 'deploy' keyword", () => {
    expect(extractTopicFromTask("Deploy hotfix to production")).toBe("deployment");
  });

  test("matches 'deployment' keyword", () => {
    expect(extractTopicFromTask("Automate deployment with blue-green strategy")).toBe("deployment");
  });

  // ── Pattern 18: design ──────────────────────────────────────────
  test("matches 'design' keyword", () => {
    expect(extractTopicFromTask("Review design document for auth system")).toBe("design");
  });

  // ── Pattern 19: plan ────────────────────────────────────────────
  test("matches 'plan' keyword", () => {
    expect(extractTopicFromTask("Create plan for the next sprint")).toBe("planning");
  });

  // ── Pattern 20: review ──────────────────────────────────────────
  test("matches 'review' keyword", () => {
    expect(extractTopicFromTask("Conduct review of the PR changes")).toBe("review");
  });

  // ── Pattern 21: fix/bug/issue ───────────────────────────────────
  test("matches 'fix' keyword", () => {
    expect(extractTopicFromTask("Fix race condition in async handler")).toBe("bugfix");
  });

  test("matches 'bug' keyword", () => {
    expect(extractTopicFromTask("Investigate bug in payment processing")).toBe("bugfix");
  });

  test("matches 'issue' keyword", () => {
    expect(extractTopicFromTask("Resolve issue with memory leak")).toBe("bugfix");
  });

  // ── Pattern 22: add/new/feature ─────────────────────────────────
  test("matches 'add' keyword", () => {
    expect(extractTopicFromTask("Add logging middleware")).toBe("feature");
  });

  test("matches 'new' keyword", () => {
    expect(extractTopicFromTask("Create new service for notifications")).toBe("feature");
  });

  // ── Pattern 23: remove/delete/clean ─────────────────────────────
  test("matches 'remove' keyword", () => {
    // 'remove' matches pattern 23, but only when no earlier pattern matches
    expect(extractTopicFromTask("Remove unused imports from module")).toBe("cleanup");
  });

  test("matches 'delete' keyword", () => {
    expect(extractTopicFromTask("Delete unused asset files")).toBe("cleanup");
  });

  test("matches 'clean' keyword", () => {
    // 'build' would match pattern 14 first, so use a task without earlier keywords
    expect(extractTopicFromTask("Clean up stale session data")).toBe("cleanup");
  });

  // ── Pattern 24: update/change/modify ────────────────────────────
  test("matches 'update' keyword", () => {
    // 'dependencies' would match pattern 15 first, so use a task without earlier keywords
    expect(extractTopicFromTask("Update the welcome message text")).toBe("update");
  });

  test("matches 'change' keyword", () => {
    expect(extractTopicFromTask("Change default timeout value")).toBe("update");
  });

  test("matches 'modify' keyword", () => {
    expect(extractTopicFromTask("Modify the caching strategy")).toBe("update");
  });

  // ── First-match-wins priority ───────────────────────────────────
  test("first-match-wins: 'refactor' beats 'test' even if both present", () => {
    expect(extractTopicFromTask("Refactor test utilities")).toBe("refactoring");
  });

  test("first-match-wins: 'performance' beats 'fix'", () => {
    expect(extractTopicFromTask("Fix performance regression in queries")).toBe("performance");
  });

  test("first-match-wins: 'security' beats 'update'", () => {
    expect(extractTopicFromTask("Update security headers configuration")).toBe("security");
  });

  test("first-match-wins: 'test' beats 'add'", () => {
    expect(extractTopicFromTask("Add test for the new feature")).toBe("testing");
  });

  test("first-match-wins: 'lint' beats 'fix'", () => {
    expect(extractTopicFromTask("Fix lint warnings in the codebase")).toBe("linting");
  });

  test("first-match-wins: 'docs' beats 'update'", () => {
    expect(extractTopicFromTask("Update docs for the API changes")).toBe("documentation");
  });

  test("first-match-wins: 'build' beats 'update'", () => {
    // 'configuration' matches pattern 9 before 'build' at pattern 14
    // So use a task where 'build' is the first match
    expect(extractTopicFromTask("Update build scripts for the project")).toBe("build");
  });

  test("first-match-wins: 'migrate' beats 'review'", () => {
    expect(extractTopicFromTask("Review migration plan for database")).toBe("migration");
  });

  test("first-match-wins: 'design' beats 'review'", () => {
    expect(extractTopicFromTask("Review design document for the system")).toBe("design");
  });

  test("first-match-wins: 'review' beats 'fix'", () => {
    expect(extractTopicFromTask("Fix issues found during review")).toBe("review");
  });

  test("first-match-wins: 'fix' beats 'add'", () => {
    expect(extractTopicFromTask("Add fix for the broken import")).toBe("bugfix");
  });

  test("first-match-wins: 'add' beats 'remove'", () => {
    expect(extractTopicFromTask("Remove old code and add new implementation")).toBe("feature");
  });

  test("first-match-wins: 'remove' beats 'update'", () => {
    expect(extractTopicFromTask("Update code to remove deprecated function")).toBe("cleanup");
  });

  // ── Fallback: no keyword matches ────────────────────────────────
  test("fallback: extracts first 4 words as kebab-case", () => {
    expect(extractTopicFromTask("Implement user session handling with tokens")).toBe("implement-user-session-handling");
  });

  test("fallback: strips non-alphanumeric characters", () => {
    expect(extractTopicFromTask("Handle `process.exit()` gracefully")).toBe("handle-processexit-gracefully");
  });

  test("fallback: truncates to 50 characters", () => {
    const longTask = "investigate why the system behaves unexpectedly under high concurrency loads with many threads";
    const result = extractTopicFromTask(longTask);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  test("fallback: produces dashes when words are only special chars", () => {
    // After replace(/[^a-z0-9-]/g, ""), only dashes remain from hyphens between words
    expect(extractTopicFromTask("@#$ %^& *() !@#")).toBe("---");
  });

  // ── Case insensitivity ──────────────────────────────────────────
  test("matches keywords case-insensitively", () => {
    expect(extractTopicFromTask("REFACTOR the module")).toBe("refactoring");
    expect(extractTopicFromTask("PERFORMANCE optimization")).toBe("performance");
    expect(extractTopicFromTask("SECURITY audit")).toBe("security");
  });

  test("matches keywords embedded in larger text", () => {
    expect(extractTopicFromTask("Please refactor this code as part of the cleanup effort")).toBe("refactoring");
  });
});

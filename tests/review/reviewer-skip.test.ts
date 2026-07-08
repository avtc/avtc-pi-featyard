// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// Import the tracking functions from workflow-monitor's internal test exports
import workflowMonitorExtension, {
  _getEmptyLoopsForSlug,
  _incrementEmptyLoop,
  _isReviewerSkipped,
  _resetAllEmptyLoops,
  _resetEmptyLoop,
} from "../../src/index.js";
import { cleanupAfterTest, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    api: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      events: {
        on() {
          return () => {};
        },
      },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
    },
  };
}

describe("reviewerEmptyLoops tracking", () => {
  beforeEach(() => {
    // Run inside a temp dir so production init's ensureFfJunction(process.cwd()) never touches
    // the real repo's .ff.
    withTempCwd();
    // Initialize the extension to wire up refs
    workflowMonitorExtension(createFakePi().api as unknown as ExtensionAPI);
    _resetAllEmptyLoops();
  });

  afterEach(() => {
    cleanupAfterTest();
  });

  test("starts with empty counts", () => {
    expect(_getEmptyLoopsForSlug("feature-1")).toEqual({});
  });

  test("increments empty loop count per reviewer", () => {
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    expect(_getEmptyLoopsForSlug("feature-1")).toEqual({ "ff-quality-reviewer": 1 });
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    expect(_getEmptyLoopsForSlug("feature-1")).toEqual({ "ff-quality-reviewer": 2 });
  });

  test("tracks different reviewers independently", () => {
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    _incrementEmptyLoop("feature-1", "ff-security-reviewer");
    expect(_getEmptyLoopsForSlug("feature-1")).toEqual({ "ff-quality-reviewer": 1, "ff-security-reviewer": 1 });
  });

  test("tracks different features independently", () => {
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    _incrementEmptyLoop("feature-2", "ff-quality-reviewer");
    expect(_getEmptyLoopsForSlug("feature-1")).toEqual({ "ff-quality-reviewer": 1 });
    expect(_getEmptyLoopsForSlug("feature-2")).toEqual({ "ff-quality-reviewer": 1 });
  });

  test("resets empty loop count for specific reviewer", () => {
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    _resetEmptyLoop("feature-1", "ff-quality-reviewer");
    expect(_getEmptyLoopsForSlug("feature-1")).toEqual({});
  });

  test("resetAllEmptyLoops clears everything", () => {
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    _incrementEmptyLoop("feature-2", "ff-security-reviewer");
    _resetAllEmptyLoops();
    expect(_getEmptyLoopsForSlug("feature-1")).toEqual({});
    expect(_getEmptyLoopsForSlug("feature-2")).toEqual({});
  });

  test("isReviewerSkipped returns false when below threshold", () => {
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    expect(_isReviewerSkipped("feature-1", "ff-quality-reviewer", 2)).toBe(false);
  });

  test("isReviewerSkipped returns true when at threshold", () => {
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    expect(_isReviewerSkipped("feature-1", "ff-quality-reviewer", 2)).toBe(true);
  });

  test("isReviewerSkipped returns false when threshold is 0 (disabled)", () => {
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    expect(_isReviewerSkipped("feature-1", "ff-quality-reviewer", 0)).toBe(false);
  });

  test("isReviewerSkipped with threshold 1: skips after single empty loop", () => {
    _incrementEmptyLoop("feature-1", "ff-quality-reviewer");
    expect(_isReviewerSkipped("feature-1", "ff-quality-reviewer", 1)).toBe(true);
    expect(_isReviewerSkipped("feature-1", "ff-quality-reviewer", 2)).toBe(false);
  });
});

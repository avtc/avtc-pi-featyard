// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import { createFakePi, getSingleHandler, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

describe("subagent isolation", () => {
  test("reviewer agents do not declare extensions in frontmatter (no recursive substitution)", async () => {
    // Subagents only load extensions from their agent frontmatter's `extensions` field.
    // Neither design-reviewer nor plan-reviewer should specify extensions,
    // so workflow-monitor is never loaded in subagent sessions.
    for (const agentFile of ["fy-design-reviewer.md", "fy-plan-reviewer.md"]) {
      const agentPath = path.resolve(__dirname, "../../agents", agentFile);
      // Assert file exists — test must fail if agent file is missing
      expect(fs.existsSync(agentPath)).toBe(true);
      const content = fs.readFileSync(agentPath, "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).toBeDefined();
      const frontmatter = fmMatch?.[1];
      // Should NOT contain `extensions:` field
      expect(frontmatter).not.toContain("extensions:");
    }
  });
});

describe("tool_result template substitution scope", () => {
  beforeEach(async () => {
    withTempCwd();
    setSetting("planReviewMode", "in-session");
    setSetting("maxPlanReviewRounds", 3);
  });

  test("does NOT substitute placeholders in non-skill/non-agent file reads", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const event = {
      type: "tool_result",
      toolCallId: "tc-scope-test",
      toolName: "read",
      input: { path: "/project/src/prompts/template-engine.ts" },
      content: [
        {
          type: "text" as const,
          text: "The placeholder is {{PI_FY_FEATURE_SLUG}} and should NOT be substituted.",
        },
      ],
      details: {},
    };

    await onToolResult(
      event as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // Verify the original content was NOT modified — placeholder should remain
    expect((event as { content: Array<{ text: string }> }).content[0].text).toContain("{{PI_FY_FEATURE_SLUG}}");
  });
});

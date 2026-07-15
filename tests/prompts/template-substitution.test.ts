// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import { createFakePi, getSingleHandler, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

describe("context event template substitution", () => {
  beforeEach(async () => {
    withTempCwd();
    setSetting("planReviewMode", "in-session");
    setSetting("maxPlanReviewRounds", 3);
  });

  test("does not modify assistant messages", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "I see {{PI_FY_FEATURE_SLUG}} in my context" },
      { role: "user", content: "Thanks" },
    ];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // No substitution in assistant messages — result should be undefined (no modifications)
    expect(result).toBeUndefined();
    // Verify assistant message content was NOT modified
    expect(messages[1].content).toBe("I see {{PI_FY_FEATURE_SLUG}} in my context");
  });

  test("is no-op when no placeholders present", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [
      { role: "user", content: "Hello, no placeholders here." },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "Thanks, still no placeholders." },
    ];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(result).toBeUndefined();
  });

  test("does NOT substitute placeholders outside <skill> blocks", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [
      // Placeholder in plain text (not inside <skill> block) — should NOT be substituted
      { role: "user", content: "I saw {{PI_FY_FEATURE_SLUG}} in a doc" },
    ];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // No modification returned (nothing changed) ...
    expect(result).toBeUndefined();
    // ... AND the placeholder text must survive untouched in the message.
    expect(messages[0].content).toContain("{{PI_FY_FEATURE_SLUG}}");
  });

  test("scans ALL user messages including before assistant messages", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [
      { role: "user", content: '# Old message with <skill name="test">{{PI_FY_FEATURE_SLUG}}</skill>' },
      { role: "assistant", content: "I responded" },
      { role: "user", content: "New message, no placeholder" },
    ];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // The first user message has a placeholder inside a <skill> block and IS substituted
    // (we scan all messages, not just after last assistant).
    expect(result as unknown).toBeDefined();
    expect((result as { messages: unknown[] }).messages).toBeDefined();
    expect((result as { messages: [{ content: string }] }).messages[0].content).not.toContain("{{PI_FY_FEATURE_SLUG}}");
  });

  test("handles non-string message content without errors", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [
      { role: "user", content: [{ type: "image", data: "base64..." }] },
      { role: "assistant", content: "Got it" },
      { role: "user", content: [{ type: "text", text: '<skill name="test">{{PI_FY_FEATURE_SLUG}}</skill>' }] },
    ];

    // Should not throw — non-string content is skipped
    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // Array content with text parts should be substituted
    expect(result as unknown).toBeDefined();
    expect((result as { messages: unknown[] }).messages).toBeDefined();
    // The image content should be unchanged
    expect((result as { messages: Array<{ content: Array<{ type: string }> }> }).messages[0].content[0].type).toBe(
      "image",
    );
    // The text part should have the placeholder substituted (no longer raw)
    expect(
      (result as { messages: Array<{ content: Array<{ text: string }> }> }).messages[2].content[0].text,
    ).not.toContain("{{PI_FY_FEATURE_SLUG}}");
  });

  test("substitutes multiple occurrences of the same placeholder (replaceAll)", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [
      {
        role: "user",
        content: '<skill name="test">Before {{PI_FY_FEATURE_SLUG}} middle {{PI_FY_FEATURE_SLUG}} after</skill>',
      },
    ];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(result as unknown).toBeDefined();
    // BOTH occurrences must be substituted — this verifies replaceAll, not replace
    expect((result as { messages: [{ content: string }] }).messages[0].content).not.toContain("{{PI_FY_FEATURE_SLUG}}");
    // The replacement text should appear twice (once for each occurrence)
    const content = (result as { messages: [{ content: string }] }).messages[0].content as string;
    const matchCount = (content.match(/YYYY-MM-DD-<topic>/g) || []).length;
    expect(matchCount).toBeGreaterThanOrEqual(2);
  });

  test("substitutes inside each of multiple <skill> blocks in one message", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [
      {
        role: "user",
        content:
          '<skill name="a">A: {{PI_FY_FEATURE_SLUG}}</skill>' +
          " plain text between blocks " +
          '<skill name="b">B: {{PI_FY_FEATURE_SLUG}}</skill>',
      },
    ];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(result as unknown).toBeDefined();
    const content = (result as { messages: [{ content: string }] }).messages[0].content as string;
    // BOTH blocks are substituted (no raw placeholders remain) ...
    expect(content).not.toContain("{{PI_FY_FEATURE_SLUG}}");
    // ... the intervening plain text is preserved ...
    expect(content).toContain("plain text between blocks");
    // ... and each block got its own substitution (two resolved copies).
    const matchCount = (content.match(/YYYY-MM-DD-<topic>/g) || []).length;
    expect(matchCount).toBeGreaterThanOrEqual(2);
  });

  test("substitutes a placeholder inside a <skill> block but leaves a sibling outside it untouched", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [
      {
        role: "user",
        content:
          '<skill name="test">inside {{PI_FY_FEATURE_SLUG}} inside</skill> outside {{PI_FY_FEATURE_SLUG}} outside',
      },
    ];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(result as unknown).toBeDefined();
    const content = (result as { messages: [{ content: string }] }).messages[0].content as string;
    // The inside placeholder is resolved ...
    expect(content).toContain("YYYY-MM-DD-<topic>");
    // ... while exactly one raw placeholder survives (the outside one).
    const rawCount = (content.match(/\{\{PI_FY_FEATURE_SLUG\}\}/g) || []).length;
    expect(rawCount).toBe(1);
    expect(content).toContain("outside {{PI_FY_FEATURE_SLUG}} outside");
  });

  test("leaves an unknown placeholder inside a <skill> block unchanged", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [
      {
        role: "user",
        content: '<skill name="test">known {{PI_FY_FEATURE_SLUG}} unknown {{PI_FY_NONEXISTENT_XYZ}}</skill>',
      },
    ];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // The known placeholder IS resolved, but the unknown one survives untouched.
    expect(result as unknown).toBeDefined();
    const content = (result as { messages: [{ content: string }] }).messages[0].content as string;
    expect(content).not.toContain("{{PI_FY_FEATURE_SLUG}}");
    expect(content).toContain("{{PI_FY_NONEXISTENT_XYZ}}");
  });

  test("returns undefined for empty messages array", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages: { role: string; content: string | unknown[] }[] = [];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(result).toBeUndefined();
  });

  test("substitutes {{PI_FY_FEATURE_SLUG}} in pi 0.73 skill block format (array content)", async () => {
    // This test simulates the message format pi 0.73 produces when a user
    // types /skill:code-reviewer and presses Enter:
    // 1. pi core's _expandSkillCommand reads the skill file, strips frontmatter,
    //    produces <skill name="code-reviewer" ...>{{PI_FY_FEATURE_SLUG}}...</skill>
    // 2. prompt() creates message with content: [{type:"text", text: expandedText}]
    // 3. transformContext (our context handler) must substitute {{PI_FY_*}} placeholders
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    const onContext = getSingleHandler(fake.handlers, "context");

    const skillBody = "# Code Review\n\nSome intro text...\n\n{{PI_FY_FEATURE_SLUG}}\n\n## After";
    const expandedText = `<skill name="code-reviewer" location="/path/to/skills/code-reviewer/SKILL.md">\nReferences are relative to /path/to/skills/code-reviewer.\n\n${skillBody}\n</skill>`;

    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: expandedText }],
      },
    ];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(result as unknown).toBeDefined();
    expect((result as { messages: unknown[] }).messages).toBeDefined();
    const substitutedText = (result as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0].content[0]
      .text;
    expect(substitutedText).not.toContain("{{PI_FY_FEATURE_SLUG}}");
    expect(substitutedText).toContain("YYYY-MM-DD-<topic>");
  });

  test("leaves unknown PI_FY_ placeholders unchanged", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const onContext = getSingleHandler(fake.handlers, "context");

    const messages = [{ role: "user", content: "Some text {{PI_FY_UNKNOWN_FUTURE}} more text" }];

    const result = await onContext(
      { messages: messages as AgentMessage[] } as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    // Unknown placeholder should remain — substituteTemplates doesn't match it
    expect(result).toBeUndefined();
    expect(messages[0].content).toContain("{{PI_FY_UNKNOWN_FUTURE}}");
  });
});

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

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, test } from "vitest";
import { _resetFeatureState, expandSkillCommand, stripFrontmatter } from "../../src/index.js";
import { initGitDir } from "../helpers/git-template.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import { withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

describe("expandSkillCommand", () => {
  beforeEach(() => {
    setTestSettings(null);
    withTempCwd();
    initGitDir(process.cwd());
    _resetFeatureState();
  });

  test("expands /skill:fy-implement with no args into <skill> XML block", () => {
    const result = expandSkillCommand("/skill:fy-implement", null, null);
    expect(result).toMatch(/^<skill name="fy-implement" location="[^"]+">/);
    expect(result).toContain("</skill>");
    // Should NOT contain YAML frontmatter block at start
    expect(result).not.toMatch(/^---\n[\s\S]*?\n---/);
    // Should contain specific skill body content (not just the skill name)
    expect(result).toContain("# Executing the Task-Plan");
  });

  test("expands /skill:fy-implement with args — appends args after block", () => {
    const result = expandSkillCommand("/skill:fy-implement docs/plans/my-plan.md", null, null);
    expect(result).toMatch(/^<skill name="fy-implement" location="[^"]+">/);
    expect(result).toContain("</skill>");
    // Args should appear after the closing tag, separated by double newline
    expect(result).toContain("</skill>\n\ndocs/plans/my-plan.md");
  });

  test("substitutes {{PI_FY_*}} template placeholders in skill body", () => {
    const result = expandSkillCommand("/skill:fy-implement", null, null);
    // After substitution, no raw placeholders should remain
    expect(result).not.toContain("{{PI_FY_");
    // Verify the skill body contains the per-task cycle structure
    expect(result).toContain("**Implement**");
    expect(result).toContain("**Gate + advance**");
  });

  test("returns original text for unknown skill", () => {
    const result = expandSkillCommand("/skill:nonexistent-skill-xyz", null, null);
    expect(result).toBe("/skill:nonexistent-skill-xyz");
  });

  test("returns original text for non-skill text", () => {
    expect(expandSkillCommand("hello world", null, null)).toBe("hello world");
    expect(expandSkillCommand("/not-a-skill", null, null)).toBe("/not-a-skill");
  });

  test("handles /skill: with no name", () => {
    expect(expandSkillCommand("/skill:", null, null)).toBe("/skill:");
  });

  test("rejects path traversal in skill name", () => {
    expect(expandSkillCommand("/skill:../extensions/workflow-monitor", null, null)).toBe(
      "/skill:../extensions/workflow-monitor",
    );
    expect(expandSkillCommand("/skill:../../etc/passwd", null, null)).toBe("/skill:../../etc/passwd");
    expect(expandSkillCommand("/skill:foo/bar", null, null)).toBe("/skill:foo/bar");
    expect(expandSkillCommand("/skill:foo\\bar", null, null)).toBe("/skill:foo\\bar");
  });

  test("returns original text for uppercase skill names (regex only matches [a-z0-9-])", () => {
    // The skill name regex /^[a-z0-9-]+/ rejects uppercase — expansion silently fails
    // and returns original text. All current skills are lowercase, but this guards
    // against future mixed-case skill names.
    expect(expandSkillCommand("/skill:My-Skill", null, null)).toBe("/skill:My-Skill");
    expect(expandSkillCommand("/skill:BRAINSTORMING", null, null)).toBe("/skill:BRAINSTORMING");
  });

  test("returns original text for passthrough cases (non-skill, unknown skill)", () => {
    // NOTE: The catch block in expandSkillCommand (readFileSync failure) cannot be
    // directly tested because vitest ESM module isolation prevents vi.spyOn from
    // intercepting node:fs calls made from another module's import namespace.
    // The catch block is structurally identical to the resolveSkillPath=null path
    // (both return original text). Full coverage would require integration testing
    // with corrupted skill file permissions.
    expect(expandSkillCommand("regular text", null, null)).toBe("regular text");
    expect(expandSkillCommand("/skill:nonexistent-xyz", null, null)).toBe("/skill:nonexistent-xyz");
  });

  test("handles multi-line args separated by newline", () => {
    const result = expandSkillCommand(
      "/skill:fy-implement\nContext was reset. Continue from where you left off.",
      null,
      null,
    );
    expect(result).toMatch(/^<skill name="fy-implement"/);
    expect(result).toContain("</skill>");
    // Args after newline should appear after the closing tag with double-newline separator
    expect(result).toContain("</skill>\n\nContext was reset. Continue from where you left off.");
  });

  test("handles whitespace-only args as no-args", () => {
    const result = expandSkillCommand("/skill:fy-implement   ", null, null);
    expect(result).toMatch(/^<skill name="fy-implement"/);
    expect(result).toContain("</skill>");
    // Should NOT contain trailing whitespace after closing tag
    expect(result).not.toMatch(/<\/skill>\s+$/);
  });

  test("returns empty string for empty input", () => {
    expect(expandSkillCommand("", null, null)).toBe("");
  });
});

// fy-implement SKILL.md was rewritten (dispatch model): task_ready_advance is the
// sole advance mechanism, the per-task gate cycle is implement → gate+advance, and
// cannot-fix is escalated via the dispatched fy-task-gate (not inline in Step 2).
describe("fy-implement dispatch-model skill", () => {
  beforeEach(() => {
    withTempCwd();
    initGitDir(process.cwd());
    _resetFeatureState();
  });

  test("Step 1 decomposition mandates a task_ready_advance sub-item per task", () => {
    const result = expandSkillCommand("/skill:fy-implement", null, null);
    expect(result).toContain("todo_add");
    expect(result).toContain("call `task_ready_advance`");
  });

  test("Step 2 starts the first task via task_ready_advance and uses the Gate + advance header", () => {
    const result = expandSkillCommand("/skill:fy-implement", null, null);
    expect(result).toContain("Start the first task: `task_ready_advance(nextTask:");
    expect(result).toContain("**Gate + advance**");
    // fy-implement dispatches via task_ready_advance; advance_to_task_gated is not referenced.
    expect(result).not.toContain("advance_to_task_gated");
    // fy-implement contains no injected gate markers.
    expect(result).not.toContain("{{PI_FY_VERIFY_PHASES:implement}}");
    expect(result).not.toContain("{{PI_FY_PER_TASK_CODE_REVIEW}}");
  });

  test("Step 3 advances to verify via the last task_ready_advance call (no phase_ready)", () => {
    const result = expandSkillCommand("/skill:fy-implement", null, null);
    expect(result).toContain("After the last task's `task_ready_advance` call");
    expect(result).not.toMatch(/call `phase_ready`/);
  });

  test("orchestrator (subagent) IMPLEMENT_MODE block has no duplicate opening line", () => {
    setSetting("implementMode", "subagent-driven");
    const result = expandSkillCommand("/skill:fy-implement", null, null);
    // The orchestrator block opens with the ⚠️ role line (no duplicate opening line).
    expect(result).not.toContain("**You are the orchestrator. You do NOT write code.**");
    expect(result).toContain("⚠️ Never write code yourself — you are the orchestrator.");
  });
});

// stripFrontmatter is imported from @earendil-works/pi-coding-agent (pi core).
// These are contract tests verifying the re-export works correctly for critical cases.
// Full edge-case coverage belongs in pi-core's own test suite.
describe("stripFrontmatter (pi-core contract)", () => {
  test("strips valid YAML frontmatter", () => {
    const input = "---\nname: my-skill\ndescription: test\n---\nBody content here";
    expect(stripFrontmatter(input)).toBe("Body content here");
  });

  test("returns content unchanged when no frontmatter", () => {
    const input = "Just regular content\nNo frontmatter here";
    expect(stripFrontmatter(input)).toBe(input);
  });

  test("handles CRLF line endings", () => {
    const input = "---\r\nname: test\r\n---\r\nBody content";
    const result = stripFrontmatter(input);
    expect(result).toBe("Body content");
    // Explicitly verify no \r remains (not masked by trim())
    expect(result).not.toContain("\r");
  });
});

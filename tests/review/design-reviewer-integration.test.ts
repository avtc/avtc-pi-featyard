// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Verify featyard agents declare correct skills and skill files exist.
 *
 * Uses parseFrontmatter directly — no dependency on pi-subagent internals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname ?? __dirname, "../..");
const agentsDir = path.join(repoRoot, "agents");
const skillsDir = path.join(repoRoot, "skills");

function loadAgentFromFile(filePath: string) {
  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
  return {
    name: frontmatter.name,
    skills:
      (frontmatter.skill || frontmatter.skills)
        ?.split(",")
        .map((s: string) => s.trim())
        .filter(Boolean) ?? [],
    body,
  };
}

describe("featyard agent/skill file structure", () => {
  test("design-reviewer agent has design-review content inlined and design-review loop-driver skill exists", () => {
    const agentFile = path.join(agentsDir, "fy-design-reviewer.md");
    expect(fs.existsSync(agentFile)).toBe(true);

    const agent = loadAgentFromFile(agentFile);
    expect(agent.name).toBe("fy-design-reviewer");
    // design-review review CONTENT is inlined into the agent body (no `skills:` frontmatter).
    expect(agent.skills ?? []).not.toContain("fy-design-review");
    expect(agent.body ?? "").toContain("Design Review");
    expect(agent.body ?? "").toContain("Design Review Findings");

    // The design-review skill is now the single-iteration loop-driver the extension dispatches.
    const skillFile = path.join(skillsDir, "fy-design-review", "SKILL.md");
    expect(fs.existsSync(skillFile)).toBe(true);

    const skillContent = fs.readFileSync(skillFile, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(skillContent);
    expect(frontmatter.name).toBe("fy-design-review");
    expect(body).toContain("Single Iteration");
    // Frontmatter should be stripped from body
    expect(body).not.toMatch(/^---/m);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Verify feature-flow bundled skill files are valid and resolvable.
 *
 * Uses parseFrontmatter directly — no dependency on pi-subagent internals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname ?? __dirname, "../..");
const skillsDir = path.join(repoRoot, "skills");

describe("feature-flow bundled skill files", () => {
  test("design-review skill file exists, has frontmatter, and contains expected content", () => {
    const skillFile = path.join(skillsDir, "ff-design-review", "SKILL.md");
    expect(fs.existsSync(skillFile)).toBe(true);

    const content = fs.readFileSync(skillFile, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

    expect(frontmatter.name).toBe("ff-design-review");
    expect(body.length).toBeGreaterThan(0);
    // Frontmatter stripped — body starts with markdown heading
    expect(body.startsWith("#")).toBe(true);
    expect(body.endsWith("\n")).toBe(false);
    expect(body).toContain("Design Review");
  });

  test("all agent-declared skills have corresponding skill files", () => {
    const agentsDir = path.join(repoRoot, "agents");
    const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

    for (const file of agentFiles) {
      const content = fs.readFileSync(path.join(agentsDir, file), "utf-8");
      const { frontmatter } = parseFrontmatter<Record<string, string>>(content);
      const skills =
        (frontmatter.skill || frontmatter.skills)
          ?.split(",")
          .map((s: string) => s.trim())
          .filter(Boolean) ?? [];

      for (const skill of skills) {
        // Check nested skill dir or flat skill file
        const nested = path.join(skillsDir, skill, "SKILL.md");
        const flat = path.join(skillsDir, `${skill}.md`);
        expect(fs.existsSync(nested) || fs.existsSync(flat)).toBe(true);
      }
    }
  });
});

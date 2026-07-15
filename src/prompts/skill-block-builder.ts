// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import fs from "node:fs";
import path from "node:path";
// stripFrontmatter imported from pi core — handles CRLF normalization correctly
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";

/**
 * Resolve a skill name to its absolute file path.
 * Only resolves skills from this extension's skills/ directory.
 * Returns null if the skill file does not exist.
 */
function resolveSkillPath(name: string): string | null {
  // Defense in depth: reject path traversal attempts
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;

  // Skills live at <project-root>/skills/<name>/SKILL.md. This file is at src/prompts/,
  // so project root is two levels up.
  const skillsDir = path.resolve(path.join(__dirname, "..", "..", "skills"));
  const candidate = path.join(skillsDir, name, "SKILL.md");
  const resolved = path.resolve(candidate);

  // Verify resolved path is contained within the skills directory (logical check)
  if (!resolved.startsWith(skillsDir + path.sep)) return null;

  // Resolve symlinks to prevent symlink escape attacks
  try {
    const realResolved = fs.realpathSync(resolved);
    const realSkillsDir = fs.realpathSync(skillsDir);
    if (!realResolved.startsWith(realSkillsDir + path.sep)) return null;
  } catch {
    return null;
  }

  return resolved;
}

/**
 * Expand a /skill:name command into the <skill> XML block that pi core
 * would produce via _expandSkillCommand().
 *
 * If `substituteFn` is provided, it's called on the skill body before wrapping
 * (used by workflow-monitor for {{PI_FY_*}} template substitution).
 *
 * Returns the expanded text, or the original text if the skill is not found
 * or on error (matching pi core's _expandSkillCommand behavior).
 */
export function expandSkillCommand(text: string, substituteFn: ((text: string) => string) | null): string {
  if (!text.startsWith("/skill:")) return text;

  // Find the first whitespace (space or newline) separating skill name from args
  const rest = text.slice(7);
  const match = rest.match(/^[a-z0-9-]+/);
  if (!match) return text;
  const skillName = match[0];
  const args = text.slice(7 + skillName.length).trim();

  const skillPath = resolveSkillPath(skillName);
  if (!skillPath) return text;

  try {
    const raw = fs.readFileSync(skillPath, "utf-8");
    let body = stripFrontmatter(raw);
    if (substituteFn) body = substituteFn(body);
    const block = `<skill name="${skillName}" location="${skillPath}">\n${body}\n</skill>`;
    return args ? `${block}\n\n${args}` : block;
  } catch (err) {
    log.error(`[skill] Failed to expand skill command: ${skillName}`, err instanceof Error ? err.message : err);
    return text;
  }
}

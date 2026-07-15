// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * context event router — substitutes {{PI_FY_*}} placeholders inside <skill> XML
 * blocks in user messages before each LLM call.
 *
 * Only substitutes inside <skill>...</skill> blocks — user text outside skill
 * blocks is left untouched. Scans ALL user messages (not just recent) because
 * the placeholder persists in the agent's state across turns and transformContext
 * only mutates a clone.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NO_AGENT_NAME, NO_FEATURE_STATE_OVERRIDE, substituteTemplates } from "../../shared/workflow-refs.js";

/** Regex that matches <skill ...> ... </skill> blocks (including multi-line content). */
const SKILL_BLOCK_RE = /(<skill[^>]*>[\s\S]*?<\/skill>)/g;

export function registerContext(pi: ExtensionAPI): void {
  pi.on("context", async (event, _ctx) => {
    const messages = event.messages;
    let modified = false;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user") continue;

      // Handle both string content and array content (pi 0.73+ uses arrays)
      if (typeof msg.content === "string") {
        if (!msg.content.includes("{{PI_FY_")) continue;
        const substituted = substituteInSkillBlocks(msg.content);
        if (substituted !== msg.content) {
          messages[i] = { ...msg, content: substituted };
          modified = true;
        }
      } else if (Array.isArray(msg.content)) {
        let partsModified = false;
        const newParts = msg.content.map((part) => {
          if (part.type === "text" && part.text.includes("{{PI_FY_")) {
            const substituted = substituteInSkillBlocks(part.text);
            if (substituted !== part.text) {
              partsModified = true;
              return { ...part, text: substituted };
            }
          }
          return part;
        });
        if (partsModified) {
          messages[i] = { ...msg, content: newParts };
          modified = true;
        }
      }
    }

    if (modified) {
      return { messages };
    }
    return undefined;
  });
}

/** Substitute {{PI_FY_*}} placeholders only within <skill> XML blocks. */
function substituteInSkillBlocks(text: string): string {
  return text.replace(SKILL_BLOCK_RE, (block) => {
    return substituteTemplates(block, NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME).text;
  });
}

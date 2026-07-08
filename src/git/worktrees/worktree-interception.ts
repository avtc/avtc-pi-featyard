// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Register worktree tool_call interception and before_agent_start CWD override.
 *
 * When a worktree is active, rewrites tool paths and commands to target the worktree directory.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FeatureSession } from "../../state/feature-session.js";
import { bashSingleQuote, getActiveWorktreeContext } from "./worktree-helpers.js";

/** File tools that require a path parameter */
const FILE_TOOLS_REQUIRED_PATH = new Set(["read", "write", "edit"]);

/** Injected into the system prompt via before_agent_start so the agent never commits .ff/ files. */
const FF_INSTRUCTION =
  "\n\n⚠️ `.ff/` files are auto-managed external storage — gitignored, never committed. Never `git add -f` them.";

/** File tools with an optional path parameter */
const FILE_TOOLS_OPTIONAL_PATH = new Set(["ls", "find", "grep"]);

export function registerWorktreeInterception(pi: ExtensionAPI, deps: { handler: FeatureSession }): void {
  const { handler } = deps;

  // --- Worktree tool_call interception (must be before guardrail handler) ---
  pi.on("tool_call", async (event, _ctx) => {
    const wtx = getActiveWorktreeContext(handler);
    if (!wtx) return undefined;
    const { worktreePath } = wtx;

    if (event.toolName === "bash") {
      const input = event.input as { command: string };
      if (!input.command) return undefined;
      input.command = `cd ${bashSingleQuote(worktreePath)} && ${input.command}`;
    } else if (FILE_TOOLS_REQUIRED_PATH.has(event.toolName)) {
      const input = event.input as { path: string };
      if (!path.isAbsolute(input.path)) {
        input.path = path.resolve(worktreePath, input.path);
      }
    } else if (FILE_TOOLS_OPTIONAL_PATH.has(event.toolName)) {
      const input = event.input as { path?: string };
      if (input.path === undefined || input.path === "") {
        input.path = worktreePath;
      } else if (!path.isAbsolute(input.path)) {
        input.path = path.resolve(worktreePath, input.path);
      }
    }
    return undefined;
  });

  // --- System prompt update for worktree CWD and .ff/ storage warning ---
  pi.on("before_agent_start", async (event, _ctx) => {
    let modified = event.systemPrompt;
    const wtx = getActiveWorktreeContext(handler);
    if (wtx) {
      modified = modified.replace(/Current working directory: .+/, `Current working directory: ${wtx.worktreePath}`);
    }
    // Append .ff/ external storage instruction (idempotent — safe if multiple handlers run)
    modified += FF_INSTRUCTION;
    if (modified === event.systemPrompt) return undefined;
    return { systemPrompt: modified };
  });
}

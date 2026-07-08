// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Pause an orphaned auto-agent after an external session replacement.
 *
 * newSession/switchSession are command-context-only: they cannot be refreshed from
 * a session_start event ctx (ExtensionContext), so a manual /new, /resume, /fork,
 * or /reload leaves them pinned to the now-dead runner. Rather than crash on the
 * next feature pick, pause the agent and ask the user to re-run its start command,
 * which mints a fresh command context and resumes the loop.
 */

import { log } from "../../log.js";
import type { AutoAgentRole } from "./auto-agent-state-machine.js";

/** Map an auto-agent role to its resume command + display name. */
function roleResumeInfo(role: AutoAgentRole): { command: string; display: string } {
  const command = role === "worker" ? "ff:auto-worker" : role === "designer" ? "ff:auto-designer" : "ff:auto-agent";
  return { command, display: `Auto-${role}` };
}

/**
 * Pause an orphaned auto-agent if one is in an active state.
 *
 * @param requestWidgetUpdate  Request a widget re-render after pausing.
 * @returns true if an agent was paused, false if none was active.
 */
export function pauseOrphanedAutoAgent(requestWidgetUpdate: () => void): boolean {
  const sm = globalThis.__piKanban?.autoAgent;
  if (!sm) return false;
  const state = sm.getState();
  // Only pause states that rely on newSession/switchSession for the next activation.
  // paused/stopped/error/idle are left untouched.
  if (state !== "working" && state !== "polling" && state !== "waiting" && state !== "grace-period") return false;
  const gpm = globalThis.__piKanban?.gracePeriod;
  if (gpm) gpm.stop();
  const { command, display } = roleResumeInfo(sm.getRole());
  sm.pause();
  globalThis.__piCtx?.notify(`${display} paused after manual session change. Re-run /${command} to resume.`, "warning");
  requestWidgetUpdate();
  log.info(`[kanban] session_start: orphaned ${display} paused after external session replacement (was ${state})`);
  return true;
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Shared context-compaction trigger.
 *
 * One helper for every extension-driven compaction boundary in featyard:
 *   - implement plan-task boundaries (`task_ready_advance`, `interTaskCompact` setting)
 *   - design/plan review iteration boundaries (`reviewIterationCompact` setting)
 *   - code-review loop boundaries (`reviewIterationCompact` setting)
 *
 * It checks the caller-supplied setting value (none / compact / compact>NK), the
 * optional token threshold, sets the stored compact follow-up (skill + framing +
 * caller note), and fires `ctx.compact()`. The compact-handler (compaction.ts)
 * owns the framing line ("Context was compacted...") and the skill expansion;
 * the caller owns the specific note only.
 *
 * Keeping this in a leaf module avoids the circular import that would otherwise
 * arise: phase-ready.ts already imports from review-loops.ts, so review-loops.ts
 * cannot import back from phase-ready.ts to reach the old review-iteration reset.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log, NO_ERROR } from "../log.js";
import { parseContextCompactValue } from "../settings/settings-schema.js";

// Re-entrancy guard: a single compact can be in flight at a time.
let compactGuardActive = false;

/** Reset the re-entrancy guard. For tests and session lifecycle. */
export function _resetCompactGuard(): void {
  compactGuardActive = false;
}

/** Sentinel for callers that need no post-compact callback (lint:bare-literals forbids bare null). */
export const NO_COMPACT_CALLBACK: (() => void) | null = null;

/** Caller-supplied payload describing the compaction to trigger. */
export interface CompactPayload {
  /** The setting value (none / compact / compact>NK) for this boundary. */
  settingValue: string;
  /**
   * Skill to re-inject after compaction. Omitted → the compact-handler derives the
   * phase's expected skill (implement→fy-implement, review→fy-review,
   * design/plan review sub-states→fy-design-review/fy-plan-review).
   */
  skillName?: string;
  /** Caller note appended after the skill + framing. No `/skill:` prefix, no framing. */
  message: string;
  /** Label for log lines identifying which boundary triggered the compact. */
  logLabel: string;
}

/**
 * Trigger a context compact at a work-unit boundary.
 *
 * @returns `true` if a compact was actually initiated (caller may stop / skip its
 *          own follow-up since the compact handler will re-inject the skill).
 */
export async function triggerContextCompact(
  ctx: ExtensionContext,
  payload: CompactPayload,
  onAfterFollowUp: (() => void) | null,
  recover: () => void,
): Promise<boolean> {
  const { settingValue, skillName, message, logLabel } = payload;

  if (compactGuardActive) {
    log.info(`${logLabel}: already in progress, skipping`);
    return false;
  }

  const { mode, threshold } = parseContextCompactValue(settingValue);
  if (mode !== "compact") {
    log.info(`${logLabel}: mode=${mode}, nothing to do`);
    return false;
  }

  if (threshold !== null) {
    const usage = ctx.getContextUsage ? await ctx.getContextUsage() : null;
    if (!usage?.tokens || usage.tokens <= threshold) {
      log.info(`${logLabel}: skipping compact — tokens (${usage?.tokens ?? "null"}) <= threshold (${threshold})`);
      return false;
    }
    log.info(`${logLabel}: tokens (${usage.tokens}) > threshold (${threshold})`);
  }

  compactGuardActive = true;
  globalThis.__piCompactFollowUp = {
    skillName,
    message,
    onAfterFollowUp: () => {
      compactGuardActive = false;
      onAfterFollowUp?.();
    },
  };
  // Fire the compact. ctx.compact() is fire-and-forget (void); it aborts the current turn,
  // then pi emits session_compact on success (delivers the stored follow-up + clears the
  // guard) or routes the failure to onError. On ANY failure (nothing-to-compact, no-model,
  // mid-summarization API error) the turn was already aborted, so the agent must be resumed
  // with the full compact-handler follow-up — the injected `recover` does that (it owns pi +
  // the skill assembly, supplied by the caller's deps). This module owns only the policy +
  // guard/follow-up state; recovery is a pure injected dependency.
  try {
    ctx.compact({
      onError: (err: Error) => {
        log.error(`${logLabel}: compact failed: ${err.message}`, NO_ERROR);
        recover();
      },
    });
  } catch (err) {
    // Defensive: ctx.compact is fire-and-forget (void) and routes failures to onError, but
    // a synchronous throw (before onError can fire) would leak compactGuardActive and orphan
    // the follow-up — clean up so later compacts are not silently skipped.
    log.error(`${logLabel}: compact threw synchronously: ${(err as Error).message}`, NO_ERROR);
    delete globalThis.__piCompactFollowUp;
    compactGuardActive = false;
    return false;
  }
  return true;
}

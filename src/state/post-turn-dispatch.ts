// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Post-turn follow-up dispatch — defers phase-transition followUp delivery to
 * the agent-settled boundary.
 *
 * WHY this exists. pi drains a `deliverAs: "followUp"` message queued *during* a
 * turn INSIDE the same agent loop (via the loop's `getFollowUpMessages`), so an
 * inline dispatch would run in the same agent cycle as the dispatching turn. That
 * broke the once-per-turn `phase_ready` guard: a phase-transition followUp
 * dispatched inline ran before `agent_end` reset the guard, so the followUp
 * skill's own `phase_ready` was silently deduped.
 *
 * THE FIX. Phase-transition followUps are not dispatched inline. They are staged
 * here via {@link schedulePostTurnFollowUp} and drained by the `agent_settled`
 * handler via {@link schedulePostTurnDrain}. `agent_settled` is the per-prompt
 * boundary at which pi has no pending retry/compaction/followUp continuation —
 * the moment pi will not continue running automatically. Draining there (instead
 * of at `agent_end`) means the staged followUp does not race a concurrently typed
 * user message: a user followUp queued during the run keeps pi in its post-run
 * loop, so `agent_settled` (and thus the drain) only fires once that user message
 * has been processed.
 *
 * The drain is DEFERRED (~{@link DRAIN_DELAY_MS}) rather than synchronous because
 * the `agent_settled` handler runs inside `_runAgentPrompt`'s `finally`; a
 * synchronous `sendUserMessage` there would re-enter `_runAgentPrompt` before the
 * outer run unwinds. The delay also lets a user message being typed at settle
 * time start its turn first — when the deferred drain fires, that turn is
 * streaming and the followUp enqueues behind it (FIFO) instead of jumping ahead.
 * This mirrors the compaction re-inject pattern (`scheduleDeferredFollowUp`).
 *
 * Mechanics (verified in pi-agent-core 0.80.6): at `agent_settled`,
 * `session.isStreaming === false` (`_isAgentRunActive` is cleared before the
 * event fires), so `sendUserMessage` takes the idle branch and starts a fresh
 * `_runAgentPrompt` — a new agent cycle with its own `agent_start…agent_settled`.
 * The `phase_ready` guard is reset on `agent_end` (per-cycle), so the new cycle's
 * `phase_ready` honors correctly.
 *
 * Compaction is unchanged: it aborts the turn mid-turn and re-injects its own
 * followUp via the separate `__piCompactFollowUp` slot; that path never stages a
 * followUp here.
 *
 * Module-level single slot: at most one phase-transition followUp is staged per
 * turn (the once-per-turn guard guarantees at most one honoring), and the slot +
 * pending timer are cleared on drain and on session/reset teardown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";

/** Delay (ms) before delivering the staged followUp after agent_settled. */
export const DRAIN_DELAY_MS = 500;

/** The staged followUp message text, or null when nothing is pending. */
let pendingPostTurnFollowUp: string | null = null;

/** Pending deferred-drain timer, or undefined when none is scheduled. */
let drainTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Stage a phase-transition followUp for delivery after the agent settles.
 *
 * Replaces any prior staged followUp (a newer honoring supersedes a stale one —
 * though the once-per-turn guard means there is normally at most one). Does NOT
 * deliver immediately.
 */
export function schedulePostTurnFollowUp(text: string): void {
  log.info(`[workflow] post-turn followUp staged (${text.length} chars)`);
  pendingPostTurnFollowUp = text;
}

/**
 * Schedule deferred delivery of the staged followUp (if any) after agent_settled.
 *
 * Called from the `agent_settled` handler. After {@link DRAIN_DELAY_MS}, delivers
 * the staged followUp via `pi.sendUserMessage(deliverAs: "followUp")`. At fire
 * time pi is idle (no pending continuation), so the message starts a fresh agent
 * cycle — unless a user turn started during the delay, in which case it enqueues
 * behind it. Clears the slot and the timer regardless, so a followUp is delivered
 * at most once. Re-entrant calls are no-ops if a drain is already pending.
 */
export function schedulePostTurnDrain(pi: ExtensionAPI): void {
  if (drainTimer !== undefined) return;
  if (pendingPostTurnFollowUp === null) return;
  drainTimer = setTimeout(() => {
    drainTimer = undefined;
    const text = pendingPostTurnFollowUp;
    pendingPostTurnFollowUp = null;
    if (text === null) return;
    log.info(`[workflow] post-turn followUp drained after agent_settled (${text.length} chars)`);
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  }, DRAIN_DELAY_MS);
}

/** Drop any staged followUp and cancel a pending drain — session teardown / fy:reset. */
export function clearPostTurnFollowUp(): void {
  if (drainTimer !== undefined) {
    clearTimeout(drainTimer);
    drainTimer = undefined;
  }
  if (pendingPostTurnFollowUp !== null) {
    log.info("[workflow] post-turn followUp cleared (undelivered)");
  }
  pendingPostTurnFollowUp = null;
}

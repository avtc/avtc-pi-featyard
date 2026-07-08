// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Agent-lifecycle domain module — the agent_start and agent_end handler bodies
 * as callable methods (no pi.on registration).
 *
 * agent_start re-arms the finish-phase guardrail whitelist (worktree policy +
 * worktree path) at the start of every agent turn while finish is active, and
 * signals a fresh turn to the compaction module. agent_end clears the guardrail,
 * resets the once-per-turn phase_ready guard, flags the agent finished, and
 * notifies the auto-agent on non-retryable execution-phase errors.
 *
 * The events/agent/ routers own the pi.on registration and call these methods.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setFinishPhaseWhitelisted } from "../../git/worktrees/worktree-lifecycle.js";
import { log, NO_ERROR } from "../../log.js";
import { getSettings } from "../../settings/settings-ui.js";
import type { IAgentLifecycle, ICompaction, IPhaseReady } from "../../shared/workflow-types.js";
import type { FeatureSession } from "../../state/feature-session.js";
import { isSubagentSession } from "../../state/state-persistence.js";
import type { AutoAgentCallback } from "./auto-agent-state-machine.js";

/** Find the last assistant message in a message list (reverse-search for role === "assistant"). Generic over the message type so it avoids cross-package SDK imports. */
function findLastAssistantMessage<TMessage extends { role: string; stopReason?: string; errorMessage?: string }>(
  messages: readonly TMessage[],
): TMessage | undefined {
  return [...messages].reverse().find((m) => m.role === "assistant");
}

/** Regex for retryable errors (transient network/API failures) */
const RETRYABLE_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

export interface AgentLifecycleDeps {
  handler: FeatureSession;
  compaction: ICompaction;
  phaseReady: IPhaseReady;
  getAutoAgentCallback: () => AutoAgentCallback | null;
}

/**
 * Construct the agent-lifecycle domain object. The returned methods are the
 * agent_start / agent_end handler bodies — the events/agent/ routers call them.
 */
export function createAgentLifecycle(deps: AgentLifecycleDeps): IAgentLifecycle {
  const { handler, compaction, phaseReady, getAutoAgentCallback } = deps;

  async function onAgentStart(): Promise<void> {
    compaction.setAgentFinished(false);
    // Re-arm the finish-phase guardrail whitelist at the start of every turn while
    // the finish phase is active (worktree policy + worktree path). The agent_end
    // handler clears it at turn end (crash safety + clears when leaving finish), so
    // re-arming here keeps it alive across the multi-turn interactive finish flow
    // (turn 1 presents the option menu → turn 2 executes the merge). Sole arming site.
    if (!isSubagentSession()) {
      const ws = handler.getWorkflowState();
      const fs = handler.getActiveFeatureState();
      if (ws?.currentPhase === "finish" && getSettings().branchPolicy === "worktree" && fs?.git?.worktreePath) {
        setFinishPhaseWhitelisted(true);
      }
    }
    log.info("[workflow] agent_start: resetting skill tracking");
  }

  async function onAgentEnd(
    event: { messages?: ReadonlyArray<{ role: string; stopReason?: string; errorMessage?: string }> },
    _ctx: ExtensionContext,
  ): Promise<void> {
    // Clear finish-phase guardrail whitelist flag on agent end
    setFinishPhaseWhitelisted(false);
    // Reset the once-per-agent-turn phase_ready guard. agent_end fires once per
    // user prompt, before any dispatched follow-up skill is delivered — so the
    // follow-up's fresh agent turn starts with a cleared guard. NOT reset on
    // turn_end: a pi "turn" is one LLM response, and the agent's repeated
    // phase_ready calls span multiple turns within one agent turn.
    phaseReady.resetTracking();
    // Don't trigger finish-done detection if Pi will auto-retry — the agent hasn't truly finished.
    // Pi emits agent_end before its own retry check, so we must detect this ourselves.
    let lastError: string | undefined;
    if (event.messages?.length) {
      const lastAssistant = findLastAssistantMessage(event.messages);

      if (
        lastAssistant &&
        lastAssistant.stopReason === "error" &&
        lastAssistant.errorMessage &&
        RETRYABLE_ERROR_RE.test(lastAssistant.errorMessage)
      ) {
        return;
      }
      if (lastAssistant && lastAssistant.stopReason === "error" && lastAssistant.errorMessage) {
        lastError = lastAssistant.errorMessage;
      }
    }

    compaction.setAgentFinished(true);

    if (isSubagentSession()) return;

    const latestState = handler.getWorkflowState();
    log.info(
      `[workflow] agent_end fired, activeFeatureSlug=${handler.getActiveFeatureSlug()}, currentPhase=${latestState?.currentPhase}`,
    );
    if (!latestState) return;

    // Notify auto-agent of non-retryable errors during execution phases
    if (lastError) {
      const errorSlug = handler.getActiveFeatureSlug();
      if (errorSlug && ["implement", "verify", "review"].includes(latestState.currentPhase ?? "")) {
        try {
          const autoAgentCb = getAutoAgentCallback();
          if (autoAgentCb) {
            log.info(`[workflow] auto-agent callback: notifying feature error for ${errorSlug}`);
            autoAgentCb.onFeatureError(errorSlug, lastError);
          }
        } catch (err) {
          log.error(`[workflow] auto-agent onFeatureError callback error: ${err}`, NO_ERROR);
        }
      }
    }
  }

  return { onAgentStart, onAgentEnd };
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * events/index.ts — the single manifest for all pi.on event registration.
 *
 * Consolidates the reactive pi.on handlers behind one entry point
 * (registerAllEvents), replacing the register calls that were inline in src/index.ts.
 * Registration order is preserved (handlers fire in registration order).
 *
 * The three homes for featyard entry points:
 *   tools/  = native tool registrations (the agent calls these — pull model)
 *   events/ = reactive pi.on handlers (pi emits these — push model) ← THIS FOLDER
 *   domain/ = the actual logic (state, gating, phases, kanban, ...)
 *
 * All pi.on handlers are now registered via this manifest EXCEPT a small number
 * of deliberate domain co-handlers that register their own pi.on because the
 * event IS their domain concern (not featyard core routing):
 *   - worktrees/worktree-interception.ts: tool_call (path-rewrite) + before_agent_start (CWD)
 *   - kanban/kanban-events.ts: tool_result (auto-agent heartbeat)
 * These are called from events/index.ts (registerWorktreeInterception) or from
 * kanbanExtension (registerKanbanEvents) and are documented here as the
 * deliberate exceptions to single-manifest registration.
 */

import { registerWorktreeInterception } from "../git/worktrees/worktree-interception.js";
import { registerAgentEnd } from "./agent/agent-end.js";
import { registerAgentSettled } from "./agent/agent-settled.js";
import { registerAgentStart } from "./agent/agent-start.js";
import { registerTurnEnd } from "./agent/turn-end.js";
import { registerTurnStart } from "./agent/turn-start.js";
import type { EventDeps } from "./event-deps.js";
import { registerInput } from "./input/input.js";
import { registerModelSelect } from "./session/model-select.js";
import { registerSessionCompact } from "./session/session-compact.js";
import { registerSessionShutdown } from "./session/session-shutdown.js";
import { registerSessionStart } from "./session/session-start.js";
import { registerSessionTree } from "./session/session-tree.js";
import { registerToolCall } from "./tool/tool-call.js";
import { registerToolResult } from "./tool/tool-result.js";

/**
 * Register all featyard pi.on event handlers. Called once from the composition root
 * (src/index.ts) after the domain singletons are constructed. Handlers fire in
 * registration order.
 */
export function registerAllEvents(deps: EventDeps): void {
  const { pi, handler, guardrails, compaction, lifecycle, agentLifecycle, kanbanTurn } = deps;

  // input → skill detection + phase movement + activation (events/input/input.ts)
  registerInput(pi, handler);

  // tool_call (worktree path-rewrite) + before_agent_start (CWD rewrite) — worktrees/
  registerWorktreeInterception(pi, { handler });

  // tool_call (per-tool gating) + tool_result (warnings/recording) — events/tool/
  registerToolCall(pi, guardrails, handler);
  registerToolResult(pi, guardrails, handler);

  // model_select → capture active model for kanban title/topic generation — events/session/
  registerModelSelect(pi);

  // session_start (kanban branch + state feature bind/resume/reset) — events/session/
  registerSessionStart(pi, lifecycle);

  // session_tree (restore workflow from session branch) — events/session/
  registerSessionTree(pi, lifecycle);

  // session_compact (deliver stored compaction follow-up) — events/session/
  registerSessionCompact(pi, compaction);

  // session_shutdown (clear pending follow-up + stop archive timer) — events/session/
  registerSessionShutdown(pi, compaction);

  // fy:reset command + globalThis workflow-monitor bridge are wired separately from
  // index.ts (registerSessionLifecycleCommands + wireSessionLifecycleBridge); the
  // session_start/session_tree pi.on registrations live here.

  // agent_start (reset tracking + re-arm finish guardrail) + agent_end (clear + finish-done + notify) + agent_settled (deferred phase-transition followUp drain) — events/agent/
  registerAgentStart(pi, agentLifecycle);
  registerAgentEnd(pi, agentLifecycle);
  registerAgentSettled(pi, agentLifecycle);

  // turn_start (grace pause + auto-agent unblock) + turn_end (model capture + grace resume) — events/agent/
  registerTurnStart(pi, kanbanTurn);
  registerTurnEnd(pi, kanbanTurn);
}

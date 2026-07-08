// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * EventDeps — the bag of domain singletons passed to event routers.
 *
 * Holds the already-constructed domain objects that the event routers in events/
 * delegate to: the handler as single source of truth, and the guardrails,
 * compaction, session-lifecycle, agent-lifecycle, and kanban turn-handler
 * domain objects. The cross-cutting helpers (expandSkillCommand,
 * applyModelOverrideForPhase, getAutoAgentCallback, etc.) are consumed by the
 * domain-object constructors in index.ts, not by the routers, so they are not
 * part of this bag.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KanbanTurnHandlers } from "../kanban/kanban-turn-handlers.js";
import type { IAgentLifecycle, ICompaction, IGuardrails, ISessionLifecycle } from "../shared/workflow-types.js";
import type { FeatureSession } from "../state/feature-session.js";

/** Constructed domain singletons consumed by the event routers. */
export interface EventDeps {
  pi: ExtensionAPI;
  handler: FeatureSession;
  guardrails: IGuardrails;
  compaction: ICompaction;
  /** Session-lifecycle domain object (session_start/session_tree bodies). */
  lifecycle: ISessionLifecycle;
  /** Agent-lifecycle domain object (agent_start/agent_end bodies). */
  agentLifecycle: IAgentLifecycle;
  /** Kanban turn-handler domain object (turn_start/turn_end bodies). */
  kanbanTurn: KanbanTurnHandlers;
}

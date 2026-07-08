// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Shared context interface for kanban register* modules.
 *
 * Each register function receives a KanbanContext instance providing
 * access to shared state and helpers needed across all modules.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Phase } from "../phases/phase-progression.js";
import type { FeatureState } from "../state/feature-state.js";
import type { AutoAgentStateMachine } from "./auto-agent/auto-agent-state-machine.js";
import type { KanbanDatabase } from "./data/kanban-database.js";
import type { KanbanTools } from "./kanban-operations.js";

/** Properly typed model reference captured from ExtensionContext. */
export interface CapturedModelRef {
  model?: ExtensionContext["model"];
  registry?: ExtensionContext["modelRegistry"];
}

export interface KanbanContext {
  /** Currently running auto-agent state machine (only one at a time per session) */
  autoAgent: AutoAgentStateMachine | null;
  /** Get or create the shared kanban database */
  getDatabase: () => Promise<KanbanDatabase>;
  /** Get or create the shared kanban tools */
  getTools: () => Promise<KanbanTools>;
  /** Notify user via stashed globalThis function (for timer/callback contexts without ctx) */
  notify: (msg: string, level: "info" | "warning" | "error") => void;
  /** Request widget re-render from workflow-monitor */
  requestWidgetUpdate: () => void;
  /** Shared model ref for generate-title/generate-topic */
  capturedModelRef: CapturedModelRef;
  /** Activate workflow for a feature — delegates to phase-transitions */
  activateWorkflowForFeature: (slug: string, phase: Phase, ctx: ExtensionContext | null) => Promise<void>;
  /** Resume workflow for a feature — delegates to phase-transitions */
  resumeWorkflowForFeature: (slug: string, ctx: ExtensionContext | null) => Promise<FeatureState | null>;
  /** Mark newSession as workflow-initiated before ctx.newSession() */
  setWorkflowInitiatedNewSession: (message: string | null) => void;
}

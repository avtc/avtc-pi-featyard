// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Type declarations for cross-extension bridge objects on globalThis.
 *
 * Each extension owns a single typed bridge object rather than scattered
 * individual globalThis keys. This provides type safety and co-locates
 * related state.
 *
 * Bridge objects are initialized by their owning extension factory and
 * survive jiti module reloads (moduleCache:false).
 */

import type { CompactFollowUp, PiCtx, PiKanbanBridge, PiWorkflowMonitorBridge } from "./types.js";

declare global {
  var __piWorkflowMonitor: PiWorkflowMonitorBridge | undefined;
  var __piKanban: PiKanbanBridge | undefined;
  var __piCtx: PiCtx | undefined;
  var __piCompactFollowUp: CompactFollowUp | undefined;
}

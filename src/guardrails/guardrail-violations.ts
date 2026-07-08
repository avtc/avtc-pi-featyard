// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Violation handling utilities.
 *
 * Discipline gate for tool_call blocking decisions and violation warning formatting.
 */

import type { ViolationType } from "../shared/workflow-types.js";
import type { Violation } from "../state/feature-session.js";
import { describeTddViolation } from "./tdd-enforcement.js";

export const UNRECOVERABLE_TYPES: ReadonlySet<ViolationType> = new Set(["phase-write-restriction", "tdd-write-order"]);

export interface DisciplineGateOpts {
  discipline: "off" | "advisory" | "strict";
  blockReason: string;
  warning: string;
  pendingMap: Map<string, string>;
  toolCallId: string;
}

/** Apply discipline gate to a tool_call event.
 *
 * - "strict" mode: always hard-blocks (identical whether the session is interactive,
 *   a subagent, or headless — a strict gate must not be bypassable by running in a
 *   different session kind)
 * - "advisory" mode: always stores warning (non-blocking)
 * - "off" mode: skip entirely
 *
 * Returns `{ block: true, reason }` if the call should be blocked, null otherwise.
 */
export function applyDisciplineGate(opts: DisciplineGateOpts): { block: true; reason: string } | null {
  if (opts.discipline === "strict") {
    return { block: true, reason: opts.blockReason };
  }
  if (opts.discipline === "advisory") {
    opts.pendingMap.set(opts.toolCallId, opts.warning);
  }
  // "off": skip entirely
  return null;
}

export function formatViolationWarning(violation: Violation): string {
  return describeTddViolation(violation);
}

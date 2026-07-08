// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Guardrail escalation tracking.
 *
 * Manages strike counts and session-level allow-lists for guardrail violations.
 * First strike for unrecoverable types blocks; for recoverable types allows.
 * Second+ strike prompts the user via escalation dialog.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getActiveFeatureSlug } from "../shared/workflow-refs.js";
import type { ViolationType } from "../shared/workflow-types.js";
import { withCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import { getLastMessage, withAttention } from "../snippets/vendored/subscribe-to-notifications.js";
import { isSubagentSession } from "../state/state-persistence.js";
import { UNRECOVERABLE_TYPES } from "./guardrail-violations.js";

export class GuardrailTracker {
  private strikes = new Map<ViolationType, number>();
  private sessionAllowed = new Set<ViolationType>();

  async maybeEscalate(
    type: ViolationType,
    ctx: ExtensionContext,
    toolContext: string | null,
  ): Promise<"allow" | "block"> {
    if (isSubagentSession()) return "allow";
    if (this.sessionAllowed.has(type)) return "allow";

    const current = this.strikes.get(type) ?? 0;
    this.strikes.set(type, current + 1);

    if (current < 1) {
      return UNRECOVERABLE_TYPES.has(type) ? "block" : "allow";
    }

    const slug = getActiveFeatureSlug();
    const label = type.replace(/-/g, " ");
    const baseDetail = toolContext ? `guardrail: ${label}\n${toolContext}` : `guardrail: ${label}`;
    const detail = [baseDetail, slug, getLastMessage()].filter(Boolean).join(" • ");
    // Use guard's stashed ui (survives runner invalidation) when available, fall back to ctx.ui
    const ui = globalThis.__piCtx?.ui ?? ctx.ui;
    const choice = await withAttention("workflow", detail, () =>
      withCoordinator(() =>
        ui?.select(`The agent has repeatedly triggered "${label}" guardrail. Allow it to continue?`, [
          "Yes, continue",
          "Yes, allow all for this session",
          "No, stop",
        ]),
      ),
    );

    if (choice === "Yes, continue") {
      this.strikes.set(type, 0);
      return "allow";
    }

    if (choice === "Yes, allow all for this session") {
      this.sessionAllowed.add(type);
      return "allow";
    }

    return "block";
  }

  /** Reset all tracking state (called on session reset). */
  reset(): void {
    this.strikes.clear();
    this.sessionAllowed.clear();
  }
}

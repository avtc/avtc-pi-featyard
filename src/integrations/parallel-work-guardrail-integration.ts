// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Parallel work guardrail integration layer.
 *
 * This is the ONLY file that imports from both avtc-pi-featyard internals
 * and the vendored subscribe-to-guardrail drop-in.
 *
 * Exports initGuardrailIntegration(pi) which calls subscribeToGuardrail
 * with featyard-specific hooks (isWhitelisted).
 *
 * The guardrail wires its own requestAttention via pi-notification — this layer
 * does NOT provide requestAttention.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subscribeToGuardrail } from "../snippets/vendored/subscribe-to-parallel-work-guardrail.js";

export function finishPhaseWhitelistCheck(categoryId: string): boolean {
  return (
    globalThis.__piWorkflowMonitor?.finishPhaseWhitelisted === true &&
    (categoryId === "branch-switch" || categoryId === "merge")
  );
}

export function initGuardrailIntegration(pi: ExtensionAPI): void {
  subscribeToGuardrail(pi, finishPhaseWhitelistCheck);
}

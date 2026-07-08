// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type GuardrailWhitelistCheck = (categoryId: string) => boolean;

/** Pass as `addWhitelistCheck` when no whitelist check is needed. */
export const NO_GUARDRAIL_WHITELIST_CHECK: GuardrailWhitelistCheck | null = null;

/**
 * Subscribe to pi-parallel-work-guardrail:ready and register hooks.
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 * Copy this file into your consumer's src/snippets/vendored/ directory verbatim — no changes needed.
 */
export function subscribeToGuardrail(pi: ExtensionAPI, addWhitelistCheck: GuardrailWhitelistCheck | null): void {
  const unsubs: Array<() => void> = [];

  // On session_shutdown (fires before reload): clean pi.events.on listeners
  // Note: pi.on handlers are auto-cleaned on reload (new Extension objects)
  pi.on("session_shutdown", () => {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
  });

  // Register :ready listener
  unsubs.push(
    pi.events.on("pi-parallel-work-guardrail:ready", (data: unknown) => {
      const api = data as {
        addWhitelistCheck?: (check: GuardrailWhitelistCheck) => void;
      };
      if (addWhitelistCheck) api.addWhitelistCheck?.(addWhitelistCheck);
    }),
  );
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** API object emitted on the `pi-todo:ready` event. */
export interface TodoReadyApi {
  disableBuiltInFollowUp: () => void;
  getCompletedItemId?: () => string | null;
  getInProgressItem?: () => string | null;
  areAllTodosDone?: () => boolean;
}

/**
 * Subscribe to pi-todo:ready and register hooks.
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 * Copy this file into your consumer's src/snippets/vendored/ directory verbatim — no changes needed.
 *
 * Returns sync lazy proxy — getCompletedItemId, getInProgressItem and areAllTodosDone delegate to
 * internal _api ref populated when :ready fires at session_start.
 * disableBuiltInFollowUp is passed as a boolean flag, applied inside :ready handler.
 * No pending queue needed — the flag is evaluated when _api is available.
 */
export function subscribeToTodo(
  pi: ExtensionAPI,
  disableBuiltInFollowUp: boolean,
): {
  getCompletedItemId(): string | null;
  getInProgressItem(): string | null;
  areAllTodosDone(): boolean;
} {
  const unsubs: Array<() => void> = [];

  // Internal API ref — populated when :ready fires
  let _api: TodoReadyApi | null = null;

  // On session_shutdown (fires before reload): clean pi.events.on listeners
  pi.on("session_shutdown", () => {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
  });

  // Register :ready listener
  unsubs.push(
    pi.events.on("pi-todo:ready", (api: unknown) => {
      _api = api as TodoReadyApi;
      if (disableBuiltInFollowUp) _api.disableBuiltInFollowUp();
    }),
  );

  // Return sync lazy proxy — methods delegate to _api when available
  return {
    getCompletedItemId(): string | null {
      return _api?.getCompletedItemId?.() ?? null;
    },
    getInProgressItem(): string | null {
      return _api?.getInProgressItem?.() ?? null;
    },
    areAllTodosDone(): boolean {
      return _api?.areAllTodosDone?.() ?? true;
    },
  };
}

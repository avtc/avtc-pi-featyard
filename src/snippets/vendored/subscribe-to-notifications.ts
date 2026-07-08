// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Notification forwarding — drop-in integration with pi-notification.
 *
 * Copy this file into your extension's src/snippets/vendored/ directory, then:
 *   1. Call subscribeToNotificationApi(pi) in your extension entry point
 *   2. Call requestAttention(source, detail) before any blocking UI call
 *   3. Call the returned cancel function when unblocked
 *
 * If pi-notification is not installed, all functions are no-ops.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Shared VALUES, stored on globalThis so they survive jiti `moduleCache: false` re-imports
 * (which create distinct module instances and would otherwise split module-level `let`
 * variables between the setter in extension.ts and the getter in select-with-note.ts).
 *
 * Only idempotent VALUES live here — there is one provider (so one requestAttention fn)
 * and one active session (so one lastMessage), observed identically by every
 * subscriber. Listener unsubs are NOT shared: each subscribeToNotificationApi() call
 * owns its own local closure unsubs, so multiple subscribers (ui-components,
 * ask-user-question, feature-flow) don't clobber each other's cleanup.
 */
interface NotificationForwardingState {
  requestAttention: ((source: string, detail?: string) => (() => void) | undefined) | null;
  lastMessage: string;
}
const STATE_KEY = "__piNotificationForwarding";
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: NotificationForwardingState };
function _state(): NotificationForwardingState {
  const g = globalThis as GlobalWithState;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = { requestAttention: null, lastMessage: "" };
  }
  const state = g[STATE_KEY];
  return state;
}

/**
 * Extract the last assistant text from a message_end event.
 * Handles string content and array content (filters to text blocks, takes last).
 * Returns empty string if no suitable text found.
 */
type MessageContentBlock = { type: string; text?: string };

export function extractLastAssistantText(event: {
  message?: { role?: string; content?: string | MessageContentBlock[] };
}): string {
  if (event.message?.role !== "assistant") return "";

  const content = event.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlocks = content.filter((b): b is MessageContentBlock & { type: "text" } => b.type === "text");
    const last = textBlocks[textBlocks.length - 1];
    if (last) {
      return last.text ?? "";
    }
  }
  return "";
}

/**
 * Get the last captured assistant message text.
 * Returns empty string if no message has been captured yet.
 */
export function getLastMessage(): string {
  return _state().lastMessage;
}

/**
 * Reset module state — called on session shutdown and during test cleanup.
 * Clears shared values; listener cleanup is each subscriber's own responsibility
 * (via its session_shutdown handler).
 */
export function _resetNotificationState(): void {
  const s = _state();
  s.lastMessage = "";
  s.requestAttention = null;
}

/**
 * Subscribe to pi-notification:ready event and message_end events.
 * Call once per extension entry point (all will set the same shared reference).
 *
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 */
export function subscribeToNotificationApi(pi: ExtensionAPI): void {
  const unsubs: Array<() => void> = [];

  const unsub = pi.events.on("pi-notification:ready", (data: unknown) => {
    const api = data as {
      requestAttention?: (source: string, detail?: string) => (() => void) | undefined;
    };
    if (typeof api.requestAttention === "function" && api.requestAttention) {
      _state().requestAttention = api.requestAttention;
    }
  });
  unsubs.push(unsub);

  // Capture last assistant message for notification context.
  // Note: pi.on (extension lifecycle events) returns void — these listeners are torn down
  // by pi when it discards the extension runner on reload/session-end, so no manual unsub.
  if (typeof pi.on === "function") {
    pi.on("message_end", (event: { message?: { role?: string; content?: string | MessageContentBlock[] } }) => {
      const text = extractLastAssistantText(event);
      if (text) _state().lastMessage = text;
    });
  }

  // Reset on session shutdown (fires before reload) — clean ONLY this subscriber's
  // EventBus listener (pi.on listeners are torn down by pi), then clear shared values
  // (hygiene; provider re-emits on next session_start).
  pi.on("session_shutdown", () => {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
    const s = _state();
    s.lastMessage = "";
    s.requestAttention = null;
  });
}

/**
 * Request attention before blocking on user input.
 * Returns a cancel function, or undefined if pi-notification is not installed.
 */
export function requestAttention(source: string, detail: string): (() => void) | undefined {
  return _state().requestAttention?.(source, detail);
}

/**
 * Wrap an async UI call with requestAttention/cancelAttention.
 * If pi-notification is not installed, just calls the function directly.
 *
 * @param source - Who is requesting attention (e.g. "permission", "ask_user_question")
 * @param detail - Optional detail (e.g. tool name, question summary)
 * @param fn - Async function that blocks on user input
 */
export async function withAttention<T>(source: string, detail: string, fn: () => Promise<T>): Promise<T> {
  const cancelAttention = requestAttention(source, detail);
  try {
    return await fn();
  } finally {
    cancelAttention?.();
  }
}

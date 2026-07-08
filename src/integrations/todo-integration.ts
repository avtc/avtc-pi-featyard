// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Feature-flow integration layer for pi-todo.
 *
 * Wires the generic pi-todo extension to feature-flow-specific infrastructure:
 * - disableBuiltInFollowUp: feature-flow handles followUp via session_compact + the todo getters
 *
 * Exports initTodoIntegration(pi) which calls subscribeToTodo from vendored drop-in
 * and returns the sync lazy proxy with getCompletedItemId/getInProgressItem/disableBuiltInFollowUp.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subscribeToTodo } from "../snippets/vendored/subscribe-to-todo.js";

/** Module-level ref for todo API, populated by initTodoIntegration. */
let _todoApi: ReturnType<typeof subscribeToTodo> | null = null;

/** @internal Test override for areAllTodosDone — when set, takes precedence over _todoApi. */
let _areAllTodosDoneOverride: boolean | null = null;

/** Disable built-in followUp — feature-flow handles it via session_compact + the todo getters */
const DISABLE_BUILTIN_FOLLOW_UP = true;

export function initTodoIntegration(pi: ExtensionAPI): ReturnType<typeof subscribeToTodo> {
  _todoApi = subscribeToTodo(pi, DISABLE_BUILTIN_FOLLOW_UP);
  return _todoApi;
}

/** Id of the item just completed by the todo_complete that triggered the current compaction (consume-on-read),
 *  or null when this compaction was not triggered by item completion. Null if pi-todo is not loaded. */
export function getTodoCompletedItemId(): string | null {
  return _todoApi?.getCompletedItemId() ?? null;
}

/** The current in-progress todo item formatted for followUp (`In progress: ▶ id: name\ndetails`),
 *  or null if none / pi-todo not loaded. */
export function getTodoInProgressItem(): string | null {
  return _todoApi?.getInProgressItem() ?? null;
}

/** Returns true if all todo items are in a terminal state (completed or decomposed). True when no items. */
export function areAllTodosDone(): boolean {
  if (_areAllTodosDoneOverride !== null) return _areAllTodosDoneOverride;
  return _todoApi?.areAllTodosDone() ?? true;
}

/** @internal Set override for areAllTodosDone (test only). Pass null to clear. */
export function _setAreAllTodosDoneOverride(value: boolean | null): void {
  _areAllTodosDoneOverride = value;
}

/** Reset module-level state for test isolation. */
export function resetTodoIntegration(): void {
  _todoApi = null;
  _areAllTodosDoneOverride = null;
}

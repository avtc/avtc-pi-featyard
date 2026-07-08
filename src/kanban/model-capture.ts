// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * captureModel — record the active model + model-registry into the shared ref so
 * kanban title/topic generation can call the LLM later (outside any request ctx).
 *
 * Prefers the guard's stashed model/registry (survives runner invalidation);
 * falls back to the event ctx only if the guard hasn't been refreshed yet
 * (startup edge case). Stale ctx is silently skipped.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedModelRef } from "./kanban-context.js";

export function captureModel(ref: CapturedModelRef, extensionCtx: ExtensionContext): void {
  // Prefer guard's stashed model/registry (survives runner invalidation).
  // Fall back to event ctx only if guard hasn't been refreshed yet (startup edge case).
  const guard = globalThis.__piCtx;
  if (guard?.model && guard?.modelRegistry) {
    ref.model = guard.model;
    ref.registry = guard.modelRegistry;
    return;
  }
  // Guard not yet refreshed — safe to use event ctx (only on initial session_start)
  try {
    if (extensionCtx.model && extensionCtx.modelRegistry) {
      ref.model = extensionCtx.model;
      ref.registry = extensionCtx.modelRegistry;
    }
  } catch {
    // Stale ctx — skip model capture
  }
}

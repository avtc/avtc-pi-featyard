// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * model_select event router — capture the active model + registry whenever the
 * model changes, so kanban title/topic generation can call the LLM later.
 *
 * Routes to the shared captureModel helper (kanban/model-capture.ts), writing into
 * the singleton _kanbanModelRef that title/topic generation reads.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { _kanbanModelRef } from "../../kanban/kanban-bridge.js";
import { captureModel } from "../../kanban/model-capture.js";

export function registerModelSelect(pi: ExtensionAPI): void {
  pi.on("model_select", (_event, extensionCtx) => {
    captureModel(_kanbanModelRef, extensionCtx);
  });
}

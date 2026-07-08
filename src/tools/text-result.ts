// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * Build a minimal tool result carrying only text content.
 *
 * `AgentToolResult<T>` requires a `details` field, even when the tool's
 * `renderResult` only inspects `content`. This helper supplies an unused
 * `details` so call sites stay focused on the text they want to return.
 */
export function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: undefined };
}

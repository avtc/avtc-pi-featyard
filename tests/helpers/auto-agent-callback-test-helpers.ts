// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { vi } from "vitest";
import type { AutoAgentCallback } from "../../src/kanban/auto-agent/auto-agent-state-machine.js";

/**
 * Build a complete AutoAgentCallback for tests. Unexercised members get inert
 * `vi.fn()` defaults (isActive defaults to false — non-auto), so tests override
 * only what they assert on. The production contract requires every member.
 */
export function createTestAutoAgentCallback(overrides: Partial<AutoAgentCallback> | null): AutoAgentCallback {
  return {
    onFeatureComplete: vi.fn(),
    onDesignComplete: vi.fn(),
    onFeatureError: vi.fn(),
    onBlock: vi.fn(),
    onUnblock: vi.fn(),
    onFeatureUatHandoff: vi.fn(),
    isActive: () => false,
    ...(overrides ?? {}),
  };
}

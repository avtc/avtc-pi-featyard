// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Shared logger mock factory for tests that need to assert on log calls.
 *
 * Usage in test files:
 *
 * ```ts
 * import { vi } from "vitest";
 * import { createMockLogger } from "../../helpers/mock-logger.js";
 *
 * vi.mock("../../../extensions/log.js", async (importOriginal) => {
 *   const actual = await importOriginal<typeof import("../../../extensions/log.js")>();
 *   return { ...actual, log: createMockLogger() };
 * });
 * ```
 *
 * Note: vi.mock is hoisted, so the mock call must remain in each test file.
 * This helper eliminates the duplicated mock object literal.
 */
import { vi } from "vitest";

export interface MockLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
}

export function createMockLogger(): MockLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Feature-flow logger.
 *
 * Thin wrapper over the shared `avtc-pi-logger` library (matches the sibling contract:
 * avtc-pi-subagent/src/log.ts, avtc-pi-parallel-work-guardrail/src/log.ts). The library
 * owns the file backend, rotation, retention, and level formatting; this module only
 * owns the feature-flow singleton + the one feature-flow-specific helper.
 *
 * Logs land at `~/.pi/logs/avtc-pi-feature-flow/<YYYY-MM-DD>.log` (date-partitioned, with
 * size roll-over + 2-day retention — all handled by the library). Best-effort: a logging
 * failure never throws to the host.
 *
 * Per-module scoped loggers are derived via `log.child("<module>")` in each module.
 */

import { homedir } from "node:os";
import { createLogger, NO_ERROR, resolveBaseDir, resolveLogPath } from "avtc-pi-logger";

/** No custom logger options — use library defaults. */
const NO_LOGGER_OPTIONS: Parameters<typeof createLogger>[1] = null;

/** Name feature-flow logs under (passed to createLogger). Centralized so the log-path helper matches. */
const LOGGER_NAME = "avtc-pi-feature-flow";

/** Feature-flow's process-wide logger (writes under ~/.pi/logs/avtc-pi-feature-flow/). */
export const log = createLogger(LOGGER_NAME, NO_LOGGER_OPTIONS);

/** Re-exported library sentinel: the value to pass `log.error`'s required error-cause argument
 *  when there is no caught exception (a config-level report). */
export { NO_ERROR };

/**
 * Resolve the exact log file path where feature-flow is currently writing.
 * Date-partitioned (`YYYY-MM-DD`.log, UTC); the current day's file is always where new lines
 * land (rolled-over portions get a `.1` suffix). Mirrors the logger's own base-dir precedence
 * (`options.baseDir ?? PI_LOGGER_DIR ?? resolveBaseDir(homeDir)`) so a relocated log store is
 * honored. Unaffected by PI_FF_HOME. Pass the timestamp explicitly from the call site.
 *
 * Used by the worktree-setup error message to point the user at the exact log file to inspect.
 */
export function getLogFilePath(now: Date): string {
  const baseDir = process.env.PI_LOGGER_DIR ?? resolveBaseDir(homedir());
  return resolveLogPath(LOGGER_NAME, baseDir, now);
}

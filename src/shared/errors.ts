// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Error thrown when a user cancels an interactive dialog (e.g. branch selection).
 * Used by workflow-monitor base branch resolution and guardrails execution mode dialog.
 */
export class UserCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserCancelledError";
  }
}

/**
 * Error thrown when user input fails validation (e.g. shell-unsafe characters in branch name).
 * Propagated through catch blocks that swallow generic errors.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

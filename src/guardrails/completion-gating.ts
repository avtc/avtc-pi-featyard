// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Publish gate for `git push` / `gh pr create`.
 *
 * Rule: a publish is blocked until the workflow reaches the **finish** phase. In the finish
 * phase it is confirmed via a dialog (Allow / Block, default Block). No active feature → no
 * gate (free push). Commits are NOT gated here — pre-commit discipline (checkPreCommitGate)
 * owns commits.
 *
 * The finish-phase dialog is routed via avtc-pi-ui-components' showSelectWithNote, which
 * forwards to the root session for subagent children (json + rpc), triggers notification
 * attention when pi-notification is installed, and auto-resolves to the default (Block) on
 * timeout or when no response is possible. So the confirm behaves identically whether the
 * session is interactive, a subagent, or headless.
 */

import { type SelectWithNoteOption, showSelectWithNote } from "avtc-pi-ui-components";

// Anchored to start of subcommand to avoid false positives from git-like strings inside
// arguments or string literals (e.g. node -e "...git push...").
const PUSH_RE = /^\s*git\s+push\b/;
const PR_RE = /^\s*gh\s+pr\s+create\b/;

export interface PublishGateDeps {
  /** The session ctx (hasUI + ui.custom + mode) — forwarded to the dialog for bridge routing. Null when no ctx is available. */
  ctx: { hasUI: boolean; ui?: unknown; mode: string } | null;
}

/** Reason returned when a publish is blocked because the workflow is not yet at finish. */
export const PUBLISH_BEFORE_FINISH_REASON =
  "git push / gh pr create are only allowed in the finish phase. Complete the workflow phases first.";

/** True if any subcommand is a `git push` or `gh pr create`. */
export function isPublishAction(subcommands: string[]): boolean {
  return subcommands.some((sub) => PUSH_RE.test(sub) || PR_RE.test(sub));
}

/**
 * In the finish phase, ask the user (or, for a subagent, the root session via the ui-bridge)
 * to confirm the publish. Default Block (fail-closed): an unattended / timed-out / no-bridge
 * session never publishes. Returns "allowed" only on an explicit Allow.
 */
export async function promptPublishGate(deps: PublishGateDeps): Promise<"allowed" | "blocked"> {
  // No ctx (e.g. fully headless with no bridge): fail-closed.
  if (!deps.ctx) return "blocked";

  const options: SelectWithNoteOption[] = [
    { label: "Allow once", value: "allow" },
    { label: "Block once", value: "block" },
  ];
  const result = await showSelectWithNote(
    deps.ctx as Parameters<typeof showSelectWithNote>[0],
    "Confirm publish (git push / gh pr create)?",
    options,
    options[1], // Block — the safe no-response outcome
    "featyard",
    undefined, // wait indefinitely for the human (no timeout)
  );

  return result?.value === "allow" ? "allowed" : "blocked";
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The dispatched per-task gate mini-skill (`ff-task-gate`).
 *
 * In the dispatch model, `task_ready_advance` decides after each call whether to
 * dispatch another gate round or advance. When it dispatches, it sends a fresh
 * `<skill name="ff-task-gate">` block via `sendUserMessage({ deliverAs: "steer" })`
 * — authoritative (survives compaction), arrives after turn-end or the next tool
 * call (robust to the model not ending its turn).
 *
 * This is a CODE CONSTANT, NOT a registered `skills/` file: it is never
 * `/skill`-invoked by the user. The non-empty `location=" "` makes the TUI
 * collapse the block into one `ff-task-gate` item.
 *
 * `buildTaskGateSkill` assembles only the gates the caller selected to run
 * (the caller decides which gates to run per the asymmetric respawn rule). It leaves `{{PI_FF_*}}` markers INTACT — the context
 * handler substitutes them inside `<skill>` blocks at the next LLM call, with the
 * real feature slug/phase; pre-substituting here (no slug/phase in scope) would
 * lock in a wrong date-based path the context handler cannot fix.
 */

export interface TaskGateSkillInput {
  /** 1-indexed round number being dispatched (round 1 on entry, then round+1 on reloop). */
  round: number;
  /** The current task the gate is gating (the model is told it is not ready to advance). */
  task: string;
  /** The next task to advance to, or undefined when on the last task (nextTask omitted in the example call). */
  next: string | undefined;
  /** Dispatch the #### Verify section (ff-task-verifier). */
  runVerifier: boolean;
  /** Dispatch the #### Review section (ff-general-reviewer). */
  runReviewer: boolean;
}

/** Escape model-provided task names so they cannot break the `<skill>` tag boundary, the
 *  `nextTask: "..."` quoting, or the markdown code spans in the skill body. The task/next
 *  values originate from plan content; this is defense-in-depth, not an adversarial sink.
 *  Exported because the same task name is interpolated into tool-result / compact
 *  follow-up messages that also reach pi's message pipeline. */
export function sanitizeSkillText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/`/g, "'");
}

/** Assemble the per-task gate skill body and wrap it as a collapsed `<skill>` block. */
export function buildTaskGateSkill({ round, task, next, runVerifier, runReviewer }: TaskGateSkillInput): string {
  const safeTask = sanitizeSkillText(task);
  const safeNext = next === undefined ? undefined : sanitizeSkillText(next);
  const nextParam = safeNext === undefined ? "" : `, nextTask: "${safeNext}"`;

  const verifySection = runVerifier
    ? `
#### Verify
Spawn ff-task-verifier — \`subagent({ agent: "ff-task-verifier", task: "..." })\`.
Task prompt: diff base (the commit before this task's first commit — fixed across all verify rounds; if unknown, find it with \`git log\`), diff head (current HEAD).
Treat \`⏭️ deferred\` like \`❌ missing\`: the work is not done.
`
    : "";

  const reviewSection = runReviewer
    ? `
#### Review
Spawn ff-general-reviewer — \`subagent({ agent: "ff-general-reviewer", task: "..." })\`.
Task prompt: implementer's report, diff base (the commit before this task's first commit — fixed across all review rounds; if unknown, find it with \`git log\`), diff head (current HEAD).
`
    : "";

  const body = `# Per-Task Gate — Round ${round}

Task "${safeTask}" is not ready to advance. Run the gates below, triage, then call task_ready_advance again.
${verifySection}${reviewSection}
#### Triage
- **Fixable** → fix it; count it (verifierIssuesFixed / reviewerIssuesFixed).
- **False-positive** → append to {{PI_FF_KNOWN_ISSUES_PATH}}.
- **Cannot-fix** (external blocker / missing dependency / breaking API contract) → escalate to the user.

Then call \`task_ready_advance({ verifierIssuesFixed: <count>, reviewerIssuesFixed: <count>${nextParam} })\` and follow its result — end your turn if it asks.
`;

  return `<skill name="ff-task-gate" location=" ">
${body}</skill>`;
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The dispatched per-task gate mini-skill (`fy-task-gate`).
 *
 * In the dispatch model, `task_ready_advance` decides after each call whether to
 * dispatch another gate round or advance. When it dispatches, it sends a fresh
 * `<skill name="fy-task-gate">` block via `sendUserMessage({ deliverAs: "steer" })`
 * — authoritative (survives compaction), arrives after turn-end or the next tool
 * call (robust to the model not ending its turn).
 *
 * This is a CODE CONSTANT, NOT a registered `skills/` file: it is never
 * `/skill`-invoked by the user. The non-empty `location=" "` makes the TUI
 * collapse the block into one `fy-task-gate` item.
 *
 * `buildTaskGateSkill` assembles only the gates the caller selected to run
 * (the caller decides which gates to run per the asymmetric respawn rule). It is
 * a pure assembler that leaves `{{PI_FY_*}}` markers INTACT unless the caller
 * passes a `substituteFn` — in which case the markers are resolved against
 * the current feature state BEFORE the block is wrapped, so the block that
 * reaches conversation history is fully resolved.
 *
 * History is immutable: markers are resolved once at dispatch time against the
 * state correct for the gated task. There is no per-call re-substitution —
 * re-resolving state-scoped markers (e.g. the task-scoped
 * `{{PI_FY_KNOWN_ISSUES_PATH}}`) against CURRENT state on every rewind would
 * mutate mid-history text and invalidate local-model prefix caches. The caller
 * (`task_ready_advance`) always passes a resolver.
 */

export interface TaskGateSkillInput {
  /** 1-indexed round number being dispatched (round 1 on entry, then round+1 on reloop). */
  round: number;
  /** The current task the gate is gating (the model is told it is not ready to advance). */
  task: string;
  /** The next task to advance to, or undefined when on the last task (nextTask omitted in the example call). */
  next: string | undefined;
  /** Dispatch the #### Verify section (fy-task-verifier). */
  runVerifier: boolean;
  /** Dispatch the #### Review section (fy-general-reviewer). */
  runReviewer: boolean;
}

/** Resolver applied to the skill body before wrapping when provided (mirrors `expandSkillCommand`'s `substituteFn`). Null/omitted = pure assembler (markers intact). */
export type TaskGateSubstituteFn = ((text: string) => string) | null;

/** Escape model-provided task names so they cannot break the `<skill>` tag boundary, the
 *  `nextTask: "..."` quoting, or the markdown code spans in the skill body. The task/next
 *  values originate from plan content; this is defense-in-depth, not an adversarial sink.
 *  Exported because the same task name is interpolated into tool-result / compact
 *  follow-up messages that also reach pi's message pipeline. */
export function sanitizeSkillText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/`/g, "'");
}

/** Assemble the per-task gate skill body and wrap it as a collapsed `<skill>` block.
 * `substituteFn` is REQUIRED (mirrors `expandSkillCommand`'s convention) to avoid optional params:
 * pass a resolver to resolve all `{{PI_FY_*}}` markers in the body BEFORE wrapping (so the returned
 * block is fully resolved and no markers reach conversation history), or pass `null` for pure
 * assembler mode (markers intact). */
export function buildTaskGateSkill(
  { round, task, next, runVerifier, runReviewer }: TaskGateSkillInput,
  substituteFn: TaskGateSubstituteFn,
): string {
  const safeTask = sanitizeSkillText(task);
  const safeNext = next === undefined ? undefined : sanitizeSkillText(next);
  const nextParam = safeNext === undefined ? "" : `, nextTask: "${safeNext}"`;

  const verifySection = runVerifier
    ? `
#### Verify
Spawn fy-task-verifier — \`subagent({ agent: "fy-task-verifier", task: "..." })\`.
Task prompt: diff base (the commit before this task's first commit — fixed across all verify rounds; if unknown, find it with \`git log\`), diff head (current HEAD).
Treat \`⏭️ deferred\` like \`❌ missing\`: the work is not done.
`
    : "";

  const reviewSection = runReviewer
    ? `
#### Review
Spawn fy-general-reviewer — \`subagent({ agent: "fy-general-reviewer", task: "..." })\`.
Task prompt: implementer's report, diff base (the commit before this task's first commit — fixed across all review rounds; if unknown, find it with \`git log\`), diff head (current HEAD).
`
    : "";

  const body = `# Per-Task Gate — Round ${round}

Task "${safeTask}" is not ready to advance. Run the gates below, triage, then call task_ready_advance again.
${verifySection}${reviewSection}
#### Triage
- **Fixable** → fix it; count it (verifierIssuesFixed / reviewerIssuesFixed).
- **False-positive** → append to {{PI_FY_KNOWN_ISSUES_PATH}}.
- **Cannot-fix** (external blocker / missing dependency / breaking API contract) → escalate to the user.

Then call \`task_ready_advance({ verifierIssuesFixed: <count>, reviewerIssuesFixed: <count>${nextParam} })\` and follow its result — end your turn if it asks.
`;

  const resolvedBody = substituteFn ? substituteFn(body) : body;
  return `<skill name="fy-task-gate" location=" ">
${resolvedBody}</skill>`;
}

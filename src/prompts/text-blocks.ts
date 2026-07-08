// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Static text blocks injected by the template engine's PI_FF_* placeholders.
// Pure data (array-joined strings) with no runtime deps; the engine imports these.
// Split out of template-substitution so the prompt content is browsable apart from
// the substitution mechanics.

/** General reviewer dispatch template — single generalist reviewer. */
export const GENERAL_DISPATCH_TEMPLATE = [
  "Dispatch the ff-general-reviewer as a subagent:",
  "",
  "```ts",
  "subagent({",
  '  tasks: [{ agent: "ff-general-reviewer", task: `<filled template>` }],',
  "})",
  "```",
  "",
  "**Template for the reviewer task:**",
  "",
  "```",
  "Review the following changed files for all quality aspects (SOLID, KISS, DRY, security, performance, testing, guidelines, requirements compliance):",
  "**Changed files:**",
  "<list of changed files with git diff summary>",
  "",
  "**Diff base:** <base SHA> — the commit before feature work began.",
  "**HEAD:** <head SHA>",
  "",
  "Report findings using the standard issue format:",
  "- ID: R<loopNumber>-<index>",
  "- Severity: Critical | Important | Minor",
  "- Category: <category>",
  "- File: path/to/file:startLine-endLine (optional)",
  "- Description: What is wrong and why",
  "- Suggested fix: How to fix (optional)",
  "",
  'If no NEW issues found, report "No new issues found."',
  "```",
].join("\n");

/** Comprehensive reviewer dispatch template — all 6 specialized reviewers. */
export const COMPREHENSIVE_DISPATCH_TEMPLATE = [
  "Dispatch ALL 6 specialized reviewers as parallel subagents. Do NOT skip any reviewer — each has a unique perspective that catches issues the others miss:",
  "",
  "- `ff-quality-reviewer` — SOLID, KISS, DRY, maintainability, naming",
  "- `ff-testing-reviewer` — Test coverage, edge cases, mock quality",
  "- `ff-security-reviewer` — Injection, auth, secrets, data exposure, input validation",
  "- `ff-performance-reviewer` — Data processing, algorithms, loops, queries, caching",
  "- `ff-guidelines-reviewer` — Project conventions, linting rules, architecture patterns, file organization",
  "- `ff-requirements-reviewer` — Spec compliance: verify implementation matches plan/spec document",
  "",
  "```ts",
  "subagent({",
  "  tasks: [",
  '    { agent: "ff-quality-reviewer", task: "<filled template>" },',
  '    { agent: "ff-testing-reviewer", task: "<filled template>" },',
  '    { agent: "ff-security-reviewer", task: "<filled template>" },',
  '    { agent: "ff-performance-reviewer", task: "<filled template>" },',
  '    { agent: "ff-guidelines-reviewer", task: "<filled template>" },',
  '    { agent: "ff-requirements-reviewer", task: "<filled template>" },',
  "  ],",
  "})",
  "```",
  "",
  "**Template for each reviewer task:**",
  "",
  "```",
  "Review the following changed files for <specialty>:",
  "**Changed files:**",
  "<list of changed files with git diff summary>",
  "",
  "**Diff base:** <base SHA> — the commit before feature work began.",
  "**HEAD:** <head SHA>",
  "",
  "Review each file and report only NEW findings using the issue format:",
  "- ID: R<loopNumber>-<index>",
  "- Severity: Critical | Important | Minor",
  "- Category: <specialty-category>",
  "- File: path/to/file:startLine-endLine (optional)",
  "- Description: What is wrong and why",
  "- Suggested fix: How to fix (optional)",
  "",
  'If no NEW issues found in your specialty area, report "No new issues found."',
  "```",
].join("\n");

/** Deferred-as-finding rule — treat a `⏭️ deferred` verifier outcome as a finding, not an escape. */
export const DEFERRED_IS_A_FINDING =
  "`⏭️ deferred` is a finding, not an escape — treat it like `❌ missing`: the work is not done, implement it.";

/** Verify phase templates — full verifier spawn instruction blocks. */
export const VERIFY_PHASE_TEMPLATES: Record<"verify" | "plan", string> = {
  verify: [
    '1. **Spawn ff-feature-verifier subagent** — `subagent({ agent: "ff-feature-verifier", task: "..." })`.',
    "Always run this verification — NEVER skip, even if you think there is nothing new to verify.",
    "2. **If issues found:** Use `todo_add` with `parentId` set to the currently active todo item to create sub-items for all issues (single call, multiple items). Fix them one at a time. After all fixes, commit. Then re-init the todo list (`todo_init` with `overwrite: true`) with a fresh cycle: [spawn verifier, fix issues, run build/lint/tests, call phase_ready], and return to step 1. Max iterations: {{PI_FF_VERIFY_ITERATIONS}}. After max attempts, escalate to user.",
    DEFERRED_IS_A_FINDING,
    "3. **Fallback:** If ff-feature-verifier subagent fails (timeout, crash, error), retry once. If still fails, report failure to user.",
  ].join("\n"),
  plan: [
    "1. Load the design document.",
    '2. Spawn `ff-plan-verifier` subagent — `subagent({ agent: "ff-plan-verifier", task: "..." })`.',
    "Always run this verification — NEVER skip, even if you think there is nothing new to verify.",
    "3. If ff-plan-verifier finds issues: fix the plan, then re-dispatch ff-plan-verifier to confirm fixes. Max iterations: {{PI_FF_VERIFY_ITERATIONS}}. After max attempts, escalate to user.",
    DEFERRED_IS_A_FINDING,
    "4. If all ✅: proceed to `phase_ready`",
    "5. **Fallback:** If ff-plan-verifier subagent fails (timeout, crash, error), retry once. If still fails, fall back to the manual per-point checklist: re-init the todo list (`todo_init` with `overwrite: true`) with one item per design point, verify each has a corresponding plan task.",
  ].join("\n"),
};

/**
 * Architecture principles — injected by {{PI_FF_ARCHITECTURE_PRINCIPLES}}.
 * Shared across design / plan / ff-implement / ff-implementer (single source of truth).
 * Role-neutral wording so it fits every phase.
 */
export const ARCHITECTURE_PRINCIPLES = [
  "- Apply SOLID, Clean Architecture, best practices. Favor separation of concerns and narrow interfaces.",
  "- Favor composition over inheritance — build from small, composable units.",
  "- Prefer explicit contracts (interfaces, defined boundaries) over implicit coupling (callbacks, shared mutable state, hidden assumptions).",
  '- Name the contract at every boundary crossing: inputs, outputs, invariants, error semantics. "A calls B" without the contract is hand-waving; state it explicitly.',
  "- Map the coupling: for each dependency, what must each side know — minimize it. The minimal contract that satisfies the real need wins.",
  "- Single source of truth: each piece of state has one authoritative location; derive the rest, never duplicate.",
  "- Stateless where possible: minimize mutable and shared state; prefer pure transformation — the principle, not a mandated mechanism.",
  "- Point dependencies toward stable abstractions, never in cycles; high-level policy does not depend on low-level details (dependency inversion).",
  "- Make invalid states unrepresentable: use types and constraints so illegal states cannot be constructed; fail fast on the rest.",
  "- Treat error handling as a first-class concern: define failure semantics at boundaries, fail fast, never swallow errors — errors are values.",
  "- Minimal public surface: expose the smallest useful API; do not build speculative generality (YAGNI).",
  "- Design for testability: units are independently testable via dependency injection and clear seams, with no hidden globals.",
].join("\n");

/** Coverage-first review process — mechanical skeleton shared across the seven code reviewers. */
export const COVERAGE_REVIEW_PROCESS = [
  "Review exhaustively, not by free-form scanning: build a complete checklist of the diff, then work every item in order. This is what surfaces issues that ad-hoc review misses loop after loop. The report file is an ISSUES list - track coverage through the todo list, not the report.",
  "",
  "1. **Scope.** Base commit = the commit before this work began (from your task prompt; if `(not available)`, find it with `git log`). It is fixed — review the full cumulative diff from base to HEAD. Run `git diff --name-only <base>..HEAD` and walk the changed files in diff order so nothing is skipped.",
  '2. **Build the checklist (your first todo item).** `todo_init` one item: "Build coverage checklist". Work it: read each changed source file and enumerate its reviewable units (functions/methods, classes, branches, error paths, public interfaces); for each changed test file, enumerate what it covers. For every Coverage Area below (including the final "Other"), `todo_add` an area item, then `todo_add` leaf items under it (`parentId`) — concrete `file:method`, line ranges, or data flows. The bullet points under an area are the checks to run on each leaf — they are NOT items. Finish by `todo_add`-ing a last item "Re-validate findings for false positives", then `todo_complete` the build item. Every leaf\'s `details` MUST hold the exact file/method refs and what to check — only what is written to the todo list or report file survives context compaction, not what is held in mind.',
  "3. **Work every item in order, one at a time.** For each leaf: actively hunt for an issue in your domain. The moment you find a potential issue, append it to the report file IMMEDIATELY — do not batch to the end, because the checklist can be large and a compaction may occur mid-way. Then `todo_complete` the leaf. Completing items is your coverage record; the report holds only real issues.",
  "4. **Re-validate (last item).** For each finding in the report, re-read the surrounding code and confirm it is real and within your role; then check it against the known-issues file and drop it if it duplicates an already-dismissed entry. Remove false positives. If the report is large, decompose this item into one sub-item per finding.",
].join("\n");

/** Coverage-first review process for documents — the doc analog of COVERAGE_REVIEW_PROCESS. */
export const DOC_COVERAGE_PROCESS = [
  "Review exhaustively, not by free-form scanning: enumerate the document into checkable items, then work every one in order. This surfaces issues that ad-hoc review misses loop after loop. The report file is an ISSUES list - track coverage through the todo list, not the report.",
  "",
  "1. **Read.** Read the document(s) named in your task, plus any docs you reference only for intent.",
  '2. **Build the checklist (your first todo item).** `todo_init` one item: "Build coverage checklist". Work it: read the document and enumerate its reviewable units. For every Coverage Area below (including the final "Other"), `todo_add` an area item, then `todo_add` leaf items under it (`parentId`) — concrete `section`/`file`/`task` refs. The bullet points under an area are the checks to run on each leaf — they are NOT items. Finish by `todo_add`-ing a last item "Re-validate findings for false positives", then `todo_complete` the build item. Every leaf\'s `details` MUST hold the exact refs and what to check — only what is in the todo list or report file survives context compaction, not what is held in mind.',
  "3. **Work every item in order, one at a time.** For each leaf: actively hunt for an issue in your domain. The moment you find one, append it to the report file IMMEDIATELY — do not batch to the end, because the checklist can be large and a compaction may occur mid-way. Then `todo_complete` the leaf. Completing items is your coverage record; the report holds only real issues.",
  "4. **Re-validate (last item).** For each finding, re-read the surrounding document/code and confirm it is real and within your role; then check it against the known-issues file and drop it if it duplicates an already-dismissed entry. Remove false positives. If the report is large, decompose this item into one sub-item per finding.",
].join("\n");

/**
 * Additional areas of attention — injected by {{PI_FF_ADDITIONAL_AREAS_OF_ATTENTION}}.
 * Concerns to be mindful of while writing tasks (plan) or code (ff-implementer), drawn from
 * the specialized code reviewers. Heading-less body; each consumer owns its own heading.
 * Deduped against ARCHITECTURE_PRINCIPLES (SOLID/error-handling/coupling/contracts live there).
 */
export const ADDITIONAL_AREAS_OF_ATTENTION = [
  "**Requirements**",
  "- Spec compliance — every requirement implemented; no scope creep; no divergent behavior.",
  "",
  "**Security**",
  "- Input validation at every trust boundary — reject early; defend against injection.",
  "- Authentication and authorization on every privileged action — fail closed.",
  "- Secrets, credentials, and PII kept out of code, logs, error messages, and config.",
  "- Data exposure, CSRF, dependency vulnerabilities, and configuration security.",
  "",
  "**Performance**",
  "- Algorithmic complexity, N+1 queries, allocations, and I/O in hot paths; right data structure; caching where it pays off.",
  "- Actual scale respected — a loop over ten items is not an issue.",
  "- Resources closed (files, handles, connections); no leaks; bounded concurrency.",
  "",
  "**Testing**",
  "- Critical path, every error and boundary path, edge cases, and negative cases covered.",
  "- Real assertions, not weak tautologies; mocking only what crosses the boundary.",
  "- Unit/integration balance; realistic test data.",
  "",
  "**Quality**",
  "- KISS and DRY — shared logic extracted once.",
  "- Intent-revealing names; small single-purpose units (high cohesion); readable code.",
  "",
  "**Conventions**",
  "- Project lint/format, naming, import/export, file-organization, and architecture-pattern conventions matched exactly.",
  "",
  "**Production readiness**",
  "- Backwards compatibility preserved, migrated, or broken deliberately — know what relies on current behavior.",
  "- Every caller and every reader/writer of changed data found before the change.",
  "- Shared state or background work: ordering guarantees and impossible races nailed.",
  "- Documentation and config aligned with the changes.",
].join("\n");

/**
 * Implementer guidance — injected by {{PI_FF_IMPLEMENTER_GUIDANCE}}.
 * Shared by BOTH the ff-implementer agent (agents/implementer.md) and ff-implement's
 * current-session mode. Inner placeholders (ARCHITECTURE_PRINCIPLES, ADDITIONAL_AREAS_OF_ATTENTION)
 * are INLINED here so the block substitutes once (no nested/double substitution).
 */
export const IMPLEMENTER_GUIDANCE = [
  "## Cycle",
  "",
  "For each behavior a task requires:",
  "",
  "1. **Red.** Write a test for one behavior. Run it. Confirm it fails for the *right* reason — assertion failure, not a compile or import error. If it fails for the wrong reason, fix that first.",
  "2. **Green.** Write the minimum code to pass it. Run it. Confirm green.",
  "3. **Refactor.** Clean up only after green. Re-run after each change; revert if it goes red.",
  "",
  "## Discipline",
  "",
  "- **Do NOT skip the failing run.** A new test that passes before you've implemented tests nothing — find out why it's already green before writing any code.",
  "- **Do NOT write code before its test.** If you already did, delete it, write the test, watch it fail, then reimplement to pass.",
  "- **One test, one behavior.** Don't stack tests against one monolithic change. Cycle per behavior.",
  "- **Do NOT commit red.** Build clean and all tests green at every commit.",
  "- **Do NOT rationalize an untested path** as obvious or covered elsewhere — if it's behavior, it has a test.",
  "",
  "## Architecture",
  ARCHITECTURE_PRINCIPLES,
  "",
  "## Reuse & dedup",
  "",
  "Reuse existing code when it already solves the problem and follows best practices — search before you write, and do not duplicate. As you work, refactor in progress to deduplicate code you write: extract the shared piece once and point every caller at it. Judge existing code before building on it — do not perpetuate a wrong design.",
  "",
  "## Refactoring scope",
  "",
  "Refactor whatever the task needs for a clean, correct implementation — decide autonomously; do not ask the user for routine improvements. High-level designs and tasks often leave details to your judgment; make the code right.",
  "",
  "Do not refactor code unrelated to the task. When you notice an out-of-scope code smell, a bug you cannot fix, or anything strange, report it in your final report as a **worth-note** (what and where) for the caller to record — do not fix it.",
  "",
  "## Bugs",
  "",
  "When fixing a bug or a verifier finding, write a failing test that reproduces it first, then fix. The test stays — it guards the regression.",
  "",
  "When you notice a real bug along the way — outside the literal task — investigate until 100% certain the logic is wrong, then fix it with a failing test that reproduces it (the test stays). Track each fix as additional `todo` items, and report every extra bug fixed: what was wrong and how you fixed it.",
  "",
  "## Commits",
  "",
  "Commit at green points: after a red→green cycle completes, or after a refactor that stayed green. Never commit broken builds, skipped tests, or work-in-progress.",
  "",
  "## Completion Rules",
  "",
  "You MUST implement EVERYTHING the task specifies. Do NOT stop partial.",
  "",
  '- **Do NOT stop early** because you think "enough was done" or "the rest is trivial" — implement everything.',
  "- **Do NOT skip steps** from the task description — each step was planned for a reason.",
  '- **Do NOT defer** planned work to "follow-up" or "future work" — this task IS the follow-up.',
  "- **Size up the scope.** If the task is large or under-specified — mis-planning, or high-level planning that omits details — deconstruct it into sub-steps with the `todo` tool and work them sequentially. Make each sub-step independently completable.",
  "",
  "## Very large tasks",
  "",
  "If a task is too large to finish in one session AND it decomposes into granular, independently-verifiable parts, decompose it and dispatch one nested `ff-implementer` subagent at a time per part, then review each subagent's work for correctness before moving on. Verify sequentially — do not dispatch in parallel.",
  "",
  "## Blockers",
  "",
  "Detect blockers and stop. When you cannot proceed cleanly — an unresolved ambiguity, a missing dependency, broken upstream code, or a decision out of your lane — do not guess or improvise around it. Stop and report to the user: what blocks you, what you tried, and what unblocks you. Do not silently narrow scope.",
  "",
  "## Additional areas of attention",
  "",
  ADDITIONAL_AREAS_OF_ATTENTION,
].join("\n");

/** Researcher delegation section — injected by {{PI_FF_RESEARCHER_DELEGATION}} when nestedResearchers is "on". */
export const RESEARCHER_DELEGATION_SECTION = [
  "## Delegation",
  "",
  "When the investigation covers multiple independent sub-areas (multiple modules, long call chains, broad subsystems), delegate each to a nested `ff-researcher` subagent in parallel after mapping the landscape yourself.",
  "",
  "- **Delegate a part, not the whole task** — split your investigation into narrower scopes, not a repeat of it",
  "- **Map before delegating** — do the initial `find`/`grep` yourself; delegate only after you know what sub-areas exist",
  "- **Don't delegate single lookups** — do them yourself",
  "- **Hierarchical output files** — append `.N` to your file stem: `feature-agent-1.md` → `feature-agent-1.1.md`",
  "- **Synthesize, don't concatenate** — connect findings across nested reports, note relationships and gaps",
  "",
  "```ts",
  "subagent({",
  "  tasks: [",
  '    { agent: "ff-researcher", task: "<narrow sub-task>. Write to: <your-path>-agent-X.1.md" },',
  '    { agent: "ff-researcher", task: "<narrow sub-task>. Write to: <your-path>-agent-X.2.md" },',
  "  ],",
  "})",
  "```",
].join("\n");

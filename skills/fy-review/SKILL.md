---
name: fy-review
description: Feature review skill — dispatches reviewers based on featureReviewMode setting, aggregates findings, runs a single iteration, then calls phase_ready with the issue counts. The extension decides whether to loop again.
disable-model-invocation: true
---

# Feature Review — Single Iteration
You are orchestrating **one iteration** of feature review. Dispatch specialized sub-reviewers as parallel subagents, collect findings, deduplicate, fix, and verify. The extension decides whether to loop again.

{{PI_FY_WORKTREE_CONTEXT}}
**Feature:** `{{PI_FY_FEATURE_SLUG}}`
**Review loop:** `{{PI_FY_REVIEW_LOOP_NUMBER}}`
**Design doc:** `{{PI_FY_DESIGN_DOC_PATH}}`
**Plan doc:** `{{PI_FY_PLAN_DOC_PATH}}`
**Known issues:** `{{PI_FY_KNOWN_ISSUES_PATH}}`

⚠️ **Parallel work safety:** You work in parallel with a team on the same working tree. Do not use `git stash/checkout/reset/clean/merge/rebase`, `npm install`, or any command that mutates the working tree or git state.

## Scope of action
- Read code and run read-only git commands.
- Write the review report and known-issues file.
- Edit source files only during the fix steps (4–6) — not during review (1–3).

## Process

### Step 1: Scope the Review
1. Determine the diff base. Base commit: `{{PI_FY_BASE_COMMIT_SHA}}`. If this shows `(not available)`, find the commit *before* the first feature commit manually using `git log`. This base is **fixed across all review loops** — every loop reviews the full cumulative diff from this base to HEAD, including unstaged files.
2. Run: `git diff --name-only <base>..<head>` to list changed files
3. Read the plan/spec document for requirements context
4. **Every sub-reviewer MUST review ALL changed files (full diff from base to HEAD) on every review iteration.** Do not narrow scope to "recent changes". Each sub-reviewer won't find all issues in one pass — reviewing the same full scope repeatedly uncovers new findings each loop.

### Step 2: Dispatch Reviewers
Always dispatch reviewers — NEVER skip, even if you think there is nothing new to review.
{{PI_FY_REVIEWER_DISPATCH}}

> ⚠️ **Do not dispatch a `-fork` variant.** The extension auto-forks reviewers when configured in settings.

### Step 3: Aggregate, Deduplicate, and Report
When all sub-reviewers return:
1. **Collect all findings** and **deduplicate** — different reviewers may describe the same issue differently. Merge by root cause, keep most severe classification and most actionable description.
2. **Re-index** — Assign sequential issue IDs: `R<loopNumber>-1`, `R<loopNumber>-2`, etc.
3. **Write the aggregated review report** to `{{PI_FY_REVIEW_REPORT_FILE}}`:

```
### Issue R<N>-<index>: <title> [Critical|Important|Minor]
- **Category:** security|quality|testing|performance|guidelines|requirements|architecture
- **File:** path/to/file.ts:42-55 (optional)
- **Description:** What is wrong and why it matters
- **Suggested fix:** How to fix (optional)
```

**⚠️ Do NOT fix issues during aggregation.** Every finding that survives deduplication becomes a fix task in Step 4.
**Update known-issues file** (`{{PI_FY_KNOWN_ISSUES_PATH}}`): Append dismissed issues as `cannot-fix` or `false-positive`.
**If no issues found:** Write report with empty Issues section. Add a single commit task with `todo_add` (do not re-init your list). Skip to Step 7.

### Step 4: Add Fix Tasks
Append fix tasks plus a final commit task with `todo_add` — do NOT re-init (`todo_init` wipes the whole feature's task state across loops):

Example tasks:
- "[Review #<N>] Fix: <issue summary>"
- ...
- "[Review #<N>] Commit: stage and commit all changes"

### Step 5: Execute Fix Tasks
Work through fix tasks one at a time.

For each fix task:
1. **REVALIDATE FIRST** — read the code, check surrounding context. Is this a real issue or false positive?
2. **If false positive** → append to `{{PI_FY_KNOWN_ISSUES_PATH}}` as false-positive, `todo_complete` the task
3. **If real issue** → investigate, fix, `todo_complete` the task
4. **If cannot fix** → append to `{{PI_FY_KNOWN_ISSUES_PATH}}` as cannot-fix, `todo_complete` the task
5. **For the commit task** → stage and commit, `todo_complete` the task

## Fix Discipline
**You MUST fix every real issue found during review.** Do NOT defer, postpone, or mark issues as cannot-fix unless you have a concrete, technical reason you cannot express in code.

- **Do NOT mark issues as `cannot-fix`** because they are "pre-existing", "low-impact", "style", or "future work" — these are not valid reasons. Fix them.
- **Do NOT mark issues as `false-positive`** without reading the code and verifying with evidence. If the reviewer found it, assume it is real until proven otherwise.
- **Do NOT skip issues in code within the feature's scope** — if the file was changed as part of this feature (check the cumulative diff from the base commit to HEAD) or was designed/planned to be modified, the issue must be addressed.
- **If an issue seems too large to fix**, deconstruct it with `todo_add` sub-items and fix each part.
- **If you genuinely cannot fix an issue** (external blocker, missing dependency, breaking API contract), you MUST escalate to the user: describe the issue, explain why it cannot be fixed, and propose alternatives. Do not silently mark `cannot-fix`. If a feasible solution exists, fix it instead of escalating.

### Step 6: Verify Fixes
Run the project's verification commands. Fix any failures before proceeding.

### Step 7: Done
Call `phase_ready({ issuesFound, cannotFix, falsePositives })` — issuesFound counts real issues (fixed + cannot-fix), excluding false positives. The extension handles looping.
**Known-issues file format:** Each entry has title, dismissed-as (cannot-fix | false-positive), and description.

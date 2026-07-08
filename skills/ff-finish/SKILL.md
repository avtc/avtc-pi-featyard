---
name: ff-finish
description: Finish and integrate completed feature work.
disable-model-invocation: true
---

# Finishing the Feature
Execute finishing instructions → resolve conflicts → verify tests post-merge → call phase_ready.

## Step 1: Execute Finishing Instructions
{{PI_FF_FINISH_INSTRUCTIONS}}

## Conflict Resolution
If `git merge` reports conflicts:
1. List conflicted files: `git diff --name-only --diff-filter=U`
2. For each: read conflict markers, analyze both sides, resolve preferring feature branch BUT validating base branch changes aren't silently discarded. `git add` after resolving.
3. After all resolved: `git commit`, review the merge diff, verify no unintended changes.
4. If resolution seems wrong or too complex: `git merge --abort`, report to user.

## Post-Merge Verification
After any successful merge: run the full test suite. If tests fail, investigate whether the merge introduced the breakage. If it did, fix it — the merge caused it, so it is resolvable — then re-run and re-verify before calling phase_ready. If you cannot fix it, revert the merge and report.

## Rules
- Signal completion only for terminal actions (merge, PR, discard) — never for keep-as-is.
- Never remove worktrees or delete branches; the extension owns cleanup.
- Require typed confirmation before discarding.
- Resolve merge conflicts per-file; never blanket `--theirs`.
- After a merge, investigate and fix any test breakage before completing.

---
name: fy-verify
description: Verify implementation before completion — spawns feature-verifier subagent, then runs build/lint/tests
disable-model-invocation: true
---

# Verifying the Feature
Use the `todo` tool to track open items and work through them one at a time. **The todo list survives context compaction — every item MUST have comprehensive details. Include step-by-step instructions and references to docs, design sections, or file paths wherever provided.**

{{PI_FY_WORKTREE_CONTEXT}}
{{PI_FY_VERIFY_PHASES:verify}}

Discover and run the project's build, lint, and test commands.

## Verification Discipline
**You MUST fix every issue the verifier finds.** Do NOT dismiss issues as "acceptable" or "not a correctness issue".

- **Do NOT skip issues** because "it works as-is" or "it's an internal improvement" — if the plan specified it, it must be implemented.
- **Do NOT dismiss partial implementation** as acceptable — if the plan said decompose X into 3 modules, all 3 must exist.
- **Do NOT rationalize gaps** — a gap between plan and implementation is a bug that must be fixed.
- **If the verifier found it, it is real** until you have concrete evidence otherwise.

After all tests pass, call `phase_ready` to signal verify phase completion. The extension handles the verify→review transition.

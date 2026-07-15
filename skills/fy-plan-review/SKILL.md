---
name: fy-plan-review
description: "Single-iteration plan review — runs one review pass on an implementation plan. The extension handles loop decisions."
disable-model-invocation: true
---

# Plan Review — Single Iteration
You are performing **one iteration** of plan review. The extension decides whether to loop again.

## Review Context
**Feature:** `{{PI_FY_FEATURE_SLUG}}`
**Review loop:** `{{PI_FY_REVIEW_LOOP_NUMBER}}`
**Known issues:** `{{PI_FY_KNOWN_ISSUES_PATH}}`

## Process

### Step 1: Scope the Review
1. Read the implementation plan at `{{PI_FY_PLAN_DOC_PATH}}`
2. Read the design document at `{{PI_FY_DESIGN_DOC_PATH}}`
3. Read relevant project context

### Step 2: Run Plan Review
Always run this review — NEVER skip, even if you think there is nothing new to review.
{{PI_FY_REVIEW_METHOD}}

> ⚠️ **Do not dispatch a `-fork` variant.** The extension auto-forks reviewers when configured in settings.

### Step 3: Revalidate Findings
For each finding: read the plan and design sections, verify the claim against source code. Do not accept reviewer claims at face value.

**Plan review corrects the plan — it never changes design intent.** When a finding requires a design-level decision, surface it with a proposal so the design can be updated.
- **Correction → apply** to the plan document — after confirming it doesn't alter the design's intent or recorded user decisions. A correction preserves intent: a citation, path, or line number; a contradiction between statements already in the plan; or a missing detail in a task the plan already specifies.
- **Design proposal → present to the user** with the rationale, a concrete proposed change to the design, and the trade-offs versus the current design. A finding requires a design-level decision if it adds, removes, or alters any design decision, option, type, interface, component, concept, or dependency; changes behavior or defaults; or conflicts with a recorded user decision. If the user defers → append to known-issues file as "pending user decision" with the proposal, so it is not lost or re-raised.
- **False positive → discard** and append to known-issues file.

Do not duplicate existing entries in the known-issues file.

### Step 4: Fix Issues
Fix confirmed issues in the plan document. Commit changes.

### Step 5: Present Results
Summary table: `| # | Severity | Issue | Action |`

### Step 6: Done
Call `phase_ready({ issuesFound, cannotFix, falsePositives })` — issuesFound counts real issues (fixed + cannot-fix), excluding false positives; cannotFix and falsePositives are the counts you dismissed to the known-issues file. The extension handles looping.

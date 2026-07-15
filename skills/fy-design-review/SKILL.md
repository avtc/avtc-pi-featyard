---
name: fy-design-review
description: "Single-iteration design review — runs one review pass on a design document. The extension handles loop decisions."
disable-model-invocation: true
---

# Design Review — Single Iteration
You are performing **one iteration** of design review. The extension decides whether to loop again.

## Review Context
**Feature:** `{{PI_FY_FEATURE_SLUG}}`
**Review loop:** `{{PI_FY_REVIEW_LOOP_NUMBER}}`
**Known issues:** `{{PI_FY_KNOWN_ISSUES_PATH}}`

## Process

### Step 1: Scope the Review
1. Read the design document at `{{PI_FY_DESIGN_DOC_PATH}}`
2. Read relevant project context (existing code, patterns, conventions)

### Step 2: Run Design Review
Always run this review — NEVER skip, even if you think there is nothing new to review.

{{PI_FY_REVIEW_METHOD}}

> ⚠️ **Do not dispatch a `-fork` variant.** The extension auto-forks reviewers when configured in settings.

### Step 3: Revalidate Findings
For each finding: read the design document section, verify the claim against source code. Do not accept reviewer claims at face value.

**Review corrects an approved spec — it never makes or changes a decision.** When a fix might change a decision, default to the user: present it, never apply it.
- **Correction → apply** to the design document — after confirming it contradicts nothing in the doc's "User Decisions" appendix. A correction preserves meaning: a citation, path, or line number; a contradiction between statements already in the doc; or a gap in a mechanism the doc already specifies.
- **Change request → present to the user**, re-checking it against the document and its recorded user decisions. A fix changes a decision if it adds, removes, or alters any decision, option, type, interface, component, concept, or dependency; changes behavior or defaults; or amends or reverses a recorded user decision. If dismissed → append to known-issues file as "pending user decision".
- **False positive → discard** and append to known-issues file.

Do not duplicate existing entries in the known-issues file.

### Step 4: Fix Issues
Fix confirmed issues in the design document. Commit changes.

### Step 5: Present Results
Summary table: `| # | Severity | Issue | Action |`

### Step 6: Done
Call `phase_ready({ issuesFound, cannotFix, falsePositives })` — issuesFound counts real issues (fixed + cannot-fix), excluding false positives; cannotFix and falsePositives are the counts you dismissed to the known-issues file. The extension handles looping.

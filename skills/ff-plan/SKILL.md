---
name: ff-plan
description: Turn an approved design into a task-plan for implementation.
disable-model-invocation: true
---

# Producing the Task-Plan
Turn the approved design into a task-plan the implementer runs top-to-bottom: every task sized to one session, self-contained, and traced to a design section.

**Design doc:** `{{PI_FF_DESIGN_DOC_PATH}}`

## Scope of action
- Read source code and documentation.
- Dispatch ff-researcher subagents.
- Read from `.ff/research/`.
- Write task-plan to `{{PI_FF_PLAN_DOC_PATH}}`.
- Modify no other files.

## Research Phase
Before writing each section/task, spawn ff-researcher subagents to verify the design's assumptions about the codebase.
Spawn up to {{PI_FF_RESEARCHER_MAX}} ff-researcher(s) per section/task (target: at least {{PI_FF_RESEARCHER_MIN}}). When min is 0, research is optional. Use them to: verify exact file paths and functions, identify line ranges, find related test files, discover integration points.
When spawning multiple ff-researchers, assign sequential instance numbers to output file paths so they don't collide. Output: `{{PI_FF_RESEARCH_DIR}}/{{PI_FF_FEATURE_SLUG}}-implementation-phase-{phaseNumber}-task-{taskNumber}-agent-{N}.md`
After ff-researchers complete, read their reports and incorporate findings.
The agent drives the research, not the reverse: hand each ff-researcher the exact yield to bring back — locations, signatures, line ranges, test files, commands, expected behavior — then carry those specifics into the tasks.
If the design omits, contradicts, or is ambiguous about something the implementation needs, investigate with a ff-researcher, then resolve it, flag it back as a design gap, or make it an explicit task. Never inherit a silent hole.
**If a ff-researcher fails:** retry once with narrower scope; else proceed and note the gap.

```ts
subagent({
  tasks: [{ agent: "ff-researcher", task: "<what to investigate and where to write findings>" }]
})
```

## Architecture
- Carry forward the design's architecture unchanged; do not alter it in the plan.
- Preserve the design's contracts and boundaries when decomposing into tasks.
- Flag back to design any task that needs an architecture decision the design did not make.
{{PI_FF_ARCHITECTURE_PRINCIPLES}}
- Specify what must be covered: critical paths, edge cases, and regressions, so implementation and verification know the target.

## Task shape
- Size each task so it ships one testable behavior end-to-end — writes it, verifies it green, and commits with nothing left to break down or defer.
- Carry every detail, decision, and behavior from the design into the task — nothing dropped, condensed, or silently changed.
- Shape each task so the implementer follows it without doing its own research, making design decisions, decomposing it into subtasks, or resolving uncertainties: state the files it touches, the change it makes, and the test that proves it done.
- Cover documentation: if the change affects docs (README, CHANGELOG, API docs), plan its update — a dedicated task, or a step in each task that touches it.
- Reference the design section or decision each task implements (e.g. "implements §4.2 / D7").
- Order tasks so each one's prerequisites are already done. Default to the design's section order.

## Plan Document Header
```markdown
# <Feature Name> Task-Plan

**Goal:** <one line — what this delivers>
**Approach:** <the approach in brief>
**Tech Stack:** <key technologies>

> Execution is driven by the `ff-implement` skill the extension injects.
```

## Guardrails
Address these failures by design, without over-prescribing implementation technique:
- Task too large to finish in one pass: decompose before handoff.
- Plan silently reversing or dropping a design decision: every deviation is explicit and flagged back as a design gap.
- Component built but never wired together: include a task that integrates each component into its caller or runtime.

## Additional areas of attention
{{PI_FF_ADDITIONAL_AREAS_OF_ATTENTION}}

## Incremental Writing
Write the plan header first, then append each task section on its own, so every task gets full attention and no write runs past its limit. A small plan may go down in a single write.

## Hand-off
Use the `todo` tool to track open items and work through them one at a time — every item needs comprehensive details (step-by-step instructions and references to docs, design sections, or file paths).

{{PI_FF_VERIFY_PHASES:plan}}

- Call `phase_ready` and end your turn. Do NOT run plan review — the extension handles it. Do NOT start implementing.

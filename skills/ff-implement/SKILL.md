---
name: ff-implement
description: Implement a feature from its task-plan.
disable-model-invocation: true
---

# Executing the Task-Plan
{{PI_FF_WORKTREE_CONTEXT}}
**Design doc:** `{{PI_FF_DESIGN_DOC_PATH}}`
**Plan doc:** `{{PI_FF_PLAN_DOC_PATH}}`

**Use the `todo` tool to track your work.** The todo list survives context compaction — every item MUST have comprehensive details (step-by-step instructions, references to design sections or file paths).

## The Process

### Step 1: Load Plan
Read the plan and seed your task list from its tasks:
- Init: `todo_init({ items: [{ name: "Task 1", details: "..." }, ...] })`
- For each task, `todo_add` sub-items mirroring its per-task cycle (Step 2): implement → call `task_ready_advance` (the extension dispatches the per-task gates or advances) → triage any dispatched gate findings → call `task_ready_advance` again with the fixable counts.
- Complete each sub-item as you finish: `todo_complete({ id })`

### Step 2: Execute Tasks

`task_ready_advance` starts a task, gates it, and advances — the extension decides whether to run the per-task gates. The `todo` tool tracks the finer work items within each task.

Start the first task: `task_ready_advance(nextTask: "<task number + name>")`.

For each task:
**Implement**
{{PI_FF_IMPLEMENT_MODE}}
{{PI_FF_WORTH_NOTES}}
**Gate + advance**
After task implemented, call `task_ready_advance(nextTask: "<next task number + name>")` and follow tool call result instructions. The extension either asks to end turn to wait for further instructions (run them, triage, then call again with the fixable counts) or advances to the next task (continue working). On the **last planned task**, omit `nextTask` param.

### Step 3: All Tasks Complete
After the last task's `task_ready_advance` call (`nextTask` omitted) the extension advances to the `verify` phase and runs the verification skill.

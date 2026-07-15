# avtc-pi-featyard

Predictable, deterministic feature development for [pi](https://pi.dev) — deep upfront design, configurable comprehensive review and verification rigor, and auto-agents draining a backlog

## Features

Featyard makes agentic development predictable and deterministic:

- **Deep upfront design** — subagents research every nuance during design; all open questions are asked upfront and answers are stored in the design-doc for later stages to build on.
- **Configurable review and verification** — set iteration counts per phase (design, plan, code review, verification) and per task; turn them down for simple features, up for complex ones.
- **Two review modes** — one general-reviewer subagent, or multiple specialized subagents (guidelines, quality, security, performance, requirements, testing) dispatched in parallel.
- **Multi-model routing** — assign different models per stage and per agent name (with glob patterns); optional round-robin rotation diversifies review findings.
- **Todo-driven checklists** — reviews and verification run against checklist-driven todo items so nothing is skipped or deferred.
- **Automatic context compaction** — configurable compaction triggers between tasks, phases, and review iterations keep long features viable without losing context.
- **Auto-agents** — once designs are approved, an auto-agent (started in a separate terminal) works through them sequentially: plan, implement, review each.
- **Kanban board** — browser UI tracking features across lanes with locks; auto-agents pull the next approved design off the board.
- **Per-feature git worktrees** — each feature gets an isolated branch workspace so parallel agents never collide.

## Requirements

**Pi 0.80.4 or later** must be installed.

**Git** must be installed separately — needed for per-feature worktrees, review diffs, and TDD guardrails.

Installing via `pi install npm:avtc-pi-featyard` bundles these extensions automatically:

- **[`avtc-pi-subagent`](https://github.com/avtc/avtc-pi-subagent)** — a subagent tool supporting context compaction and nested subagents
- **[`avtc-pi-todo`](https://github.com/avtc/avtc-pi-todo)** — a working-memory plan the agent manages through multi-stage work
- **[`avtc-pi-parallel-work-guardrail`](https://github.com/avtc/avtc-pi-parallel-work-guardrail)** — block or approve agent git operations that disrupt parallel work
- **[`avtc-pi-ui-components`](https://github.com/avtc/avtc-pi-ui-components)** — dialog coordinator preventing dialogs from rendering over each other
- **[`avtc-pi-subagent-ui-bridge`](https://github.com/avtc/avtc-pi-subagent-ui-bridge)** — lets extensions' dialogs from nested subagents render in the root session
- **[`avtc-pi-unstuck`](https://github.com/avtc/avtc-pi-unstuck)** — auto-continue on empty model responses + configurable timeouts for bash and search tools

**Optional (recommended):**
- **[`avtc-pi-portrait`](https://github.com/avtc/avtc-pi-portrait)** — builds a behavioral portrait from your session corrections, injected into the system prompt
- **[`avtc-pi-ask-user-question`](https://github.com/avtc/avtc-pi-ask-user-question)** — a question tool for the agent with subagent forwarding and attention alerts
- **[`avtc-pi-user-decisions`](https://github.com/avtc/avtc-pi-user-decisions)** — captures decisions, re-injects into the system prompt after compaction and into subagents
- **[`avtc-pi-notification`](https://github.com/avtc/avtc-pi-notification)** — bell and Telegram notifications, only fires when you're away

## Installation

```bash
pi install npm:avtc-pi-featyard
```

### Before you start

After installing, open `/fy:settings` and set:

- **Design doc storage** — `local` (`.featyard/`, not committed) or `committed` (`docs/featyard/`, tracked). Default `local`.
- **Branch policy** — `current-branch` (pair-program in your repo) or `worktree` (autonomous, isolated worktree per feature).

Other defaults work out of the box; tune review-loop counts, verification, and model routing as you go.

## Usage

Start a feature from the design phase. In a pi session, type the slash command for the design phase:

```
/skill:fy-design
```

(pi autocompletes slash commands — typing `/design` surfaces it.) The agent asks what you want to build, then:

1. **Researches** the codebase to ground the design in current state.
2. **Asks clarification questions** for each design section.
3. **Runs the design review** autonomously (the `fy-design-review` loop, driven by the extension).
4. **Pauses for your review** of the design document before moving on (interactive mode).
5. Once you approve, **the rest runs autonomously**: plan → plan review → implementation → verification → code review.
6. The feature **lands in UAT** for you to verify before it finishes.

You stay in control at the design gate; everything after is hands-off until UAT.

Tune the pipeline with `/fy:settings` — a multi-tab modal overlay for implement mode, review-loop counts, per-task review mode, inter-task context compaction, branch policy, and model routing per phase.

## The Workflow Pipeline

```
design → plan → implement → verify → review → (UAT-after-review) → finish → (UAT-after-finish)
```

Start workflow via `/skill:fy-design` invoke. Next phase transitions happens automatically, but can be also switched with `/skill:`.

| Phase | Driver skill | What happens |
|-------|-------------|--------------|
| **design** | `/skill:fy-design` | Explores intent + requirements, produces a design document (`{design dir}/{slug}-design.md`, per the design-doc storage setting) — interactive, you review before it advances |
| **plan** | `/skill:fy-plan` | Breaks the design into an fy-implementer-ready task plan (`.featyard/task-plans/{slug}-task-plan.md`) |
| **implement** | `/skill:fy-implement` | Works through the task plan in an isolated worktree |
| **verify** | `/skill:fy-verify` | Spawns the fy-feature-verifier subagent, then runs build / lint / tests |
| **review** | `/skill:fy-review` | Dispatches parallel specialized reviewers (or a single generalist) over the code; loops per `maxFeatureReviewRounds` setting |
| **UAT** | `/fy:next` | To transition to UAT phase in case no longer want to continue review-iterations, as UAT does not have skill to activate it via `/skill:` |
| **finish** | `/skill:fy-finish` | Presents merge / PR / keep / discard options and cleans up |

The widget in the TUI status bar shows live progress — workflow phases, auto-agent state, and feature ID + name. Task progress is shown by the separate `avtc-pi-todo` widget.

![widget](assets/images/widget.png)

The implementation phase runs in one of three modes, set by the `implementMode` setting: `current-session` (the agent implements in the main session, checkpointed), `subagent-driven` (a fresh subagent implements each task), or `subagent-driven-fork` (a subagent forked from your session's context implements each task).

### Design + plan review loops

The design and plan phases each self-review before advancing: the extension runs dedicated review passes (`fy-design-review`, `fy-plan-review`) and fixes the findings, repeating for the configured number of rounds. This catches gaps and inconsistencies before implementation begins, so the downstream phases start from a reviewed design and plan.

## Kanban + Auto-Agents

The kanban board is optional. A single feature needs none of it — you run `/skill:fy-design` and the pipeline carries it to UAT. The kanban is for working on **many features in parallel**: you queue several designs, and auto-agents route them through the pipeline concurrently. An auto-designer runs design-reviews on queued designs (features land in the *design-approval* lane when ready), while each auto-worker takes one feature from the *ready* lane and drives it through task-plan, implementation, and code-review loops to UAT. Features live in lanes and move through them as work progresses.

![kanban board](assets/images/kanban-board.png)

> **Status:** worktree isolation is tested within a single repo; the auto-agent's switch to another feature when blocked by the user is **not yet tested**. Worktree mode targets one repo only — cross-repo changes (multiple repos, submodules, or sibling repos touched in one feature) are not supported. Single-session implementation remains the fully tested path.

| Command | What it does |
|---------|--------------|
| `/fy:kanban` | Open the kanban board in a browser (starts the HTTP server if needed) |
| `/fy:auto-agent` | Start the autonomous loop — picks features from both design and ready lanes |
| `/fy:auto-worker` | Autonomous loop, ready lane only |
| `/fy:auto-designer` | Autonomous loop, design lane only |
| `/fy:auto-pause` | Pause the auto-loop (keeps the current feature, heartbeat alive) |
| `/fy:auto-stop` | Stop the auto-agent and resume interactive control (detaches the auto-agent, no re-dispatch) |
| `/fy:kanban-release` | Release a feature lock so others can pick it up |

A queued backlog plus `/fy:auto-agent` lets the harness chew through features on its own, with verification and review gates still enforced.

## Tools

| Tool | Description |
|------|-------------|
| `phase_ready` | Signal phase completion + trigger the next-phase handoff |
| `task_ready_advance` | Start a task, advance to the next, or finish implementation (per-task gate dispatch) |
| `add_to_backlog` | Add a new feature to the kanban backlog |

## Commands

| Command | Description |
|---------|------------|
| `/fy:next` | Manual command to advance to next phase, expected to be used to advance from `uat` to `finish`, as other phases can be activated by invoking the skill related to phase |
| `/fy:reset` | Turn-off the workflow |
| `/fy:resume` | List active workflows and load the selected one into the current session |
| `/fy:settings` | Open the settings UI |
| `/fy:archive-artifacts <days>` | Archive old workflow artifacts (older than `<days>` days) out of your way; asks before moving anything |
| `/fy:archive-designs <days>` | Archive old design docs (older than `<days>` days) from both `.featyard/designs` and `docs/featyard/designs`; asks before moving anything |

## Skills

9 skills covering the pipeline phases, the design/plan review loops, and research:

- **Phase drivers** — `fy-design`, `fy-plan`, `fy-implement`, `fy-verify`, `fy-review`, `fy-finish`
- **Review-iteration drivers** — `fy-design-review`, `fy-plan-review` (single-iteration passes re-dispatched per the configured loop count)
- **Research** — `fy-research` (deep code analysis for investigation tasks)

Invoke any with `/skill:<name>`.

## Named Subagents

14 specialized agent profiles dispatched automatically by the review and verify skills (you don't invoke them directly):

- **Reviewers** — `fy-general-reviewer`, `fy-design-reviewer`, `fy-plan-reviewer`, `fy-guidelines-reviewer`, `fy-quality-reviewer`, `fy-security-reviewer`, `fy-performance-reviewer`, `fy-requirements-reviewer`, `fy-testing-reviewer`
- **Verifiers** — `fy-feature-verifier`, `fy-plan-verifier`, `fy-task-verifier`
- **Utilities** — `fy-researcher`, `fy-implementer`

Dispatched via [`avtc-pi-subagent`](https://github.com/avtc/avtc-pi-subagent).

## Artifacts

- **Design docs** — `docs/featyard/designs/` or `.featyard/designs/` per the `designDocStorage` setting.
- **Task plans, research, reviews** — stored out-of-repo under a `.featyard/` junction (see below)

### The `.featyard/` junction

Plans, research, and review artifacts are kept out of git (they're process artifacts, not source). Featyard creates a gitignored `.featyard/` link at project init that points to a stable, project-keyed external location (`~/.pi/featyard/<project>/`). All worktrees of the project share that one store, so artifacts survive worktree removal.

## Configuration

The `/fy:settings` command opens a tabbed modal covering every setting — workflow behavior, review-loop counts, branch policy, feature review mode, inter-task compaction, model overrides, and more:

![settings modal](assets/images/settings.png)

![settings dropdown](assets/images/settings-dropdown.png)

Workflow settings (workflow behavior, review-loop counts, branch policy, feature review mode, inter-task context compaction) live in `avtc-pi-featyard-settings.json` (`~/.pi/agent/` global, `<cwd>/.pi/` project overrides) and are edited via `/fy:settings`. **Model routing per phase** is configured separately in pi's shared `~/.pi/agent/settings.json` under the `"avtc-pi-featyard"` key. See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full reference.

## Full suite

Check out the full suite of related extensions, [avtc-pi](https://github.com/avtc/avtc-pi) — deterministic feature development, subagent delegation, working-memory, behavioral learning, parallel-work guardrails, durable decisions, notifications, and more.

Developed with [Z.ai](https://z.ai/subscribe?ic=N5IV4LLOOV) — get 10% off your subscription via this referral link.

## Attribution

Inspired by [coctostan/pi-superpowers-plus](https://github.com/coctostan/pi-superpowers-plus) and [obra/superpowers](https://github.com/obra/superpowers) (Jesse Vincent).

## License

MIT

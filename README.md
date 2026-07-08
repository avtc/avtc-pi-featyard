# avtc-pi-feature-flow

A structured, phase-gated feature-development harness for [pi](https://pi.dev) — drives each feature through a disciplined workflow pipeline, tracks features on a kanban board, and can run auto-agents that pick up queued features and move them through to completion with minimal supervision.

## What it does

Feature-flow wraps pi in a disciplined development cycle and adds the orchestration to manage many features in parallel:

- **A workflow pipeline** the agent walks through for each feature — design → plan → implement → verify → review → (UAT) → finish.
- **A kanban board** (browser UI) tracking features across lanes — backlog, design, design-approval, ready, in-progress, UAT, done — with locks so multiple agents don't collide on the same feature.
- **Auto-agents** that autonomously pull the next feature off the board and drive it through the pipeline, so a backlog can drain with light oversight instead of one-feature-at-a-time hand-holding.
- **Per-feature git worktrees** so each feature gets an isolated branch workspace; parallel agents never step on each other's working tree.
- **Specialized review/verification subagents** dispatched in parallel during the review and verify phases.

## Requirements

Feature-flow coordinates with the rest of the avtc-pi suite at runtime. Install these alongside it:

**Required:**
- **Git** — required at runtime; without it, per-feature worktrees aren't created, review can't diff changes against the initial state, and TDD guardrails are skipped.
- **[`avtc-pi-subagent`](https://github.com/avtc/avtc-pi-subagent)** — dispatches the review/verify/research subagents
- **[`avtc-pi-todo`](https://github.com/avtc/avtc-pi-todo)** — the working-memory todo list (tracks implementation + review-fix work)
- **[`avtc-pi-parallel-work-guardrail`](https://github.com/avtc/avtc-pi-parallel-work-guardrail)** — protects parallel worktree work from disruptive git operations
- **[`avtc-pi-settings-ui`](https://github.com/avtc/avtc-pi-settings-ui)** — settings UI (compile-time dependency)

**Optional (recommended):**
- **[`avtc-pi-portrait`](https://github.com/avtc/avtc-pi-portrait)** — persistent behavioral profile (improves agent consistency)
- **[`avtc-pi-ask-user-question`](https://github.com/avtc/avtc-pi-ask-user-question)** — structured clarification questions (used by the design phase)
- **[`avtc-pi-user-decisions`](https://github.com/avtc/avtc-pi-user-decisions)** — captures your decisions and re-injects them after context compaction; decisions are shared with subagents via per-root-session storage
- **[`avtc-pi-notification`](https://github.com/avtc/avtc-pi-notification)** — desktop/Telegram notifications for auto-agent events

## Installation

```bash
pi install git:github.com/avtc/avtc-pi-feature-flow
```

### Enabling the kanban board (optional)

The kanban board uses a local SQLite database via `better-sqlite3` (a native module). On most systems the prebuilt binary installs automatically. If you see a `better-sqlite3` load error, allow its install script:

```bash
npm approve-scripts better-sqlite3   # run in your project directory
```

Feature-flow works without the kanban — it's optional for managing multiple features in parallel. A single feature needs none of it.

### Before you start

After installing, open `/ff:settings` and set:

- **Design doc storage** — `local` (`.ff/`, not committed) or `committed` (`docs/ff/`, tracked). Default `local`.
- **Branch policy** — `current-branch` (pair-program in your repo) or `worktree` (autonomous, isolated worktree per feature).

Other defaults work out of the box; tune review-loop counts, verification, and model routing as you go.

## Usage

Start a feature from the design phase. In a pi session, type the slash command for the design phase:

```
/skill:ff-design
```

(pi autocompletes slash commands — typing `/design` surfaces it.) The agent asks what you want to build, then:

1. **Researches** the codebase to ground the design in current state.
2. **Asks clarification questions** for each design section.
3. **Runs the design review** autonomously (the `ff-design-review` loop, driven by the extension).
4. **Pauses for your review** of the design document before moving on (interactive mode).
5. Once you approve, **the rest runs autonomously**: plan → plan review → implementation → verification → code review.
6. The feature **lands in UAT** for you to verify before it finishes.

You stay in control at the design gate; everything after is hands-off until UAT.

Tune the pipeline with `/ff:settings` — a multi-tab modal overlay for implement mode, review-loop counts, per-task review mode, inter-task context compaction, branch policy, and model routing per phase.

## The Workflow Pipeline

```
design → plan → implement → verify → review → (UAT-after-review) → finish → (UAT-after-finish)
```

Start workflow via `/skill:ff-design` invoke. Next phase transitions happens automatically, but can be also switched with `/skill:`.

| Phase | Driver skill | What happens |
|-------|-------------|--------------|
| **design** | `/skill:ff-design` | Explores intent + requirements, produces a design document (`{design dir}/{slug}-design.md`, per the design-doc storage setting) — interactive, you review before it advances |
| **plan** | `/skill:ff-plan` | Breaks the design into an ff-implementer-ready task plan (`.ff/task-plans/{slug}-task-plan.md`) |
| **implement** | `/skill:ff-implement` | Works through the task plan in an isolated worktree |
| **verify** | `/skill:ff-verify` | Spawns the ff-feature-verifier subagent, then runs build / lint / tests |
| **review** | `/skill:ff-review` | Dispatches parallel specialized reviewers (or a single generalist) over the code; loops per `maxFeatureReviewRounds` setting |
| **UAT** | `/ff:next` | To transition to UAT phase in case no longer want to continue review-iterations, as UAT does not have skill to activate it via `/skill:` |
| **finish** | `/skill:ff-finish` | Presents merge / PR / keep / discard options and cleans up |

The widget in the TUI status bar shows live progress — workflow phases, auto-agent state, and feature ID + name. Task progress is shown by the separate `avtc-pi-todo` widget.

![widget](assets/images/widget.png)

The implementation phase runs in one of three modes, set by the `implementMode` setting: `current-session` (the agent implements in the main session, checkpointed), `subagent-driven` (a fresh subagent implements each task), or `subagent-driven-fork` (a subagent forked from your session's context implements each task).

### Design + plan review loops

The design and plan phases each self-review before advancing: the extension runs dedicated review passes (`ff-design-review`, `ff-plan-review`) and fixes the findings, repeating for the configured number of rounds. This catches gaps and inconsistencies before implementation begins, so the downstream phases start from a reviewed design and plan.

## Kanban + Auto-Agents

The kanban board is optional. A single feature needs none of it — you run `/skill:ff-design` and the pipeline carries it to UAT. The kanban is for working on **many features in parallel**: you queue several designs, and auto-agents route them through the pipeline concurrently. An auto-designer runs design-reviews on queued designs (features land in the *design-approval* lane when ready), while each auto-worker takes one feature from the *ready* lane and drives it through task-plan, implementation, and code-review loops to UAT. Features live in lanes and move through them as work progresses.

![kanban board](assets/images/kanban-board.png)

> **Status:** worktree isolation is tested within a single repo; the auto-agent's switch to another feature when blocked by the user is **not yet tested**. Worktree mode targets one repo only — cross-repo changes (multiple repos, submodules, or sibling repos touched in one feature) are not supported. Single-session implementation remains the fully tested path.

| Command | What it does |
|---------|--------------|
| `/ff:kanban` | Open the kanban board in a browser (starts the HTTP server if needed) |
| `/ff:auto-agent` | Start the autonomous loop — picks features from both design and ready lanes |
| `/ff:auto-worker` | Autonomous loop, ready lane only |
| `/ff:auto-designer` | Autonomous loop, design lane only |
| `/ff:auto-pause` | Pause the auto-loop (keeps the current feature, heartbeat alive) |
| `/ff:auto-stop` | Stop the auto-agent and resume interactive control (detaches the auto-agent, no re-dispatch) |
| `/ff:kanban-release` | Release a feature lock so others can pick it up |

A queued backlog plus `/ff:auto-agent` lets the harness chew through features on its own, with verification and review gates still enforced.

## Tools

| Tool | Description |
|------|-------------|
| `phase_ready` | Signal phase completion + trigger the next-phase handoff |
| `task_ready_advance` | Start a task, advance to the next, or finish implementation (per-task gate dispatch) |
| `add_to_backlog` | Add a new feature to the kanban backlog |

## Commands

| Command | Description |
|---------|------------|
| `/ff:next` | Manual command to advance to next phase, expected to be used to advance from `uat` to `finish`, as other phases can be activated by invoking the skill related to phase |
| `/ff:reset` | Turn-off the workflow |
| `/ff:resume` | List active workflows and load the selected one into the current session |
| `/ff:settings` | Open the settings UI |
| `/ff:archive-artifacts <days>` | Archive old workflow artifacts (older than `<days>` days) out of your way; asks before moving anything |
| `/ff:archive-designs <days>` | Archive old design docs (older than `<days>` days) from both `.ff/designs` and `docs/ff/designs`; asks before moving anything |

## Skills

9 skills covering the pipeline phases, the design/plan review loops, and research:

- **Phase drivers** — `ff-design`, `ff-plan`, `ff-implement`, `ff-verify`, `ff-review`, `ff-finish`
- **Review-iteration drivers** — `ff-design-review`, `ff-plan-review` (single-iteration passes re-dispatched per the configured loop count)
- **Research** — `ff-research` (deep code analysis for investigation tasks)

Invoke any with `/skill:<name>`.

## Named Subagents

14 specialized agent profiles dispatched automatically by the review and verify skills (you don't invoke them directly):

- **Reviewers** — `ff-general-reviewer`, `ff-design-reviewer`, `ff-plan-reviewer`, `ff-guidelines-reviewer`, `ff-quality-reviewer`, `ff-security-reviewer`, `ff-performance-reviewer`, `ff-requirements-reviewer`, `ff-testing-reviewer`
- **Verifiers** — `ff-feature-verifier`, `ff-plan-verifier`, `ff-task-verifier`
- **Utilities** — `ff-researcher`, `ff-implementer`

Dispatched via [`avtc-pi-subagent`](https://github.com/avtc/avtc-pi-subagent).

## Artifacts

- **Design docs** — `docs/ff/designs/` or `.ff/designs/` per the `designDocStorage` setting.
- **Task plans, research, reviews** — stored out-of-repo under a `.ff/` junction (see below)

### The `.ff/` junction

Plans, research, and review artifacts are kept out of git (they're process artifacts, not source). Feature-flow creates a gitignored `.ff/` link at project init that points to a stable, project-keyed external location (`~/.pi/feature-flow/<project>/`). All worktrees of the project share that one store, so artifacts survive worktree removal.

## Configuration

The `/ff:settings` command opens a tabbed modal covering every setting — workflow behavior, review-loop counts, branch policy, feature review mode, inter-task compaction, model overrides, and more:

![settings modal](assets/images/settings.png)

![settings dropdown](assets/images/settings-dropdown.png)

Workflow settings (workflow behavior, review-loop counts, branch policy, feature review mode, inter-task context compaction) live in `avtc-pi-feature-flow-settings.json` (`~/.pi/agent/` global, `<cwd>/.pi/` project overrides) and are edited via `/ff:settings`. **Model routing per phase** is configured separately in pi's shared `~/.pi/agent/settings.json` under the `"avtc-pi-feature-flow"` key. See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full reference.

## Attribution

Inspired by [coctostan/pi-superpowers-plus](https://github.com/coctostan/pi-superpowers-plus) and [obra/superpowers](https://github.com/obra/superpowers) (Jesse Vincent).

> Developed with [Z.ai](https://z.ai/subscribe?ic=N5IV4LLOOV) — get 10% off your subscription via this referral link.

## License

MIT

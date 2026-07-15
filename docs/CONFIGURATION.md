# Configuration Reference

avtc-pi-featyard has two configuration mechanisms:

1. **Settings Dialog** — simple scalar settings edited via the `/fy:settings` command
2. **Model Overrides** — per-stage model selection (per-subagent selection is in avtc-pi-subagent) configured in pi's `settings.json`

---

## Settings Dialog

Open with `/fy:settings` in your pi session. Settings are organized into tabs: Workflow, Review, Kanban & Auto-Agent, Limits & Concurrency, Artifacts, Guardrails. Changes apply immediately. Press `Ctrl+S` to save to project settings, `Ctrl+D` to save as global defaults. Use left/right arrow keys to switch tabs.

### Workflow

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `interTaskCompact` | `none`, `compact`, `compact>75K`, `compact>125K`, `compact>200K`, `compact>500K` | `none` | Compact context between tasks in implement phase: none (accumulate), compact (`/compact`, optionally only above a threshold) |
| `implementMode` | `current-session`, `subagent-driven`, `subagent-driven-fork` | `current-session` | How the implementation phase runs: current-session (the agent implements in the main session, checkpointed), subagent-driven (a fresh subagent implements each task), subagent-driven-fork (a subagent forked from your session's context implements each task) |
| `uatMode` | `off`, `after-review`, `after-finish` | `after-review` | User acceptance testing: off (skip UAT), after-review (pause before merge), after-finish (pause after merge) |
| `branchPolicy` | `current-branch`, `worktree` | `current-branch` | Where the agent works: current-branch (pair programming, no isolation) or worktree (autonomous, separate directory). Worktree targets one repo — changes spanning multiple repos, submodules, or sibling repos in a single feature are not supported (all tool paths are rewritten into the worktree) |
| `baseBranch` | `ask`, `main`, `master`, `develop` | `ask` | Base branch for merges. `ask` = prompt when needed |

### Review

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `maxFeatureReviewRounds` | `0`, `1`, `2`, `3`, `5`, `7`, `10` | `7` | Max review-fix cycles in the feature review phase. 0 = skip, N = run up to N rounds (stops early once clean). |
| `featureReviewMode` | `general`, `comprehensive` | `general` | Feature review approach: general (single generalist reviewer) or comprehensive (multiple specialized sub-reviewers). |
| `featureReviewSubagentsMode` | `new`, `fork`, `new+fork` | `new` | How feature review subagents get context: new (fresh session), fork (inherit conversation history), new+fork (both in parallel). |
| `reviewerSkipThreshold` | `0`, `1`, `2` | `2` | Skip reviewers that find no issues for N consecutive loops. 0 = never skip, 1 or 2 = skip after N empty loops |
| `planReviewMode` | `in-session`, `parallel-subagents` | `parallel-subagents` | Plan and design review: in-session (skill loaded in current session) or parallel-subagents (dispatch to subagents) |
| `maxPlanReviewRounds` | `0`, `1`, `2`, `3`, `5`, `10` | `5` | Max review-fix cycles for design and plan phases. 0 = skip, N = run up to N rounds (stops early once clean). |
| `planReviewSubagentsMode` | `new`, `fork`, `new+fork` | `new+fork` | How plan/design review subagents get context |
| `minReviewLoops` | `0`, `1`, `2`, `3` | `0` | Minimum review loops to run regardless of findings. 0 = disabled (default), 2+ = force at least N loops even if no issues found |
| `reviewIterationCompact` | `none`, `compact`, `compact>75K`, `compact>125K`, `compact>200K`, `compact>500K` | `compact>125K` | Compact context between design/plan/code review iterations |
| `maxVerifyRounds` | `1`, `3`, `5` | `3` | Max verify rounds for feature and plan verifiers. 1 = single pass, N = retry if issues found. |
| `verifyPhases` | `off`, `verify`, `plan+verify`, `plan+implement+verify` | `plan+implement+verify` | Which phases get fresh verifier subagents |
| `perTaskReviewMode` | `off`, `general` | `general` | Per-task review during implementation: off (skip) or general (spawn general-reviewer after each task). |
| `maxTaskReviewRounds` | `1`, `2`, `3`, `5`, `10` | `3` | Max verify+review rounds per implementation task (stops early once clean). Disable per-task gating via 'Verification phases' (exclude implement) and 'Per-task review mode' (off). |

### Kanban & Auto-Agent

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `autoPollMs` | `10s`, `30s`, `1m`, `2m` | `30s` | How often the auto-agent polls for new features when none are available |
| `autoOnBlock` | `wait`, `switch` | `switch` | What the auto-agent does when blocked: wait (keep polling) or switch (pick another feature) |
| `autoLockTimeoutMs` | `1m`, `5m`, `10m`, `30m` | `30m` | How long before a feature lock expires if no heartbeat |
| `autoWorkerWaitTimeoutMs` | `Infinite`, `10m`, `30m`, `1h` | `Infinite` | Max time the auto-worker waits for a blocked feature |
| `autoDesignerWaitTimeoutMs` | `Infinite`, `10m`, `30m`, `1h` | `Infinite` | Max time the auto-designer waits for a blocked feature |
| `designApprovalEnabled` | `true`, `false` | `true` | Require human approval in the design-approval lane before the agent can pick the feature |
| `kanbanDoneHideAfterMs` | `Always`, `Never`, `1d`, `7d`, `30d` | `Never` | Hide done features from the board after this duration |

### Limits & Concurrency

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `researcherMinInstances` | `0`, `1`, `3`, `5` | `1` | Minimum researcher subagents per research phase. `0` = research optional |
| `researcherMaxInstances` | `1`, `3`, `5`, `10` | `3` | Maximum researcher subagents that can run in parallel per research phase |
| `nestedResearchers` | `off`, `on` | `on` | Allow researcher subagents to spawn nested researchers |

### Guardrails

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `testingDiscipline` | `tdd-strict`, `tdd-advisory`, `off` | `tdd-advisory` | TDD enforcement: tdd-strict (block violations), tdd-advisory (warn only), off |
| `preCommitDiscipline` | `off`, `advisory`, `strict` | `advisory` | Pre-commit verification gate. `strict` = block without verification, `advisory` = warn, `off` = no check. Checks staged source files for test coverage and requires prior test verification |

### Artifacts

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `designDocStorage` | `local`, `committed` | `local` | `local` (`.featyard/designs/`, out-of-repo, gitignored) or `committed` (`docs/featyard/designs/`, tracked in git) |
| `autoArchiveArtifactsOlderThanDays` | `7`, `14`, `30`, `90` | `30` | Background sweep relocates artifact groups (reviews/research/task-plans/feature-state) whose newest file is older than this many days into `artifacts-archive/`. Runs once on start then every 24h. Keep ≥ 1 |
| `autoArchiveDesignsOlderThanDays` | `Never`, `7`, `30`, `90` | `Never` | Background sweep relocates design docs older than this into the archive, sweeping both `.featyard/designs` and `docs/featyard/designs`. `Never` = disabled. Manual sweep via `/fy:archive-designs <days>` |

### Settings Files

Settings are stored as JSON with layered project-overrides-global merging:

- **Global:** `~/.pi/agent/avtc-pi-featyard-settings.json`
- **Project:** `<cwd>/.pi/avtc-pi-featyard-settings.json`

Project settings override global settings.

---

## Model Overrides

Model overrides let you control which LLM model is used for specific workflow stages of the main orchestrating session. This is useful for routing review loops through different models (e.g., cycling between models for diverse perspectives) or using a cheaper/faster model for design. (Per-subagent model selection is configured in the `subagent` section — see [avtc-pi-subagent](https://github.com/avtc/avtc-pi-subagent).)

### Configuration Location

Model overrides are configured in pi's `settings.json` under the `"avtc-pi-featyard"` key:

- **Global:** `~/.pi/agent/settings.json`
- **Project:** `<cwd>/.pi/settings.json` (project overrides global)

### Schema

```json
{
  "avtc-pi-featyard": {
    "default-model": "anthropic/claude-sonnet-4-5",
    "stage-models": {
      "<stage-name>": "anthropic/claude-sonnet-4-5"
    }
  }
}
```

> **Note:** `subagent-models` (per-subagent model overrides) and `subagent.default-model` (the subagent fallback) both live in the `subagent` section — see [avtc-pi-subagent](https://github.com/avtc/avtc-pi-subagent). The `default-model` documented here governs only the **workflow orchestrator** (main session) phase model.

- **`default-model`** (string, optional): Fallback model for workflow phases when no `stage-models` override exists. Format: `"provider/id"`. Example: `"anthropic/claude-sonnet-4-5"`. Project-level value entirely overrides global value (not merged per-key).

Each override value can be either:

- **Single model:** `"anthropic/claude-sonnet-4-5"`
- **Array for round-robin:** `["anthropic/claude-sonnet-4-5", "openai/gpt-4o", "deepseek/deepseek-chat"]`

### Important: Model Override Persists as Pi Default

When a stage model override fires in-session, that model also becomes your **pi default** (persisted to settings). Consequences:

- **New pi sessions** will start on that model.
- **Subagents without an explicit model override** will inherit it.

**To avoid surprises:**

- Set a per-subagent model override in the `subagent` section (see [avtc-pi-subagent](https://github.com/avtc/avtc-pi-subagent)) for any subagent that must use a fixed model.
- After a workflow run, restore your preferred default with `/model`.

---

### Resolution Priority

When multiple overrides could apply, the highest-priority one wins:

**Main session:**

1. **`--model` flag** — highest priority, never overridden
2. **`stage-models[<stage-name>]`** — per-stage override
3. **`default-model`** — fallback when no stage-model exists (lowest priority)

**Subagents:**

Per-subagent model routing is handled entirely by [avtc-pi-subagent](https://github.com/avtc/avtc-pi-subagent) — see its configuration docs for the precedence table and matching rules. Within featyard, `stage-models` and `default-model` apply only to the **main orchestrating session** (see the Main session list above).

### Round-Robin Rotation

When a `stage-models` override is an array, models rotate across review loops:

- **Loop 1** -> `models[0]`
- **Loop 2** -> `models[1]`
- **Loop N** -> `models[N % length]` (wraps around)

Rotation is **per-feature** — each feature's `reviewLoopCount` drives its own rotation independently.

For single-iteration stages (design, plan, implement, verify, finish), only `models[0]` is used.

### Stages

| Stage | Skill | Description |
|-------|-------|-------------|
| `design` | `fy-design` | Idea exploration and design |
| `plan` | `fy-plan` | Implementation plan creation |
| `implement` | `fy-implement` | TDD implementation of plan tasks |
| `verify` | `fy-verify` | Run tests and verify before claiming done |
| `review` | `fy-review` | Code review with loop support (skipped when `maxFeatureReviewRounds: 0`) |
| `finish` | `fy-finish` | Merge, PR, or cleanup |

> `uat` reuses the `fy-review` skill.

### Subagents

| Agent | Used by |
|-------|---------|
| `fy-design-reviewer` | `fy-design-review` skill (design-phase review) |
| `fy-plan-reviewer` | `fy-plan-review` skill (plan-phase review) |
| `fy-plan-verifier` | Plan-phase coverage verification (when `verifyPhases` includes `plan`) |
| `fy-task-verifier` | Per-task verification during implementation |
| `fy-feature-verifier` | `fy-verify` skill (final feature verification) |
| `fy-general-reviewer` | `fy-review` skill (general mode — single generalist reviewer); per-task review (`perTaskReviewMode`) |
| `fy-quality-reviewer` | `fy-review` skill (comprehensive mode) |
| `fy-testing-reviewer` | `fy-review` skill (comprehensive mode) |
| `fy-security-reviewer` | `fy-review` skill (comprehensive mode, when I/O/API/auth involved) |
| `fy-performance-reviewer` | `fy-review` skill (comprehensive mode, when data processing/algorithms involved) |
| `fy-guidelines-reviewer` | `fy-review` skill (comprehensive mode, when project has linting/conventions) |
| `fy-requirements-reviewer` | `fy-review` skill (comprehensive mode, when plan/spec exists to check against) |
| `fy-implementer` | `fy-implement` skill (dispatch modes) |
| `fy-researcher` | `fy-design` / `fy-plan` skills (research phase); nested researcher delegation |

### Examples

**Single model for all reviews:**

```json
{
  "featyard": {
    "stage-models": {
      "review": "anthropic/claude-sonnet-4-5"
    }
  }
}
```

**Round-robin review models (cycles through models across loops):**

```json
{
  "featyard": {
    "stage-models": {
      "review": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o", "deepseek/deepseek-chat"]
    }
  }
}
```

**Per-subagent override (in the `avtc-pi-subagent` section; takes priority over stage-model within avtc-pi-subagent's resolution):**

Per-subagent model overrides are configured in the `avtc-pi-subagent` section, not under `avtc-pi-featyard`. Example (in `settings.json`):

```json
{
  "avtc-pi-subagent": {
    "default-model": "anthropic/claude-sonnet-4-5",
    "subagent-models": {
      "fy-testing-reviewer": "openai/gpt-4o",
      "fy-security-reviewer": "deepseek/deepseek-chat",
      "*-fork": ["openai/gpt-4o", "deepseek/deepseek-chat"]
    }
  },
  "avtc-pi-featyard": {
    "stage-models": { "review": "anthropic/claude-sonnet-4-5" }
  }
}
```

Keys are matched against the agent name by specificity (exact > longest glob). `-fork`-suffixed keys apply to forked sessions (e.g. `fy-plan-reviewer-fork`), and array values rotate per-task. See [avtc-pi-subagent](https://github.com/avtc/avtc-pi-subagent) for matching/rotation details.

**Default model with stage override:**

```json
{
  "featyard": {
    "default-model": "anthropic/claude-sonnet-4-5",
    "stage-models": {
      "review": "openai/gpt-4o"
    }
  }
}
```

All phases without a `stage-models` entry use `default-model`. In this example, design/plan/implement/verify/finish use `anthropic/claude-sonnet-4-5`, while review uses `openai/gpt-4o`.

**Combined with min review loops (in `avtc-pi-featyard-settings.json`):**

```json
{
  "maxFeatureReviewRounds": 7,
  "minReviewLoops": 2,
  "featureReviewMode": "comprehensive"
}
```

This ensures at least 2 review loops run (even if loop 1 finds no issues), up to a maximum of 7, using comprehensive review with parallel subagents — and the review stage uses round-robin model rotation if configured. (Values are stored as numbers; `maxFeatureReviewRounds: 0` skips auto-review.)

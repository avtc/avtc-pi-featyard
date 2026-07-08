---
name: ff-design
description: "Run before any feature or behavior-changing work begins: research the codebase, settle the design with the user, and write the design document the planning and implementation phases follow."
disable-model-invocation: true
---

# Designing a Feature
Investigate the codebase before asking anything. Drive the design as a dialogue — one focused question per turn, one section at a time, each section confirmed before the next.

> The document is a **specification, not a plan.** It states WHAT the feature achieves, HOW it integrates with the existing system, and HOW it affects every area it touches — in enough detail that planning only has to *sequence* the work, not *decide* it. If you drift into step-by-step build instructions, pull back to the contract.

## Scope of action
- Read source code and documentation.
- Write design documents to `{{PI_FF_DESIGN_RELATIVE_DIR}}/`.
- Read from `.ff/research/`.
- Dispatch ff-researcher subagents.
- Modify no other files.

## Before you start
- Run `git status` and the recent-commit log before any design work. If the branch already carries uncommitted or unmerged work, surface it and ask the user how to proceed: finish that work first, stash it, or continue here. The user picks the base branch.
- Check AGENTS.md/CLAUDE.md for requirements to address during design.

## Frame the Goal
- Ground every later decision in the codebase's present state: read the relevant files, docs, and recent history before deciding.
- Before designing anything new, search the codebase and its ecosystem for an existing solution. Reuse it when the approach is sound; do not perpetuate a wrong architecture — judge the existing design before building on it.
- When the feature hooks into existing control flow, read the full target function and enumerate every branch; specify how the feature applies to each. Ask before proceeding if behavior is unclear.
- Drive the conversation with one question per turn; offer multiple-choice options when possible. Aim each question at the purpose, the hard constraints, and what counts as done.
- **Lock the evaluation criteria now:** the purpose, constraints, and success criteria are the yardstick every approach is measured against — write them down explicitly. Separate hard constraints (must do / must not break) from soft preferences (nice to optimize).
- If the change seems trivial after understanding: ask whether to create a design doc (reviews/verification catch side-effects), or `/ff:reset` + implement directly + `/skill:ff-review` after.

## Ideation
Strong design is two moves — diverge, then converge. The common failure is committing to the first plausible idea.
- **Diverge first:** generate genuinely distinct *architectures* — where the logic lives, what owns what, what flows where — not the same design relabeled or merely split into files. Make each sharp enough to name; if two answer "what it makes easy / hard" the same way, they are still one — keep diverging.
- **Converge against the locked criteria:** score *each* option against *each* criterion (the locked criteria plus coupling, blast radius, testability, behavior-change scope, reversibility) — not pros for your favorite and cons for the rest.
- Lead with the recommendation; justify it against the **runner-up** — name the closest alternative and why the pick wins for this codebase. If you can't articulate why the runner-up loses, you don't yet know enough to recommend.
- Stress-test: where does it break under failure, concurrency, or scale? Which plausible future change or existing component does it fight? Re-open the choice if later research invalidates an assumption it rested on.

## Deep investigation
Use ff-researcher subagents for any question about code behavior, dependencies, or call chains. They run in isolated context and trace deep call chains without crowding your conversation. Spawn {{PI_FF_RESEARCHER_MIN}}-{{PI_FF_RESEARCHER_MAX}} per question, scaled to scope.

- **Initial exploration** before writing: survey relevant code areas. Output `{{PI_FF_RESEARCH_DIR}}/{{PI_FF_FEATURE_SLUG}}-design-initial-agent-{N}.md`.
- **Per-section deep dive** before each section: trace the code it affects. Output `{{PI_FF_RESEARCH_DIR}}/{{PI_FF_FEATURE_SLUG}}-design-section-{sectionNumber}-agent-{N}.md`.
- **On-demand** whenever a codebase question arises during conversation.
- **Locate every integration point:** all callers of functions you change, all readers/writers of data you change, all subscribers to events or signals you change, and any code that pattern-matches (by name, type, or string) on something you alter. An integration point first found during planning or review is a gap this phase closed.
- **Map the blast radius:** every area the change touches — callers, callees, consumers of the data/state, shared state, types/schemas, config, persistence, tests, docs, scripts, tooling — and the impact type (consumes, produces, breaks, must update). An affected area is anywhere behavior is observable to a caller, consumer, or stored artifact. If you can't yet name them, that's a research gap, not a reason to narrow scope.
- **Trace control-flow and data-flow end to end:** control from invocation to termination (early returns, errors, async completion); data from each value's origin through every transformation to its sink. Every place they cross a boundary is where a contract must be defined.
- **Stock the solution space, not just the status quo:** have ff-researchers surface other ways this problem (or an analogous one) is already solved — in this codebase, dependencies, or the ecosystem. Prior art is a candidate approach to evaluate, not background reading.
- **Depth rules:** trace to root cause, not symptoms; understand the mechanism before changing it; check history (git blame, docs, prior decisions) before changing established patterns; separate investigation from design (answer with facts; propose changes only when asked).
- **Sufficiency loop:** after each report, ask what new questions arose, what stays uncertain, what needs another angle, what blocks a decision; spawn more ff-researchers until no new questions arise and the picture is fully explored. If a ff-researcher fails: retry once narrower, else proceed and note the gap.

**Anti-patterns — do NOT:**
- Read a file or two, form a surface impression, and proceed. Spawn a ff-researcher.
- Describe the existing state as optimal. Ask "is there a better way?" before preserving it.
- Propose the weakest enforcement. For safety/correctness, propose code-level enforcement, not instruction-based self-restraint.
- Change form without changing structure. Renaming/reorganizing/splitting is not improvement — redesign the architecture first.
- Accept coupling as necessary because it exists. Ask "architectural or accidental?"
- State assumptions as facts. When uncertain, flag "needs investigation".

```ts
subagent({
  tasks: [{ agent: "ff-researcher", task: "<what to investigate and where to write findings>" }]
})
```

## Architecture
{{PI_FF_ARCHITECTURE_PRINCIPLES}}
- Specify what must be covered: critical paths, edge cases, and regressions, so implementation and verification know the target.

## Present the design
- Build the design document one numbered section at a time. Show each section in chat and get explicit approval before writing it to the file.
- **NEVER write to `{{PI_FF_DESIGN_DOC_PATH}}` before user approval.** The `<!-- approved -->` marker is added only after the user confirms. Once approved, append via `edit`.
- The design doc is the permanent knowledge base; research reports are working notes. Summarize key findings with a link to the report; do not copy reports verbatim.
- **Every section includes:** Current state (mechanism traced during research); Proposed change (what & why); Constraints & edge cases; Uncertainties; Rejected alternatives (brief).
- **Make the architectural decisions explicit per section** — these are spec, not for planning to invent:
  - **Failure modes** — what can fail, how it fails (exception, default, no-op, degraded mode), and how the failure is bounded so it cannot cascade.
  - **Backwards compatibility** — which callers, consumers, persisted data, configs, or running instances rely on current behavior; whether the change preserves, migrates, or breaks each; if it breaks, the migration and who is affected.
  - **State & data migration** — if stored state, schema, or format changes: how existing data transitions, and what happens to data that doesn't fit.
  - **Concurrency, ordering & lifecycle** — if the feature involves shared state, background work, or startup/shutdown interleaving: the ordering guarantees and the races that cannot occur.
- **Scenario enumeration:** for each component or integration point, specify behavior for the normal case, each error type, boundary conditions, and interaction with other components. Each scenario must be concrete enough to act as ground truth — if it leaves a real choice open, resolve it or raise it as an unresolved decision. This prevents the most common review finding: "the design doesn't say what happens when X."
- **Define every behavioral change as what / where / new-behavior:** WHERE (file, module, integration point), WHAT changes, and the NEW behavior — how it differs from current and how an observer detects the difference. Cover the normal path AND every error/failure/boundary path.
- **Treat Uncertainties as work items to close:** the user is consulted here, so resolve each in design via targeted research, history/docs, or surfacing it to the user — never defer one to a later phase. One that survives every attempt is a genuine open question — escalate it explicitly; don't let it quietly become a gap.
- **Every factual claim is traceable** to evidence — a cited research report or a specific file/location you read. A claim resting on assumption is not yet a fact; flag it for investigation.
- **State acceptance criteria:** the testable conditions that define done — what must be true or observable for the feature to be considered complete. These feed verification.
- **Give each architectural decision a stable reference** (e.g. D1, D2) so the document and later phases can cite it ("amends D3", "see D7") and verification can check each one. (Distinct from numbering *sections* — this is decision traceability.)
- **If the change spans independently-shippable components** (packages, services, repos), state the ordering / deployment dependency between them and which side lands first.
- **If the feature has user- or operator-visible state or failures**, specify how they surface (status, logs, error reporting) and how the user knows it is working — or that it failed.
- Favor designs that are cheap to verify: sharp boundaries, few hidden dependencies, behavior you can assert directly.
- Use the `todo` tools to track planned work for preparing the design document. The todo list survives context compaction — every item needs comprehensive details (step-by-step instructions and references to docs, sections, or file paths).
- **Record all user decisions** into the doc's "Appendix: User Decisions" immediately after each decision (do not batch). Each entry: decision, rationale, implication. Do not defer without explicit user approval.

## Completeness — the done-condition
Do not declare the design complete until every one passes; state the passing audit before stopping:
- Every user decision captured, with rationale and implication.
- Every open question resolved — none left dangling.
- Every codebase research the design depends on — done and cited.
- Every affected area from the blast-radius map — covered in detail.
- Every behavioral change — defined as what / where / new-behavior.
- Every rejected alternative — recorded with the decisive reason.

**Re-read the document as a stranger:** planning will break it into steps and review will audit the build against it; both read what is written, not what you intended. Re-read end-to-end once and fix any missing step, undefined behavior, or uncovered area first.

## When the user corrects you
When the user corrects you, revise to match the correction and confirm your understanding before continuing. If still uncertain, investigate with a ff-researcher — do not guess.

## Hand-off
- {{PI_FF_DESIGN_HANDOFF}}
- Do NOT run design review — the extension handles it automatically.
- Do NOT start implementing.

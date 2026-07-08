// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Feature Flow settings schema.
 *
 * Defines all 36 settings, 5 tab groups, file paths, and validation rules.
 * This single schema replaces SETTING_TYPE, SETTING_DESCRIPTIONS, buildTabGroups,
 * normalizeSettings, applySetting, and loadSettingsFromFiles from the
 * original monolithic settings.ts.
 */

import type { SettingSchema, SettingsSchema } from "avtc-pi-settings-ui";
import { settingsFilePaths } from "avtc-pi-settings-ui";

// ---------------------------------------------------------------------------
// Value arrays
// ---------------------------------------------------------------------------

const COMPACT_RESET_BASE_VALUES = [
  "none",
  "compact",
  "compact>75K",
  "compact>125K",
  "compact>200K",
  "compact>500K",
] as const;

// Preset pairs (label → value). Array order is the display order.

const AUTO_POLL_PRESETS = [
  ["10s", 10_000],
  ["30s", 30_000],
  ["1m", 60_000],
  ["2m", 120_000],
] as const;

const AUTO_LOCK_PRESETS = [
  ["1m", 60_000],
  ["5m", 300_000],
  ["10m", 600_000],
  ["30m", 1_800_000],
] as const;

const AUTO_WAIT_PRESETS = [
  ["Infinite", null],
  ["10m", 600_000],
  ["30m", 1_800_000],
  ["1h", 3_600_000],
] as const;

const KANBAN_DONE_PRESETS = [
  ["Always", 0],
  ["Never", null],
  ["1d", 86_400_000],
  ["7d", 604_800_000],
  ["30d", 2_592_000_000],
] as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Build an auto-agent wait-timeout setting (worker or designer). Both roles share the same presets — only id/label/description differ. */
function makeAutoWaitTimeoutSetting(role: "worker" | "designer"): SettingSchema {
  const id = role === "worker" ? "autoWorkerWaitTimeoutMs" : "autoDesignerWaitTimeoutMs";
  const label = role === "worker" ? "Worker wait timeout" : "Designer wait timeout";
  return {
    id,
    label,
    description: `Max time auto-${role} waits for blocked feature. Infinite = no limit.`,
    type: "duration",
    defaultValue: null,
    // min:1 guards the re-arming wait timer — a 0/negative value spins setTimeout(fn, 0) when
    // autoOnBlock=wait restarts the timer on each expiry.
    min: 1,
    presets: AUTO_WAIT_PRESETS,
  };
}

export const FEATURE_FLOW_SCHEMA: SettingsSchema = {
  ...settingsFilePaths("avtc-pi-feature-flow"),

  settings: [
    // ── Workflow tab ──────────────────────────────────────────────────
    {
      id: "interTaskCompact",
      label: "Inter-task compact",
      description: "Compact context between tasks in implement phase",
      type: "compact-threshold",
      defaultValue: "none",
      presets: COMPACT_RESET_BASE_VALUES,
    },
    {
      id: "implementMode",
      label: "Implement mode",
      description:
        "How the implementation phase runs: current-session (the agent implements in the main session, checkpointed), subagent-driven (a fresh subagent implements each task), subagent-driven-fork (a subagent forked from your session's context implements each task)",
      type: "string",
      defaultValue: "current-session",
      presets: ["current-session", "subagent-driven", "subagent-driven-fork"],
    },
    {
      id: "uatMode",
      label: "UAT mode",
      description:
        "User acceptance testing: off (skip UAT), after-review (pause before merge), after-finish (pause after merge)",
      type: "string",
      defaultValue: "after-review",
      presets: ["off", "after-review", "after-finish"],
    },
    {
      id: "branchPolicy",
      label: "Branch policy",
      description:
        "Where the agent works: current-branch (pair programming, no isolation) or worktree (autonomous, separate directory)",
      type: "string",
      defaultValue: "current-branch",
      presets: ["current-branch", "worktree"],
    },
    {
      id: "baseBranch",
      label: "Base branch",
      description: "Base branch for merges. ask = prompt when needed.",
      type: "string",
      defaultValue: null,
      presets: [
        ["ask", null],
        ["main", "main"],
        ["master", "master"],
        ["develop", "develop"],
      ],
    },
    {
      // Age threshold (days) for the background artifact sweep. The newest-file mtime
      // of an artifact group older than this is relocated to artifacts-archive/. Default 30d.
      id: "autoArchiveArtifactsOlderThanDays",
      label: "Auto-archive artifacts older than (days)",
      description:
        "Background sweep relocates artifact groups (reviews/research/task-plans/feature-state) whose newest file is older than this many days into artifacts-archive/. Runs once on start then every 24h.",
      type: "number",
      defaultValue: 30,
      min: 1,
      presets: [7, 14, 30, 90],
    },
    {
      id: "designDocStorage",
      label: "Design doc storage",
      description:
        "Where design docs live: local (.ff/designs/, out-of-repo and gitignored — not committed) or committed (docs/ff/designs/, tracked in git).",
      type: "string",
      defaultValue: "local",
      presets: ["local", "committed"],
    },
    {
      // Age threshold (days) for the background design-doc sweep. Null = disabled (Never).
      // Sweeps both .ff/designs and docs/ff/designs; manual on-demand via /ff:archive-designs <days>.
      id: "autoArchiveDesignsOlderThanDays",
      label: "Auto-archive designs older than (days)",
      description:
        "Background sweep relocates design docs older than this into the archive, sweeping both .ff/designs and docs/ff/designs. Never = disabled. Manual sweep via /ff:archive-designs <days>.",
      type: "number",
      defaultValue: null,
      min: 1,
      presets: [["Never", null], 7, 30, 90],
    },
    // ── Review tab ────────────────────────────────────────────────────
    {
      id: "maxFeatureReviewRounds",
      label: "Feature review rounds",
      description:
        "Max review-fix cycles in the feature review phase. 0 = skip, N = run up to N rounds (stops early once clean).",
      type: "number",
      defaultValue: 7,
      min: 0,
      presets: [0, 1, 2, 3, 5, 7, 10],
    },
    {
      id: "featureReviewMode",
      label: "Feature review mode",
      description:
        "Feature review approach: general (single generalist reviewer) or comprehensive (multiple specialized sub-reviewers).",
      type: "string",
      defaultValue: "general",
      presets: ["general", "comprehensive"],
    },
    {
      id: "featureReviewSubagentsMode",
      label: "Feature review subagents mode",
      description:
        "How feature review subagents get context: new (fresh session), fork (inherit conversation history), new+fork (both in parallel).",
      type: "string",
      defaultValue: "new",
      presets: ["new", "fork", "new+fork"],
    },
    {
      id: "reviewerSkipThreshold",
      label: "Reviewer skip threshold",
      description:
        "Skip reviewers that find no issues for N consecutive loops. 0 = never skip, 1 or 2 = skip after N empty loops.",
      type: "number",
      defaultValue: 2,
      min: 0,
      presets: [0, 1, 2],
    },
    {
      id: "planReviewMode",
      label: "Plan review mode",
      description:
        "Plan and design review: in-session (skill loaded in current session) or parallel-subagents (dispatch to subagents)",
      type: "string",
      defaultValue: "parallel-subagents",
      presets: ["in-session", "parallel-subagents"],
    },
    {
      id: "maxPlanReviewRounds",
      label: "Plan review rounds",
      description:
        "Max review-fix cycles for design and plan phases. 0 = skip, N = run up to N rounds (stops early once clean).",
      type: "number",
      defaultValue: 5,
      min: 0,
      presets: [0, 1, 2, 3, 5, 10],
    },
    {
      id: "planReviewSubagentsMode",
      label: "Plan review subagents mode",
      description:
        "How plan/design review subagents get context: new (fresh session), fork (inherit conversation history), new+fork (both in parallel)",
      type: "string",
      defaultValue: "new+fork",
      presets: ["new", "fork", "new+fork"],
    },
    {
      id: "minReviewLoops",
      label: "Min review loops",
      description:
        "Minimum review loops to run regardless of findings. 0 = disabled (default), 2+ = force at least N loops even if no issues found.",
      type: "number",
      defaultValue: 0,
      min: 0,
      presets: [0, 1, 2, 3],
    },
    {
      id: "reviewIterationCompact",
      label: "Review iteration compact",
      description:
        "Compact context between design/plan/code review iterations: none (accumulate), compact (/compact), compact>NK (only if context exceeds threshold)",
      type: "compact-threshold",
      defaultValue: "compact>125K",
      presets: COMPACT_RESET_BASE_VALUES,
    },
    {
      id: "maxVerifyRounds",
      label: "Verification rounds",
      description: "Max verify rounds for feature and plan verifiers. 1 = single pass, N = retry if issues found.",
      type: "number",
      defaultValue: 3,
      min: 1,
      presets: [1, 3, 5],
    },
    {
      id: "verifyPhases",
      label: "Verification phases",
      description:
        "Which phases get fresh verifier subagents: off (disabled), verify (final verify only), plan+verify (plan and verify), plan+implement+verify (all three)",
      type: "string",
      defaultValue: "plan+implement+verify",
      presets: ["off", "verify", "plan+verify", "plan+implement+verify"],
    },
    {
      id: "perTaskReviewMode",
      label: "Per-task review mode",
      description:
        "Per-task review during implementation: off (skip) or general (spawn general-reviewer after each task).",
      type: "string",
      defaultValue: "general",
      presets: ["off", "general"],
    },
    {
      id: "maxTaskReviewRounds",
      label: "Per-task review rounds",
      description:
        "Max verify+review rounds per implementation task (stops early once clean). Disable per-task gating via 'Verification phases' (exclude implement) and 'Per-task review mode' (off).",
      type: "number",
      defaultValue: 3,
      min: 1,
      presets: [1, 2, 3, 5, 10],
    },
    // ── Kanban & Auto-Agent tab ───────────────────────────────────────
    {
      id: "autoPollMs",
      label: "Polling interval",
      description: "How often the auto-agent polls for new features when none are available (default: 30s)",
      type: "duration",
      defaultValue: 30_000,
      // min:1 guards the re-arming polling timer — a 0/negative value spins setTimeout(fn, 0) as
      // each poll re-arms the next.
      min: 1,
      presets: AUTO_POLL_PRESETS,
    },
    {
      id: "autoOnBlock",
      label: "On block behavior",
      description: "What the auto-agent does when blocked: wait (keep polling) or switch (pick another feature)",
      type: "string",
      defaultValue: "switch",
      presets: ["wait", "switch"],
    },
    {
      id: "autoLockTimeoutMs",
      label: "Lock timeout",
      description: "How long before a feature lock expires if no heartbeat (default: 30m)",
      type: "duration",
      defaultValue: 1_800_000,
      // min:1 guards the lock TTL — a 0 value makes cleanupExpiredLocks(0) reap every lock instantly,
      // defeating the feature-locking mechanism.
      min: 1,
      presets: AUTO_LOCK_PRESETS,
    },
    makeAutoWaitTimeoutSetting("worker"),
    makeAutoWaitTimeoutSetting("designer"),
    {
      id: "designApprovalEnabled",
      label: "Design approval gate",
      description: "Require human approval in design-approval lane before agent can pick the feature",
      type: "boolean",
      defaultValue: true,
      presets: [
        ["true", true],
        ["false", false],
      ],
    },
    {
      id: "kanbanDoneHideAfterMs",
      label: "Hide done after",
      description: "Hide done features from board after this duration. Never = keep them visible.",
      type: "duration",
      defaultValue: null,
      min: 0,
      presets: KANBAN_DONE_PRESETS,
    },
    // ── Limits & Concurrency tab ──────────────────────────────────────
    {
      id: "researcherMinInstances",
      label: "Researcher min instances",
      description: "Minimum researcher subagents per research phase. Set to 0 to make research optional.",
      type: "number",
      defaultValue: 1,
      min: 0,
      presets: [0, 1, 3, 5],
    },
    {
      id: "researcherMaxInstances",
      label: "Researcher max instances",
      description: "Maximum researcher subagents that can run in parallel per research phase.",
      type: "number",
      defaultValue: 3,
      min: 1,
      presets: [1, 3, 5, 10],
    },
    {
      id: "nestedResearchers",
      label: "Nested researchers",
      description:
        "Allow researcher subagents to spawn nested researchers: off (no delegation instructions) or on (include delegation section in skill prompt).",
      type: "string",
      defaultValue: "on",
      presets: ["off", "on"],
    },
    // ── Guardrails tab ────────────────────────────────────────────────
    {
      id: "testingDiscipline",
      label: "Testing discipline",
      description: "TDD enforcement: tdd-strict (block violations), tdd-advisory (warn only), off",
      type: "string",
      defaultValue: "tdd-advisory",
      presets: ["tdd-strict", "tdd-advisory", "off"],
    },
    {
      id: "preCommitDiscipline",
      label: "Pre-commit discipline",
      description:
        "Pre-commit verification: strict (block without verification), advisory (warn only), off. Gate checks staged source files for test coverage and requires prior test verification.",
      type: "string",
      defaultValue: "advisory",
      presets: ["off", "advisory", "strict"],
    },
  ],

  tabs: [
    {
      label: "Workflow",
      settingIds: ["interTaskCompact", "implementMode", "uatMode", "branchPolicy", "baseBranch"],
    },
    {
      label: "Review",
      settingIds: [
        "featureReviewMode",
        "maxFeatureReviewRounds",
        "featureReviewSubagentsMode",
        "planReviewMode",
        "maxPlanReviewRounds",
        "planReviewSubagentsMode",
        "perTaskReviewMode",
        "maxTaskReviewRounds",
        "verifyPhases",
        "maxVerifyRounds",
        "reviewerSkipThreshold",
        "minReviewLoops",
        "reviewIterationCompact",
      ],
    },
    {
      label: "Kanban & Auto-Agent",
      settingIds: [
        "autoPollMs",
        "autoOnBlock",
        "autoLockTimeoutMs",
        "autoWorkerWaitTimeoutMs",
        "autoDesignerWaitTimeoutMs",
        "designApprovalEnabled",
        "kanbanDoneHideAfterMs",
      ],
    },
    {
      label: "Limits & Concurrency",
      settingIds: ["researcherMinInstances", "researcherMaxInstances", "nestedResearchers"],
    },
    {
      label: "Artifacts",
      settingIds: ["designDocStorage", "autoArchiveArtifactsOlderThanDays", "autoArchiveDesignsOlderThanDays"],
    },
    { label: "Guardrails", settingIds: ["testingDiscipline", "preCommitDiscipline"] },
  ],
};

/**
 * Clamp inter-field constraints after normalization.
 */
export function clampFeatureFlowSettings(result: Record<string, unknown>): void {
  if (
    typeof result.researcherMinInstances === "number" &&
    typeof result.researcherMaxInstances === "number" &&
    result.researcherMinInstances > result.researcherMaxInstances
  ) {
    result.researcherMinInstances = result.researcherMaxInstances;
  }
}

/** Parse a context reset value like 'none', 'compact', 'compact>75K' into mode + threshold. */
export function parseContextCompactValue(value: string): { mode: string; threshold: number | null } {
  if (!value.includes(">")) return { mode: value, threshold: null };
  const [mode, thresholdStr] = value.split(">");
  const match = thresholdStr?.match(/^(\d+)K$/);
  if (!match) return { mode: value, threshold: null };
  return { mode, threshold: parseInt(match[1], 10) * 1000 };
}

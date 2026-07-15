// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Guardrails module — per-tool gating logic for tool_call + tool_result events.
 *
 * The pi.on event registration lives in events/tool/ (tool-call.ts, tool-result.ts);
 * this module owns the per-tool logic (onBashCall, onWriteEditCall, onPhaseReadyCall,
 * onTaskReadyAdvanceCall, onReadResult, onWriteEditResult, onBashResult) that those
 * routers dispatch to.
 *
 * Handles TDD enforcement, publish gating, phase write restrictions, pre-commit
 * discipline, `.featyard/` force-add blocking, and review loop tracking.
 *
 * All factory-coupled dependencies are injected via GuardrailsDeps.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { getStagedFiles, PROCESS_CWD } from "../git/git-queries.js";
import { log } from "../log.js";
import { isPhaseActive, WORKFLOW_PHASES } from "../phases/phase-progression.js";
import { getSettings } from "../settings/settings-ui.js";
import type {
  BashResultEvent,
  ICompaction,
  IGuardrails,
  ToolCallDecision,
  ToolResultAdvisory,
} from "../shared/workflow-types.js";
import { type ActivationDeps, activateFromDocWrite } from "../state/feature-activation.js";
import type { FeatureSession, Violation } from "../state/feature-session.js";
import {
  createFeatureState as createFeatureStateFile,
  createFeatureStateFromPlan,
  DESIGN_DOC_DIRS,
  type ExpandSkillCommandFn,
  type FeatureState,
  FY_RESEARCH_DIR,
  FY_REVIEWS_DIR,
  FY_TASK_PLANS_DIR,
  featureSlugFromDesignDoc,
  featureSlugFromPlanDoc,
  recordReviewHistory,
} from "../state/feature-state.js";
import { isSubagentSession } from "../state/state-persistence.js";
import { isPublishAction, PUBLISH_BEFORE_FINISH_REASON, promptPublishGate } from "./completion-gating.js";
import { changeSetCoversSource, isSourceFile } from "./file-classifier.js";
import { checkFeatyardForceAdd, DEFAULT_FS } from "./force-add-guard.js";
import { GuardrailTracker } from "./guardrail-tracker.js";
import { applyDisciplineGate, formatViolationWarning } from "./guardrail-violations.js";
import { decompose } from "./shell-decompose.js";
import { detectTestOutcome, isTestRun } from "./test-output.js";

/**
 * Factory-coupled dependencies that must be injected from the orchestrator.
 */
/** Dependencies for completion gating and skill command expansion. */
export interface CompletionGateDeps {
  handler: FeatureSession;
  pi: ExtensionAPI;
  expandSkillCommand: ExpandSkillCommandFn;
}

/** Dependencies for verify phase entry and execution mode. */
export interface VerifyPhaseDeps {
  handler: FeatureSession;
  applyExecutionMode: (ctx: ExtensionContext) => Promise<void>;
  expandSkillCommand: ExpandSkillCommandFn;
  applyModelOverrideForPhase: (pi: ExtensionAPI, ctx: ExtensionContext, stage: string) => Promise<void>;
}

/** Dependencies for review loop handling (guardrails-specific callback wrapper). */
export interface GuardrailReviewLoopDeps {
  handler: FeatureSession;
  handleReviewLoopEnd: (
    ctx: ExtensionContext,
    opts: {
      slug: string;
      featureState: FeatureState;
      issuesFound: number;
      cannotFixIssues: number;
      logPrefix: string;
    },
  ) => Promise<void>;
}

/** Dependencies for git operations within guardrails. */
export interface GitGuardrailDeps {
  createGitExec: (
    ctx: ExtensionContext,
  ) => (command: string, options?: { cwd?: string }) => Promise<{ exitCode: number; stdout: string }>;
}

/** Dependencies for feature state management within guardrails. */
export interface FeatureStateGuardrailDeps {
  recoverArtifactsFromDisk: (handler: FeatureSession, data: { featureSlug?: string | null }) => void;
  handleSubFeatureWrite: (
    ctx: ExtensionContext,
    slug: string,
    filePath: string,
    artifactType: "design" | "plan",
    activeSlugForLog: string | null,
  ) => Promise<void>;
}

export interface GuardrailsDeps
  extends CompletionGateDeps,
    VerifyPhaseDeps,
    GuardrailReviewLoopDeps,
    GitGuardrailDeps,
    FeatureStateGuardrailDeps {
  compaction: ICompaction;
}

/**
 * Parse review reports to track which dispatched reviewers found zero issues.
 *
 * Maps reviewer agent names to report categories using the convention:
 * - `fy-quality-reviewer` → category `quality` (strip `fy-` prefix + `-reviewer` suffix)
 * - Legacy `reviewer-quality` → category `quality` (strip `reviewer-` prefix; backward-compat)
 * - Bare names like `quality` → used as-is
 *
 * A reviewer is considered "empty" if the report has no `**Category:** <category>`
 * line matching its mapped category. Empty-loop tracking is used by the
 * compaction module's skip-threshold logic to skip reviewers that have found
 * nothing for consecutive loops.
 *
 * This name-to-category mapping is a contract between:
 * 1. The fy-review skill's SKILL.md (defines reviewer agent names)
 * 2. The review report format (uses `**Category:** <category>` per issue)
 * 3. This function (maps agent name → category to detect empty loops)
 */
/** Build the common prefix for empty-loop tracking log messages. */
function emptyLoopPrefix(slug: string, loop: number, zeroIssues: boolean | undefined): string {
  return `[workflow] Review report for slug=${slug} loop=${loop}${zeroIssues ? " (zero-issues)" : ""}`;
}

/** Load the feature state for the handler's currently-active feature slug. Returns null when there is no active slug or no state file. Returns both slug and state so callers that need the slug downstream (e.g. trackReviewerEmptyLoops) don't re-fetch it. */
function loadActiveFeatureState(handler: FeatureSession): { slug: string; featureState: FeatureState } | null {
  const slug = handler.getActiveFeatureSlug();
  if (!slug) return null;
  const featureState = handler.getActiveFeatureState();
  if (!featureState) return null;
  return { slug, featureState };
}

/** Find the review report file for the given slug and loop number. Returns null if not found. */
async function findReviewReport(reviewsDir: string, slug: string, currentLoop: number): Promise<string | null> {
  try {
    await fs.promises.access(reviewsDir);
  } catch {
    return null;
  }
  const files = await fs.promises.readdir(reviewsDir);
  const reportFiles = files.filter((f) => f.startsWith(`${slug}-review-${currentLoop}`));
  return reportFiles.length > 0 ? path.join(reviewsDir, reportFiles[0]) : null;
}

/** Extract the dispatched reviewers list from report content. Returns null if not parseable. */
function parseDispatchedReviewers(reportContent: string): string[] | null {
  const dispatchedMatch = reportContent.match(/\*\*Reviewers dispatched:\*\* (.+)/);
  if (!dispatchedMatch) return null;
  const reviewers = dispatchedMatch[1]
    .split(", ")
    .map((s: string) => s.trim())
    .filter((s) => s.length > 0);
  return reviewers.length > 0 ? reviewers : null;
}

/** Classify a single reviewer's empty-loop status and update compaction tracker. */
function classifyReviewerEmptyLoop(
  slug: string,
  reviewer: string,
  reportContent: string,
  zeroIssues: boolean | undefined,
  compaction: ICompaction,
): void {
  if (zeroIssues) {
    compaction.incrementEmptyLoop(slug, reviewer);
    return;
  }
  // Derive the review category from the reviewer name. After the fy-* rename, reviewer
  // names are `fy-<category>-reviewer` (e.g. fy-quality-reviewer); the report's `**Category:**`
  // line uses the bare category (e.g. `quality`). Strip BOTH the `fy-` prefix and the `-reviewer`
  // suffix — stripping only `-reviewer` would yield `fy-quality` ≠ `quality` and silently break
  // empty-loop tracking.
  const category = reviewer.startsWith("reviewer-")
    ? reviewer.slice("reviewer-".length)
    : reviewer.endsWith("-reviewer")
      ? reviewer.slice(0, -"-reviewer".length).replace(/^fy-/, "")
      : reviewer.replace(/^fy-/, "");
  const foundIssues = reportContent.includes(`**Category:** ${category}`);
  if (foundIssues) {
    compaction.resetEmptyLoop(slug, reviewer);
  } else {
    compaction.incrementEmptyLoop(slug, reviewer);
  }
}

async function trackReviewerEmptyLoops(opts: {
  slug: string;
  currentLoop: number;
  compaction: ICompaction;
  zeroIssues?: boolean;
}): Promise<void> {
  const { slug, currentLoop, compaction, zeroIssues } = opts;
  const reviewsDir = path.join(process.cwd(), "docs", "reviews", slug);
  try {
    const reportPath = await findReviewReport(reviewsDir, slug, currentLoop);
    if (!reportPath) {
      log.warn(`${emptyLoopPrefix(slug, currentLoop, zeroIssues)} not found, skipping empty-loop tracking`);
      return;
    }
    const reportContent = await fs.promises.readFile(reportPath, "utf-8");
    const dispatchedReviewers = parseDispatchedReviewers(reportContent);
    if (!dispatchedReviewers) {
      log.warn(
        `${emptyLoopPrefix(slug, currentLoop, zeroIssues)} has no 'Reviewers dispatched' line, skipping empty-loop tracking`,
      );
      return;
    }
    for (const reviewer of dispatchedReviewers) {
      classifyReviewerEmptyLoop(slug, reviewer, reportContent, zeroIssues, compaction);
    }
  } catch (err) {
    log.error(
      `${emptyLoopPrefix(slug, currentLoop, zeroIssues)}: failed to read for empty-loop tracking`,
      err instanceof Error ? err.message : err,
    );
  }
}

const COMMIT_RE = /\bgit\s+commit\b/;

function checkPreCommitGate(
  command: string,
  handler: FeatureSession,
): { uncovered: string[]; notVerified: boolean } | null {
  const settings = getSettings();
  if (settings.preCommitDiscipline === "off") return null;

  if (!COMMIT_RE.test(command)) return null;

  const stagedFiles = getStagedFiles(PROCESS_CWD);
  const sourceFiles = stagedFiles.filter((f) => isSourceFile(f));
  if (sourceFiles.length === 0) return null;

  // Coverage check (concern #2): each staged source must have a corresponding
  // test in the SAME staged set (by stem, layout-independent). This is stricter
  // than the old on-disk existence check — a commit must carry the test change —
  // and consistent with the write-time rule (#1). Pre-existing untouched tests
  // do not satisfy it.
  const uncovered = sourceFiles.filter((f) => !changeSetCoversSource(f, stagedFiles));

  const verification = handler.getVerificationState();
  const notVerified = verification === "not-run";

  if (uncovered.length > 0 || notVerified) {
    return { uncovered, notVerified };
  }
  return null;
}

function buildPreCommitWarning(result: { uncovered: string[]; notVerified: boolean }): string {
  const parts: string[] = ["⚠️ PRE-COMMIT GATE:"];
  if (result.uncovered.length > 0) {
    parts.push(`Staged source files lack test files: ${result.uncovered.join(", ")}.`);
  }
  if (result.notVerified) {
    parts.push("Run tests before committing.");
  } else if (result.uncovered.length > 0) {
    parts.push("Write tests before committing.");
  }
  return parts.join(" ");
}

function buildPreCommitBlockReason(result: { uncovered: string[]; notVerified: boolean }): string {
  const parts: string[] = ["Pre-commit gate:"];
  if (result.uncovered.length > 0) {
    parts.push(`staged source files lack test coverage: ${result.uncovered.join(", ")}`);
  }
  if (result.notVerified) {
    parts.push("complete verification checks before committing");
  }
  return parts.join(" ");
}

/**
 * Create the guardrails module with injected dependencies.
 */
export function createGuardrails(deps: GuardrailsDeps): IGuardrails {
  const {
    pi,
    handler,
    compaction,
    applyModelOverrideForPhase,
    handleSubFeatureWrite,
    createGitExec,
    handleReviewLoopEnd,
  } = deps;

  // Activation callbacks for the doc-write activator (git exec + sub-feature writer).
  const activationDeps: ActivationDeps = { createGitExec, handleSubFeatureWrite };

  // --- Mutable state ---
  const pendingViolations = new Map<string, Violation>();
  const pendingPreCommitWarnings = new Map<string, string>();
  const pendingProcessWarnings = new Map<string, string>();

  const guardrailTracker = new GuardrailTracker();
  const maybeEscalate = guardrailTracker.maybeEscalate.bind(guardrailTracker);

  let verifyTestsPassed = false;

  /** Shared activation flow for a design-doc or task-plan-doc write.
   *
   * - ACTIVE feature === slug: recordDoc (caller) already recorded the doc
   *  into the handler's authoritative record — no file I/O (avoids divergence).
   * - No active feature: bootstrap — record the doc on an existing state file, or
   *  create a new one, register it in the kanban (target lane), and activate it.
   * - A DIFFERENT feature is active: treat as a sub-feature write. */
  // --- tool_call handler ---
  /** bash tool_call: fy-force-add block, publish gate, pre-commit discipline. */
  async function onBashCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallDecision> {
    const command = ((event.input as Record<string, unknown>).command as string | undefined) ?? "";

    // Hard-block any `git add -f` that would pull in the `.featyard/` artifact junction
    // (external storage, auto-gitignored). Always active — runs before any workflow
    // state check, so it blocks even when no featyard workflow is active. `.featyard/`
    // must never enter the repo history. See fy-guardrail.ts for path/sweep detection.
    const featyardBlock = checkFeatyardForceAdd(command, PROCESS_CWD, DEFAULT_FS);
    if (featyardBlock) {
      return { block: featyardBlock.reason };
    }

    const state = handler.getWorkflowState();
    const phaseIdx = state?.currentPhase ? WORKFLOW_PHASES.indexOf(state.currentPhase) : -1;
    const implementIdx = WORKFLOW_PHASES.indexOf("implement");
    const subcommands = decompose(command);
    // Publish gate: `git push` / `gh pr create` are blocked until the finish phase.
    // Before finish → hard-block (the human can still push directly via terminal — the
    // gate only sees agent tool calls). In finish → confirm via showSelectWithNote
    // (Allow/Block, default Block; forwarded to the root session for subagents).
    // Commits are NOT gated here — pre-commit discipline (below) owns commits.
    if (state?.currentPhase && isPublishAction(subcommands)) {
      if (state.currentPhase === "finish") {
        const gateResult = await promptPublishGate({ ctx });
        if (gateResult === "blocked") {
          return { block: "Publish cancelled." };
        }
      } else {
        return { block: PUBLISH_BEFORE_FINISH_REASON };
      }
    }

    if (phaseIdx >= implementIdx) {
      const settings = getSettings();
      const preCommitResult = checkPreCommitGate(command, handler);
      if (preCommitResult) {
        const warningReason = buildPreCommitWarning(preCommitResult);
        const blockResult = applyDisciplineGate({
          discipline: settings.preCommitDiscipline,
          blockReason: buildPreCommitBlockReason(preCommitResult),
          warning: warningReason,
          pendingMap: pendingPreCommitWarnings,
          toolCallId: event.toolCallId,
        });
        if (blockResult) return { block: blockResult.reason };
      }
    }
    return {};
  }

  /** write/edit tool_call: TDD check, verify flag reset, phase-write-restriction, doc activation. */
  async function onWriteEditCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallDecision> {
    const toolCallId = event.toolCallId;
    const settings = getSettings();
    const input = event.input as Record<string, unknown>;
    const filePath = input.path as string | undefined;
    if (!filePath) return {};

    // A write/edit to a source file clears the verification credit and triggers
    // the TDD write-order check.
    let changed = false;
    if (isSourceFile(filePath)) {
      handler.recordSourceWrite();
      changed = true; // verification state mutated — router must persist
    }
    const result = handler.checkSourceWriteOrder(filePath);
    if (result) {
      // The only violation kind is the TDD write-order check (source-before-test),
      // which is stateless — nothing to "commit" after allowing the write.
      if (result.type === "source-before-test" && settings.testingDiscipline !== "off") {
        if (settings.testingDiscipline === "tdd-strict") {
          const escalation = await maybeEscalate("tdd-write-order", ctx, `${event.toolName}: ${filePath}`);
          if (escalation === "block") {
            return { block: "TDD write-order violation: write tests before source code (tdd-strict mode)." };
          }
        }
        pendingViolations.set(toolCallId, result);
      }
    }

    const state = handler.getWorkflowState();
    const phase = state?.currentPhase;
    if (
      phase === "verify" &&
      state &&
      isPhaseActive({ currentPhase: state.currentPhase, completedAt: null }, "verify") &&
      isSourceFile(filePath)
    ) {
      verifyTestsPassed = false;
    }
    const isThinkingPhase = phase === "design" || phase === "plan";
    let normalizedForCheck = filePath;
    if (normalizedForCheck.startsWith("./")) normalizedForCheck = normalizedForCheck.slice(2);
    const resolved = path.resolve(process.cwd(), normalizedForCheck);
    // Design docs may live in either recognized dir (committed docs/featyard/designs OR local .featyard/designs);
    // detection/guarding recognize BOTH so docs from either mode count as design-doc writes.
    const designRoots = DESIGN_DOC_DIRS.map((d) => path.join(process.cwd(), d) + path.sep);
    const taskPlansRoot = path.join(process.cwd(), FY_TASK_PLANS_DIR) + path.sep;
    const reviewsRoot = path.join(process.cwd(), FY_REVIEWS_DIR) + path.sep;
    const researchRoot = path.join(process.cwd(), FY_RESEARCH_DIR) + path.sep;
    const isDesignWrite = designRoots.some((root) => resolved.startsWith(root));
    const isTaskPlanWrite = resolved.startsWith(taskPlansRoot);
    const isReviewsWrite = resolved.startsWith(reviewsRoot);
    const isResearchWrite = resolved.startsWith(researchRoot);
    const isAllowedThinkingPhaseWrite = isDesignWrite || isTaskPlanWrite || isReviewsWrite || isResearchWrite;

    if (isThinkingPhase && !isAllowedThinkingPhaseWrite) {
      const escalation = await maybeEscalate("phase-write-restriction", ctx, `${event.toolName}: ${filePath}`);
      if (escalation === "block") {
        return {
          block: `Phase write restriction: during ${phase} phase, only write to docs/featyard/designs/ (or .featyard/designs/), ${FY_TASK_PLANS_DIR}/, ${FY_REVIEWS_DIR}/, or ${FY_RESEARCH_DIR}/.`,
        };
      }

      pendingProcessWarnings.set(
        toolCallId,
        `⚠️ PROCESS VIOLATION: Wrote ${filePath} during ${phase} phase.\n` +
          `During designing/planning you may only write to docs/featyard/designs/ (or .featyard/designs/), ${FY_TASK_PLANS_DIR}/, ${FY_REVIEWS_DIR}/, or ${FY_RESEARCH_DIR}/. Stop and return or advance workflow phases intentionally.`,
      );
    }

    const relativeForTracker =
      isDesignWrite || isTaskPlanWrite ? path.relative(process.cwd(), resolved).replace(/\\/g, "/") : filePath;
    changed = handler.recordDoc(relativeForTracker) || changed;

    // Design / plan doc write detection — shared activation flow (both doc
    // types register a kanban feature: design doc -> "design" lane,
    // task-plan -> "in-progress" lane).
    const designSlug = featureSlugFromDesignDoc(filePath);
    if (designSlug) {
      changed =
        (await activateFromDocWrite(ctx, handler, activationDeps, {
          slug: designSlug,
          filePath,
          artifactType: "design",
          kanbanLane: "design",
          docSlot: {
            getDoc: (s) => s.design.doc,
            setDoc: (s, v) => {
              s.design.doc = v;
            },
          },
          create: createFeatureStateFile,
          postCreate: null,
        })) || changed;
    }

    const planSlug = featureSlugFromPlanDoc(filePath);
    if (planSlug) {
      changed =
        (await activateFromDocWrite(ctx, handler, activationDeps, {
          slug: planSlug,
          filePath,
          artifactType: "plan",
          kanbanLane: "in-progress",
          docSlot: {
            getDoc: (s) => s.plan.doc,
            setDoc: (s, v) => {
              s.plan.doc = v;
            },
          },
          create: createFeatureStateFromPlan,
          postCreate: async () => {
            handler.setCurrentPhase("plan");
            await applyModelOverrideForPhase(pi, ctx, "plan");
          },
        })) || changed;
    }

    return { changed };
  }

  /** phase_ready tool_call: subagent + implement-phase gating. */
  function onPhaseReadyCall(_event: ToolCallEvent): ToolCallDecision {
    if (isSubagentSession()) {
      return { block: "phase_ready is not available in subagent sessions." };
    }
    const phaseReadyWs = handler.getWorkflowState();
    if (phaseReadyWs?.currentPhase === "implement") {
      return {
        block:
          "During implementation, use task_ready_advance to move between tasks, and to advance to verify on the last task (call it with nextTask omitted). phase_ready is not used in implement.",
      };
    }
    return {};
  }

  /** task_ready_advance tool_call: subagent gating. */
  function onTaskReadyAdvanceCall(_event: ToolCallEvent): ToolCallDecision {
    if (isSubagentSession()) {
      return { block: "task_ready_advance is not available in subagent sessions." };
    }
    return {};
  }

  // --- tool_result sub-handlers ---

  /** Handle read tool_result: file path tracking. */
  /** read tool_result: log + record investigation. */
  function onReadResult(event: ToolResultEvent): ToolResultAdvisory {
    const filePath = ((event.input as Record<string, unknown>).path as string) ?? "";
    log.info(`[workflow] tool_result read: path=${filePath}`);
    handler.handleReadOrInvestigation("read", filePath);
    return { warnings: [] };
  }

  /** write/edit tool_result: pending TDD violations + process warnings. */
  function onWriteEditResult(toolCallId: string): ToolResultAdvisory {
    const warnings: string[] = [];
    const violation = pendingViolations.get(toolCallId);
    if (violation) {
      warnings.push(formatViolationWarning(violation));
    }
    pendingViolations.delete(toolCallId);

    const processWarning = pendingProcessWarnings.get(toolCallId);
    if (processWarning) {
      warnings.push(processWarning);
    }
    pendingProcessWarnings.delete(toolCallId);
    return { warnings };
  }

  /** bash tool_result: record test outcome + verify flag, pending pre-commit warning. */
  function onBashResult(event: BashResultEvent, toolCallId: string): ToolResultAdvisory {
    const warnings: string[] = [];
    const command = (event.input.command as string) ?? "";
    const output = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    const exitCode = (event.details as { exitCode?: number })?.exitCode;
    // Parse the bash result here. A test command updates the verification gate;
    // non-test commands leave it untouched.
    const isTestCommand = isTestRun(command);
    const passed = isTestCommand ? detectTestOutcome(output, exitCode) : null;
    let changed = false;
    if (passed !== null) {
      handler.recordTestOutcome(passed);
      changed = true;
    }

    const state = handler.getWorkflowState();
    if (
      isTestCommand &&
      state?.currentPhase === "verify" &&
      state &&
      isPhaseActive({ currentPhase: state.currentPhase, completedAt: null }, "verify")
    ) {
      if (passed === true) {
        verifyTestsPassed = true;
        log.info("[workflow] verify: tests passed, flag set.");
      } else if (passed === false) {
        verifyTestsPassed = false;
      }
    }

    const preCommitWarning = pendingPreCommitWarnings.get(toolCallId);
    if (preCommitWarning) {
      warnings.push(preCommitWarning);
    }
    pendingPreCommitWarnings.delete(toolCallId);
    return { warnings, changed };
  }

  /**
   * Complete a code-review loop from a phase_ready({issuesFound, cannotFix}) call.
   * The issue counts come directly from the fy-review skill. Records review
   * history, tracks reviewer empty loops,
   * then drives the loop decision + (UAT/finish) transition via handleReviewLoopEnd.
   */
  async function completeCodeReviewLoop(
    ctx: ExtensionContext,
    issuesFound: number,
    cannotFixIssues: number,
    falsePositives: number,
  ): Promise<void> {
    const ws = handler.getWorkflowState();
    if (ws?.currentPhase !== "review") return;

    // NOTE: once-per-agent-turn dedup is owned by phase_ready's unified guard
    // (phaseReadyPassed, checked at the top of execute + reset on agent_end).
    // completeCodeReviewLoop is only reached on the first phase_ready this agent
    // turn, so no local guard is needed here.

    const active = loadActiveFeatureState(handler);
    if (!active) return;
    const { slug, featureState } = active;
    const currentLoop = featureState.review.reviewLoopCount ?? 0;

    recordReviewHistory(featureState, {
      phase: "review",
      loopNumber: currentLoop,
      issuesFound,
      falsePositives,
      cannotFixIssues,
    });

    await trackReviewerEmptyLoops({
      slug,
      currentLoop,
      compaction,
      zeroIssues: issuesFound === 0,
    });

    await handleReviewLoopEnd(ctx, {
      slug,
      featureState,
      issuesFound,
      cannotFixIssues,
      logPrefix: issuesFound === 0 ? "review loop ended (zero issues)" : "review loop ended",
    });
  }

  return {
    onBashCall,
    onWriteEditCall,
    onPhaseReadyCall,
    onTaskReadyAdvanceCall,
    onReadResult,
    onWriteEditResult,
    onBashResult,
    setVerifyTestsPassed(passed: boolean) {
      verifyTestsPassed = passed;
    },
    isVerifyTestsPassed() {
      return verifyTestsPassed;
    },
    resetTracking() {
      pendingViolations.clear();
      pendingPreCommitWarnings.clear();
      pendingProcessWarnings.clear();
      guardrailTracker.reset();
      verifyTestsPassed = false;
    },
    completeCodeReviewLoop,
  };
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Template engine: applies {{PI_FF_*}} placeholder substitution to text.
// Pure mechanics (marker scan + handler dispatch); prompt content lives in text-blocks.ts,
// path builders live in state/artifact-paths.ts.

import * as fs from "node:fs";
import * as path from "node:path";

import { log } from "../log.js";
import type { Phase } from "../phases/phase-progression.js";
import { computeReviewMethod, isReviewPhase, toDisplayLoopNumber } from "../review/review-context.js";
import { getSettings } from "../settings/settings-ui.js";
import {
  buildFallbackKnownIssuesPath,
  buildFallbackReportPath,
  buildReportFilePath,
  FF_RESEARCH_DIR,
  FF_TASK_PLANS_DIR,
  resolveDesignRelativeDir,
  resolveKnownIssuesPath,
  slugifyTaskDesignation,
} from "../state/artifact-paths.js";
import { worthNotesPath } from "../state/worth-notes.js";
import {
  ADDITIONAL_AREAS_OF_ATTENTION,
  ARCHITECTURE_PRINCIPLES,
  COMPREHENSIVE_DISPATCH_TEMPLATE,
  COVERAGE_REVIEW_PROCESS,
  DOC_COVERAGE_PROCESS,
  GENERAL_DISPATCH_TEMPLATE,
  IMPLEMENTER_GUIDANCE,
  RESEARCHER_DELEGATION_SECTION,
  VERIFY_PHASE_TEMPLATES,
} from "./text-blocks.js";

/** Default filesystem reference for report path builders. */
export const DEFAULT_FS = fs;

/** Options for placeholder substitution. */
export interface SubstitutePlaceholdersOptions {
  emptyLoops?: Record<string, number>;
  slug?: string;
  loopIndex?: number;
  /** Task number for ff-task-verifier report paths. */
  taskName?: string;
  /** Agent name for deriving report file paths. Includes -fork suffix for fork variants. */
  agentName?: string | null;
  /** LLM-generated topic (short subject name) for fallback report paths when no slug is active. */
  topic?: string;
  /** Base commit SHA captured at execution start. */
  baseCommitSha?: string | null;
  /** Current workflow phase. Drives review-iteration context placeholders. */
  phase?: Phase;
}

/** Context object passed to each placeholder handler. */
interface PlaceholderContext {
  text: string;
  settings: ReturnType<typeof getSettings>;
  opts: SubstitutePlaceholdersOptions;
  /** Computed date string for report file paths. */
  date: string;
}

/** A handler that replaces a placeholder in text. Returns the modified text. */
interface PlaceholderHandler {
  /** Marker string or prefix to pre-scan for. Use full string for exact markers, or prefix ending with ':' for regex-based markers. */
  readonly marker: string;
  /** The replacement handler. */
  handle: (ctx: PlaceholderContext) => string;
}

/** Factory for report file path handlers — all follow the same slug-then-fallback pattern. */
function reportFileHandler(
  marker: string,
  role: string,
  fallbackAgent: string,
  taskPrefixOverride: ((ctx: PlaceholderContext) => string) | null,
): PlaceholderHandler {
  return {
    marker,
    handle(ctx) {
      const prefix = taskPrefixOverride ? taskPrefixOverride(ctx) : role;
      const reportPath = ctx.opts.slug
        ? buildReportFilePath(ctx.opts.slug, prefix, ctx.opts.loopIndex ?? null, DEFAULT_FS)
        : buildFallbackReportPath(ctx.date, ctx.opts.topic ?? prefix, ctx.opts.agentName ?? fallbackAgent, DEFAULT_FS);
      return ctx.text.replaceAll(marker, reportPath);
    },
  };
}

/** Sentinel passed to reportFileHandler when no per-task prefix override is needed. */
const NO_TASK_PREFIX_OVERRIDE: ((ctx: PlaceholderContext) => string) | null = null;

/**
 * Registry of placeholder handlers.
 *
 * No handler produces a {{PI_FF_*}} marker consumed by a later handler — each
 * handler inlines any derived values directly into its output.
 */
const PLACEHOLDER_HANDLERS: PlaceholderHandler[] = [
  // --- Static shared sections ---

  // {{PI_FF_ARCHITECTURE_PRINCIPLES}} — canonical architecture principles (design/plan/ff-implement/ff-implementer)
  {
    marker: "{{PI_FF_ARCHITECTURE_PRINCIPLES}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, ARCHITECTURE_PRINCIPLES);
    },
  },

  // {{PI_FF_ADDITIONAL_AREAS_OF_ATTENTION}} — concerns-to-attend-to checklist (plan + ff-implementer)
  {
    marker: "{{PI_FF_ADDITIONAL_AREAS_OF_ATTENTION}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, ADDITIONAL_AREAS_OF_ATTENTION);
    },
  },

  // {{PI_FF_IMPLEMENTER_GUIDANCE}} — the ff-implementer's full guidance block (ff-implementer.md)
  {
    marker: "{{PI_FF_IMPLEMENTER_GUIDANCE}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, IMPLEMENTER_GUIDANCE);
    },
  },

  // --- Settings-derived instructions ---

  // {{PI_FF_COVERAGE_REVIEW_PROCESS}} — coverage-first skeleton for the code reviewers
  {
    marker: "{{PI_FF_COVERAGE_REVIEW_PROCESS}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, COVERAGE_REVIEW_PROCESS);
    },
  },

  // {{PI_FF_DOC_COVERAGE_PROCESS}} — coverage-first skeleton for the doc reviewers
  {
    marker: "{{PI_FF_DOC_COVERAGE_PROCESS}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, DOC_COVERAGE_PROCESS);
    },
  },

  // {{PI_FF_REVIEWER_DISPATCH}} — includes skip instruction inline
  {
    marker: "{{PI_FF_REVIEWER_DISPATCH}}",
    handle(ctx) {
      const threshold = ctx.settings.reviewerSkipThreshold ?? 0;
      const skipInstruction =
        threshold === 0
          ? "Skipping is disabled — dispatch all relevant reviewers."
          : `Reviewer skip: threshold=${threshold}.`;
      const template =
        ctx.settings.featureReviewMode === "comprehensive"
          ? COMPREHENSIVE_DISPATCH_TEMPLATE
          : GENERAL_DISPATCH_TEMPLATE;
      return ctx.text.replaceAll(this.marker, `${skipInstruction}\n\n${template}`);
    },
  },

  // {{PI_FF_REVIEWER_SKIP}}
  {
    marker: "{{PI_FF_REVIEWER_SKIP}}",
    handle(ctx) {
      const threshold = ctx.settings.reviewerSkipThreshold;
      const emptyLoopsStr = ctx.opts.emptyLoops ? JSON.stringify(ctx.opts.emptyLoops) : "{}";
      const instruction = [
        `Reviewer skip: threshold=${threshold}.`,
        `Empty loop counts: ${emptyLoopsStr}.`,
        threshold === 0
          ? "Skipping is disabled — dispatch all relevant reviewers."
          : `Skip reviewers with empty count >= ${threshold}.`,
      ].join(" ");
      return ctx.text.replaceAll(this.marker, instruction);
    },
  },

  // {{PI_FF_VERIFY_PHASES:<phase>}}
  // Emits the full verifier spawn block with the iteration count inlined directly
  // (no intermediate {{PI_FF_VERIFY_ITERATIONS}} marker is produced).
  {
    marker: "{{PI_FF_VERIFY_PHASES:",
    handle(ctx) {
      const iterations = ctx.settings.maxVerifyRounds ?? 3;
      return ctx.text.replace(/\{\{PI_FF_VERIFY_PHASES:(verify|plan)\}\}/g, (_match, phase: "verify" | "plan") => {
        const phases = ctx.settings.verifyPhases ?? "verify";
        if (phases === "off") return "";
        const phaseList = phases.includes("+") ? phases.split("+") : [phases];
        if (!phaseList.includes(phase)) return "";
        return (VERIFY_PHASE_TEMPLATES[phase] ?? "").replaceAll("{{PI_FF_VERIFY_ITERATIONS}}", String(iterations));
      });
    },
  },

  // --- Report file paths (share lazily-computed date) ---

  reportFileHandler("{{PI_FF_DESIGN_REPORT_FILE}}", "design-review", "design-reviewer", NO_TASK_PREFIX_OVERRIDE),
  reportFileHandler("{{PI_FF_PLAN_REPORT_FILE}}", "plan-review", "plan-reviewer", NO_TASK_PREFIX_OVERRIDE),
  reportFileHandler("{{PI_FF_REVIEW_REPORT_FILE}}", "review", "reviewer", NO_TASK_PREFIX_OVERRIDE),

  // {{PI_FF_REPORT_FILE}} — resolved from: (1) derived from slug+agentName+taskName, (2) date-based fallback
  {
    marker: "{{PI_FF_REPORT_FILE}}",
    handle(ctx) {
      let reportPath: string;
      if (ctx.opts.slug && ctx.opts.agentName) {
        // Include task designation in prefix for per-task review differentiation
        // (e.g. task-3-wire-the-login-form-ff-general-reviewer); slugify for path safety
        const prefix = ctx.opts.taskName
          ? `task-${slugifyTaskDesignation(ctx.opts.taskName)}-${ctx.opts.agentName}`
          : ctx.opts.agentName;
        reportPath = buildReportFilePath(ctx.opts.slug, prefix, ctx.opts.loopIndex ?? null, DEFAULT_FS);
      } else {
        reportPath = buildFallbackReportPath(
          ctx.date,
          ctx.opts.topic ?? "review",
          ctx.opts.agentName ?? undefined,
          DEFAULT_FS,
        );
      }
      return ctx.text.replaceAll(this.marker, reportPath);
    },
  },

  // --- Document paths ---

  // {{PI_FF_DESIGN_DOC_PATH}}
  {
    marker: "{{PI_FF_DESIGN_DOC_PATH}}",
    handle(ctx) {
      const designDir = resolveDesignRelativeDir(getSettings().designDocStorage);
      const docPath = ctx.opts.slug
        ? `${designDir}/${ctx.opts.slug}-design.md`
        : `${designDir}/YYYY-MM-DD-<topic>-design.md`;
      return ctx.text.replaceAll(this.marker, docPath);
    },
  },

  // {{PI_FF_DESIGN_RELATIVE_DIR}} — the relative design-doc directory, resolved from the
  // designDocStorage setting (committed → docs/ff/designs, local → .ff/designs).
  {
    marker: "{{PI_FF_DESIGN_RELATIVE_DIR}}",
    handle(ctx) {
      const designDir = resolveDesignRelativeDir(getSettings().designDocStorage);
      return ctx.text.replaceAll(this.marker, designDir);
    },
  },

  // {{PI_FF_DESIGN_HANDOFF}} — the design-phase hand-off step, parameterized by designDocStorage:
  // committed docs are committed to git; local docs are gitignored and must NOT be committed.
  {
    marker: "{{PI_FF_DESIGN_HANDOFF}}",
    handle(ctx) {
      const step =
        getSettings().designDocStorage === "committed"
          ? "Commit the design file, then signal the phase complete with the `phase_ready` tool. End your turn."
          : "The design file is gitignored under `.ff/` (do not commit). Signal the phase complete with the `phase_ready` tool. End your turn.";
      return ctx.text.replaceAll(this.marker, step);
    },
  },

  // {{PI_FF_PLAN_DOC_PATH}}
  {
    marker: "{{PI_FF_PLAN_DOC_PATH}}",
    handle(ctx) {
      // Slug present: stable per-feature path. No slug: date-wrapped fallback so age-clean
      // can target a bare <date> dir under task-plans/ (mirrors the reviews/ pattern). The
      // <date>/<date>- wrapper uses the real ctx.date, never the literal 'YYYY-MM-DD'.
      const docPath = ctx.opts.slug
        ? `${FF_TASK_PLANS_DIR}/${ctx.opts.slug}-task-plan.md`
        : `${FF_TASK_PLANS_DIR}/${ctx.date}/${ctx.date}-<feature-name>-task-plan.md`;
      return ctx.text.replaceAll(this.marker, docPath);
    },
  },

  // {{PI_FF_FEATURE_SLUG}}
  {
    marker: "{{PI_FF_FEATURE_SLUG}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, ctx.opts.slug ?? "YYYY-MM-DD-<topic>");
    },
  },

  // {{PI_FF_RESEARCH_DIR}} — absolute path to research output directory
  {
    marker: "{{PI_FF_RESEARCH_DIR}}",
    handle(ctx) {
      // Slug present: stable per-feature dir. No slug: date-wrapped fallback so age-clean
      // can target a bare <date> dir under research/ (mirrors the reviews/ pattern). The
      // <date>/<date>- wrapper uses the real ctx.date, never the literal 'YYYY-MM-DD'.
      const researchDir = ctx.opts.slug
        ? path.resolve(process.cwd(), FF_RESEARCH_DIR, ctx.opts.slug)
        : path.resolve(process.cwd(), FF_RESEARCH_DIR, ctx.date, `${ctx.date}-<topic>`);
      return ctx.text.replaceAll(this.marker, researchDir);
    },
  },

  // {{PI_FF_CURRENT_TASK}} — the plan-task designation set by task_ready_advance (number + name).
  {
    marker: "{{PI_FF_CURRENT_TASK}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, ctx.opts.taskName ?? "(not available)");
    },
  },

  // {{PI_FF_BASE_COMMIT_SHA}}
  {
    marker: "{{PI_FF_BASE_COMMIT_SHA}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, ctx.opts.baseCommitSha ?? "(not available)");
    },
  },

  // {{PI_FF_KNOWN_ISSUES_PATH}} — phase-scoped so design and plan dismissals stay separate
  // from each other and from code-review dismissals.
  {
    marker: "{{PI_FF_KNOWN_ISSUES_PATH}}",
    handle(ctx) {
      // Slug present: phase-scoped path under the feature's review dir.
      // No slug: date-based fallback so a manual skill invocation without an active
      // workflow still has a writable known-issues file (mirrors report-path fallback).
      // resolveKnownIssuesPath returns null only when slug is absent, so the slug-present
      // branch is always non-null.
      const issuesPath = ctx.opts.slug
        ? (resolveKnownIssuesPath(ctx.opts.slug, ctx.opts.phase, ctx.opts.taskName) as string)
        : buildFallbackKnownIssuesPath(ctx.date, ctx.opts.phase, ctx.opts.taskName);
      return ctx.text.replaceAll(this.marker, issuesPath);
    },
  },

  // {{PI_FF_WORTH_NOTES_PATH}} — worth-notes doc for out-of-scope smells/bugs/oddities the
  // ff-implementer reports but does not fix (parallel to known-issues; written by the orchestrator).
  {
    marker: "{{PI_FF_WORTH_NOTES_PATH}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, worthNotesPath(ctx.opts.slug ?? null, ctx.date));
    },
  },

  // --- Researcher settings ---

  // {{PI_FF_RESEARCHER_MIN}}
  {
    marker: "{{PI_FF_RESEARCHER_MIN}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, String(ctx.settings.researcherMinInstances));
    },
  },

  // {{PI_FF_RESEARCHER_MAX}}
  {
    marker: "{{PI_FF_RESEARCHER_MAX}}",
    handle(ctx) {
      return ctx.text.replaceAll(this.marker, String(ctx.settings.researcherMaxInstances));
    },
  },

  // {{PI_FF_RESEARCHER_DELEGATION}} — inject delegation section when nestedResearchers is "on"
  {
    marker: "{{PI_FF_RESEARCHER_DELEGATION}}",
    handle(ctx) {
      return ctx.text.replaceAll(
        this.marker,
        ctx.settings.nestedResearchers === "on" ? RESEARCHER_DELEGATION_SECTION : "",
      );
    },
  },

  // --- Review-iteration context (ff-design-review / ff-plan-review skills) ---

  // {{PI_FF_REVIEW_METHOD}}
  {
    marker: "{{PI_FF_REVIEW_METHOD}}",
    handle(ctx) {
      // Outside a review phase the method is indeterminate; resolve to empty so
      // the skill reads cleanly rather than showing a raw placeholder.
      if (!isReviewPhase(ctx.opts.phase)) {
        return ctx.text.replaceAll(this.marker, "");
      }
      const isDesign = ctx.opts.phase === "design";
      const method = computeReviewMethod(isDesign, ctx.settings);
      return ctx.text.replaceAll(this.marker, method);
    },
  },

  // {{PI_FF_REVIEW_LOOP_NUMBER}} — the iteration being reviewed (display number).
  {
    marker: "{{PI_FF_REVIEW_LOOP_NUMBER}}",
    handle(ctx) {
      if (!isReviewPhase(ctx.opts.phase)) {
        return ctx.text.replaceAll(this.marker, "");
      }
      const loopNumber = toDisplayLoopNumber(ctx.opts.loopIndex ?? 1);
      return ctx.text.replaceAll(this.marker, String(loopNumber));
    },
  },
];

/**
 * Apply generic {{PI_FF_*}} placeholder substitution to text.
 * Replaces settings-derived placeholders with their resolved values.
 * Returns the original text if no placeholders are found.
 */
export function substitutePlaceholders(text: string, opts: SubstitutePlaceholdersOptions): string {
  if (!text.includes("{{PI_FF_")) return text;

  const settings = getSettings();
  const date = new Date().toISOString().slice(0, 10);

  const ctx: PlaceholderContext = {
    text,
    settings,
    opts,
    date,
  };

  for (const handler of PLACEHOLDER_HANDLERS) {
    if (!ctx.text.includes(handler.marker)) continue;
    ctx.text = handler.handle(ctx);
  }

  // Post-pass validation: warn about any unresolved PI_FF_ placeholders
  const unresolved = ctx.text.match(/\{\{PI_FF_[A-Z_]+\}\}/g);
  if (unresolved) {
    log.warn(`[template-engine] Unresolved PI_FF_ placeholders after substitution pass: ${unresolved.join(", ")}`);
  }

  return ctx.text;
}

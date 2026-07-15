// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * TUI widget rendering for workflow monitor.
 *
 * Renders a single merged line pulling together the phase progression bar,
 * the active phase (+ review-loop counts), auto-agent status, and feature
 * identity. The feature slug is elastically trimmed (middle elision) to fit
 * the terminal width. Per-task progress is owned by the standalone TODO
 * widget (which auto-hides when empty).
 */

import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { isPhaseDone, type Phase, WORKFLOW_PHASES } from "../phases/phase-progression.js";
import type { FeatureSession } from "../state/feature-session.js";
import type { FeatureState } from "../state/feature-state.js";

/** Pass as `featureState` when no pre-loaded state is available (will load from disk). */
export const NO_FEATURE_STATE: FeatureState | null = null;

/** Pass to ctx.ui.setWidget() as the content argument to clear (remove) the widget. */
export const NO_WIDGET_CONTENT: Parameters<ExtensionContext["ui"]["setWidget"]>[1] = undefined;

/** Pass to ctx.ui.setStatus() as the content argument to clear (remove) a status entry. */
export const NO_STATUS: Parameters<ExtensionContext["ui"]["setStatus"]>[1] = undefined;

// --- Terminal width + elastic line fitting ---

const TERM_DEFAULT = 80;
const SEP = " · ";

/** Usable terminal width (2-char safety margin). */
function getTermWidth(): number {
  return (process.stdout.columns ?? TERM_DEFAULT) - 2;
}

/**
 * A renderable line segment. Fixed segments are pre-themed strings. Elastic
 * segments keep a fixed `prefix` and a `tail` that shrinks (with middle
 * elision) when the assembled line overflows the terminal width. An optional
 * `sepBefore` overrides the default ` · ` separator rendered before this
 * segment (the first segment renders no separator).
 */
type Segment = string | { prefix: string; tail: string; color: ThemeColor; sepBefore?: string };
type ElasticSegment = { prefix: string; tail: string; color: ThemeColor; sepBefore?: string };

function renderSegment(seg: Segment, theme: Theme): string {
  return typeof seg === "string" ? seg : theme.fg(seg.color, `${seg.prefix}${seg.tail}`);
}

function assemble(segments: Segment[], theme: Theme): string {
  return segments
    .map((s, i) => {
      const body = renderSegment(s, theme);
      if (i === 0) return body;
      const sep = typeof s === "string" ? SEP : (s.sepBefore ?? SEP);
      return `${sep}${body}`;
    })
    .join("");
}

/**
 * Assemble segments with ` · ` separators; if the line overflows the terminal,
 * middle-elide the elastic-segment tails, sharing the available width
 * proportionally across whatever elastic segments are present. Fixed segments
 * are never shortened.
 *
 * Which segments are elastic varies by phase: the feature slug appears only
 * when a slug exists, the coarse plan-task only in implement when one is set.
 * The proportional allocation therefore runs over the actual set (0, 1, or 2
 * tails), so a lone slug gets the whole budget and a slug + task pair split it.
 */
function fitLine(segments: Segment[], theme: Theme, termWidth: number): string {
  // Indices of elastic segments and their full tail widths.
  const elasticIdx = segments.map((s, i) => (typeof s === "string" ? -1 : i)).filter((i) => i >= 0);
  if (elasticIdx.length === 0 || visibleWidth(assemble(segments, theme)) <= termWidth) {
    return assemble(segments, theme);
  }

  const fullWidths = elasticIdx.map((i) => visibleWidth((segments[i] as ElasticSegment).tail));
  // Width of everything except the elastic tail content (fixed segments +
  // separators + the elastic segments' fixed prefixes).
  const emptied = segments.map((s) => (typeof s === "string" ? s : { ...s, tail: "" }));
  const availForTails = termWidth - visibleWidth(assemble(emptied, theme));

  const budgets = proportionalBudgets(fullWidths, Math.max(availForTails, 0));
  for (let k = 0; k < elasticIdx.length; k++) {
    const i = elasticIdx[k] as number;
    const seg = segments[i] as ElasticSegment;
    segments[i] = { ...seg, tail: elideMiddle(seg.tail, budgets[k] as number) };
  }
  return assemble(segments, theme);
}

/**
 * Allocate `total` visible cells across segments proportionally to their full
 * widths, each clamped to [1, fullWidth] (so every name stays visible), with
 * the remainder distributed to the largest fractional shares. If `total` is
 * already enough, returns the full widths unchanged (no trimming).
 */
function proportionalBudgets(fullWidths: number[], total: number): number[] {
  const n = fullWidths.length;
  const sum = fullWidths.reduce((a, b) => a + b, 0);
  if (total >= sum) return fullWidths.slice(); // nothing to trim
  if (total <= 0) return fullWidths.map(() => 0);

  // Guarantee each tail at least 1 cell when the budget allows.
  let budget = total;
  const minPer = total >= n ? 1 : 0;
  budget -= minPer * n;

  // Proportional floor of the variable share.
  const raw = fullWidths.map((w) => (sum > 0 ? (w * budget) / sum : 0));
  const floors = raw.map((r) => Math.max(0, Math.floor(r)));
  let leftover = budget - floors.reduce((a, b) => a + b, 0);

  // Hand leftover cells to the largest fractional remainders, capped at fullWidth-1.
  const cap = fullWidths.map((w) => w - minPer);
  const order = fullWidths.map((_, i) => i).sort((a, b) => raw[b] - Math.floor(raw[b]) - (raw[a] - Math.floor(raw[a])));
  let k = 0;
  while (leftover > 0 && k < n * 4) {
    const i = order[k % n] as number;
    if (floors[i] < (cap[i] ?? 0)) {
      floors[i] += 1;
      leftover--;
    }
    k++;
  }
  return floors.map((f) => f + minPer);
}

/** Middle-elide `text` to at most `maxLen` visible chars: keep head + tail, `…` between. */
function elideMiddle(text: string, maxLen: number): string {
  if (maxLen <= 1) return "\u2026";
  if (text.length <= maxLen) return text;
  const keep = maxLen - 1; // reserve 1 cell for the ellipsis
  const headLen = Math.ceil(keep / 2);
  const tailLen = keep - headLen;
  return `${text.slice(0, headLen)}\u2026${text.slice(text.length - tailLen)}`;
}

// --- Phase bar ---

/** One square cell per phase: ■ done, ◧ active, □ pending. When the feature is complete, all cells are ■. */
function formatPhaseBar(currentPhase: Phase, theme: Theme, isDone: boolean): string {
  const view = { currentPhase, completedAt: null };
  return WORKFLOW_PHASES.map((phase) => {
    if (isDone) return theme.fg("success", "■");
    if (phase === currentPhase) return theme.fg("accent", "◧");
    if (isPhaseDone(view, phase)) return theme.fg("success", "■");
    return theme.fg("dim", "□");
  }).join("");
}

/** Active phase label with an inline review-loop count where applicable. */
function formatPhaseLabel(
  phase: Phase,
  reviewLoopCount: number,
  designReviewLoopCount: number,
  planReviewLoopCount: number,
): string {
  let label: string = phase;
  if (phase === "review" && reviewLoopCount > 0) label = `${phase} #${reviewLoopCount}`;
  else if (phase === "design" && designReviewLoopCount > 0) label = `${phase} #${designReviewLoopCount}`;
  else if (phase === "plan" && planReviewLoopCount > 0) label = `${phase} #${planReviewLoopCount}`;
  return label;
}

// --- Main render ---

export function updateWidget(handler: FeatureSession, featureState: FeatureState | null): void {
  const guard = globalThis.__piCtx;
  if (!guard?.hasUI || !guard?.ui) return;
  const ui = guard.ui;

  const workflow = handler.getWorkflowState();
  const currentPhase = workflow?.currentPhase ?? null;
  const hasWorkflow = !!currentPhase;

  // Check auto-agent presence BEFORE early-return
  const autoAgent = globalThis.__piKanban?.autoAgent;
  const autoAgentState = autoAgent ? autoAgent.getState() : null;
  const hasAutoAgent = autoAgentState ? !["idle", "stopped"].includes(autoAgentState) : false;

  if (!hasWorkflow && !hasAutoAgent) {
    ui.setWidget("workflow_monitor", NO_WIDGET_CONTENT);
    return;
  }

  ui.setWidget("workflow_monitor", (_tui, theme) => {
    const segments: Segment[] = [];

    // Phase prefix block: 🅵 + bar + active-phase label (only when a workflow is active).
    if (currentPhase) {
      const slug = handler.getActiveFeatureSlug();
      const state = featureState ?? handler.getActiveFeatureState();
      const isDone = state?.completedAt != null;
      const reviewLoopCount = state?.review.reviewLoopCount ?? 0;
      const designReviewLoopCount = state?.design.reviewLoopCount ?? 0;
      const planReviewLoopCount = state?.plan.reviewLoopCount ?? 0;
      const featureId = state?.featureId ?? null;

      const bar = formatPhaseBar(currentPhase, theme, isDone);
      const phaseLabel = isDone
        ? "done"
        : formatPhaseLabel(currentPhase, reviewLoopCount, designReviewLoopCount, planReviewLoopCount);
      segments.push(`${theme.fg("accent", "\u{1F175}")} ${bar} ${theme.fg("accent", phaseLabel)}`);

      // Feature identity (id + slug). Slug is elastic.
      if (slug) {
        const prefix = featureId != null ? `${featureId}. ` : "";
        segments.push({ prefix, tail: slug, color: "muted" });

        // Coarse plan-task (set by task_ready_advance, durable in feature-state).
        // Elastic, shown only in implement.
        const currentTask = state?.implement.currentTask ?? null;
        if (currentPhase === "implement" && currentTask) {
          // The ▶ marker doubles as the separator before the task (replaces ` · `),
          // so prefix is empty and sepBefore carries ` ▶ `.
          segments.push({ prefix: "", tail: currentTask, color: "accent", sepBefore: " ▶ " });
        }
      }
    }

    // Auto-agent token, rendered after feature identity.
    if (autoAgent && autoAgentState) {
      const role = autoAgent.getRole();
      const gracePeriodManager = globalThis.__piKanban?.gracePeriod;
      if (autoAgentState === "grace-period") {
        const remaining = gracePeriodManager?.getRemainingSeconds() ?? 0;
        segments.push(theme.fg("warning", `\u{1F916} auto-${role} \u23F3 ${remaining}s`));
      } else if (autoAgentState === "working") {
        segments.push(theme.fg("success", `\u{1F916} auto-${role}`));
      } else if (autoAgentState === "polling") {
        segments.push(theme.fg("muted", `\u{1F4A4} auto-${role}`));
      } else if (autoAgentState === "waiting") {
        segments.push(theme.fg("warning", `\u{1F916} auto-${role}`));
      } else if (autoAgentState === "paused") {
        segments.push(theme.fg("warning", `\u23F8\uFE0F auto-${role}`));
      } else if (autoAgentState === "error") {
        segments.push(theme.fg("error", `\u274C auto-${role}`));
      }
    }

    if (segments.length === 0) return new Text("", 0, 0);
    return new Text(fitLine(segments, theme, getTermWidth()), 0, 0);
  });
}

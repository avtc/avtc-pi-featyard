// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Worth-notes pointer — the first RUNTIME reader of the worth-notes file.
 *
 * Worth-notes (`.ff/reviews/<slug>/<slug>-worth-notes.md`, or a date-fallback when no slug is
 * active) are unstructured LLM markdown written by the orchestrator/implementer for out-of-scope
 * smells/bugs/oddities. They are surfaced by MERGING a pointer (existence + path)
 * into existing boundary notifications — never standalone, because pi notifications are exclusive
 * (a new one hides the previous). This module owns two concerns:
 *
 * - `worthNotesPath(slug, date)`: the path computation (single source of truth — the
 *  `{{PI_FF_WORTH_NOTES_PATH}}` marker handler and every runtime caller delegate here, so the
 *  slug-vs-date-fallback branch lives in exactly one place).
 * - `worthNotesPointer(notesPath)`: given the resolved path, returns `📝 worth-notes: <path>` when
 *  the file exists and is non-empty, else null (a stat + size check). Callers append the pointer
 *  only when non-null, so absent/empty notes add no notification clutter.
 */

import { readFileSync, statSync } from "node:fs";

import { FF_REVIEWS_DIR } from "./artifact-paths.js";

/**
 * Resolve the worth-notes file path for a feature.
 *
 * - Slug present: `.ff/reviews/<slug>/<slug>-worth-notes.md` (the per-feature worth-notes file).
 * - No slug (manual skill run without an active feature): `.ff/reviews/<date>/<date>-worth-notes.md`
 *  (a single stable per-date file — worth-notes accumulate). `date` is a yyyy-mm-dd string.
 *
 * Mirrors the `{{PI_FF_WORTH_NOTES_PATH}}` marker resolution — both delegate here.
 */
export function worthNotesPath(slug: string | null, date: string): string {
  return slug ? `${FF_REVIEWS_DIR}/${slug}/${slug}-worth-notes.md` : `${FF_REVIEWS_DIR}/${date}/${date}-worth-notes.md`;
}

/**
 * Return `📝 worth-notes: <notesPath>` when the file exists and has non-whitespace content, else
 * `null`. The caller resolves `notesPath` (`worthNotesPath`) and appends the pointer only when
 * non-null — so absent or empty worth-notes produce no pointer line (no clutter).
 *
 * Existence + path only — never a count (the file is unstructured LLM markdown with no reliable
 * entry delimiter; counting would be fragile — ). The path lets the user open it.
 */
export function worthNotesPointer(notesPath: string): string | null {
  try {
    if (!statSync(notesPath).isFile()) return null;
  } catch {
    // Absent (or otherwise unreadable) → no pointer.
    return null;
  }
  // Existence + non-empty (non-whitespace) check. Worth-notes files are tiny, so a single read
  // is cheap. A whitespace-only file carries nothing to surface → treat as empty.
  let content: string;
  try {
    content = readFileSync(notesPath, "utf-8");
  } catch {
    return null;
  }
  if (content.trim().length === 0) {
    return null;
  }
  return `📝 worth-notes: ${notesPath}`;
}

/**
 * Convenience for the boundary notify sites: resolve today's worth-notes pointer for a feature
 * in one call (the single repeated pattern at the 5 merge sites). `today` is the current
 * yyyy-mm-dd; the pointer is non-null only when the notes file exists and is non-empty.
 */
export function worthNotesPointerFor(slug: string | null): string | null {
  const today = new Date().toISOString().slice(0, 10);
  return worthNotesPointer(worthNotesPath(slug, today));
}

/**
 * Emit the `Feature "<slug>" completed.` notify with the worth-notes pointer MERGED in
 * (existence + path, never standalone — notifications are exclusive, Completion
 * site). No-op when no UI is attached (headless). Shared by the two completion paths
 * (phase-transitions.ts completeFeature + phase-ready.ts finish→done).
 */
export function notifyFeatureCompleted(slug: string): void {
  const guard = globalThis.__piCtx;
  if (!guard?.hasUI || !guard?.ui?.notify) return;
  const pointer = worthNotesPointerFor(slug);
  const msg = pointer ? `Feature "${slug}" completed.\n${pointer}` : `Feature "${slug}" completed.`;
  guard.ui.notify(msg, "info");
}

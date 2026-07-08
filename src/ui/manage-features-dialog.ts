// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { withCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import type { FeatureState } from "../state/feature-state.js";

// Minimal TUI interface for testing
export interface TUILike {
  requestRender(): void;
}

// Raw terminal escape sequences for handleInput()
const INPUT = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  space: " ",
} as const;

/**
 * Formats feature info for display: the current workflow phase.
 * (Per-task counts are owned by the TODO widget; the manage-features dialog shows phase only.)
 */
export function formatFeatureInfo(feature: FeatureState): string {
  return feature.workflow?.currentPhase ?? "unknown";
}

export interface ManageFeaturesResult {
  action: "mark_completed" | "delete";
  slugs: string[];
}

/** Sentinel for the done() callback — dialog cancelled via Escape (no result action). */
const NO_MANAGE_RESULT: ManageFeaturesResult | null = null;

/**
 * Custom TUI component for managing feature state files.
 * Shows a multi-select list of features with Mark completed / Delete actions.
 */
export class ManageFeaturesComponent implements Component {
  private features: FeatureState[];
  private tui: TUILike;
  private theme: Theme;
  private done: (result: ManageFeaturesResult | null) => void;

  private selectedIndices: Set<number> = new Set();
  private cursorIndex: number = 0;
  private _resolved: boolean = false;

  // Render cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    features: FeatureState[],
    tui: TUILike,
    theme: Theme,
    done: (result: ManageFeaturesResult | null) => void,
  ) {
    this.features = features;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
  }

  // --- Public interface ---

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) {
      return this.cachedLines;
    }

    const t = this.theme;
    const lines: string[] = [];
    const add = (s: string) => lines.push(truncateToWidth(s, width));

    // Header
    add(t.fg("accent", "─".repeat(width)));
    add(t.fg("text", " Manage state files"));
    add("");

    // Feature checkboxes
    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i];
      const isCursor = i === this.cursorIndex;
      const isChecked = this.selectedIndices.has(i);
      const prefix = isCursor ? t.fg("accent", ">") : " ";
      const box = isChecked ? t.fg("accent", "[✓]") : t.fg("dim", "[ ]");
      const info = formatFeatureInfo(f);
      const label = `${f.featureSlug} — ${info}`;
      const labelColor = isCursor ? "accent" : "text";
      add(`${prefix} ${box} ${t.fg(labelColor, label)}`);
    }

    add("");

    // Toggle button
    const allChecked = this.features.length > 0 && this.selectedIndices.size === this.features.length;
    const toggleLabel = allChecked ? "Deselect All" : "Select All";
    const toggleIdx = this.features.length;
    const isToggleCursor = this.cursorIndex === toggleIdx;
    const togglePrefix = isToggleCursor ? t.fg("accent", ">") : " ";
    const toggleStyle = isToggleCursor ? "accent" : "text";
    add(`${togglePrefix} ${t.fg(toggleStyle, `[${toggleLabel}]`)}`);

    add("");

    // Action buttons
    const markCompletedIdx = this.features.length + 1;
    const deleteIdx = this.features.length + 2;
    const isMarkCursor = this.cursorIndex === markCompletedIdx;
    const isDeleteCursor = this.cursorIndex === deleteIdx;

    add(t.fg("text", " Actions:"));
    const markPrefix = isMarkCursor ? t.fg("accent", ">") : " ";
    const markStyle = isMarkCursor ? "accent" : "text";
    add(`${markPrefix} ${t.fg(markStyle, "[Mark completed]")}`);
    const delPrefix = isDeleteCursor ? t.fg("accent", ">") : " ";
    const delStyle = isDeleteCursor ? "accent" : "text";
    add(`${delPrefix} ${t.fg(delStyle, "[Delete]")}`);

    add("");

    // Footer
    add(t.fg("accent", "─".repeat(width)));
    add(t.fg("dim", " ↑↓ navigate · Space toggle · Enter confirm · Esc back"));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this._resolved) return;

    if (matchesKey(data, Key.escape)) {
      this._resolved = true;
      this.done(NO_MANAGE_RESULT);
      return;
    }

    const maxIdx = this.features.length + 3; // features + toggle + mark_completed + delete

    if (matchesKey(data, Key.up)) {
      this.cursorIndex = (this.cursorIndex - 1 + maxIdx) % maxIdx;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.cursorIndex = (this.cursorIndex + 1) % maxIdx;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    const toggleIdx = this.features.length;
    const markCompletedIdx = this.features.length + 1;
    const deleteIdx = this.features.length + 2;

    // Toggle checkbox on feature row
    if (this.cursorIndex < this.features.length) {
      if (matchesKey(data, Key.enter) || data === INPUT.space) {
        this.toggleSelected(this.cursorIndex);
        this.invalidate();
        this.tui.requestRender();
        return;
      }
    }

    // Toggle button
    if (this.cursorIndex === toggleIdx) {
      if (matchesKey(data, Key.enter) || data === INPUT.space) {
        const allChecked = this.selectedIndices.size === this.features.length;
        if (allChecked) {
          this.selectedIndices.clear();
        } else {
          for (let i = 0; i < this.features.length; i++) {
            this.selectedIndices.add(i);
          }
        }
        this.invalidate();
        this.tui.requestRender();
        return;
      }
    }

    // Mark completed action
    if (this.cursorIndex === markCompletedIdx && matchesKey(data, Key.enter)) {
      if (this.selectedIndices.size > 0) {
        this._resolved = true;
        this.done({
          action: "mark_completed" as const,
          slugs: [...this.selectedIndices].map((i) => this.features[i].featureSlug),
        });
      }
      return;
    }

    // Delete action
    if (this.cursorIndex === deleteIdx && matchesKey(data, Key.enter)) {
      if (this.selectedIndices.size > 0) {
        this._resolved = true;
        this.done({
          action: "delete" as const,
          slugs: [...this.selectedIndices].map((i) => this.features[i].featureSlug),
        });
      }
      return;
    }
  }

  private toggleSelected(index: number): void {
    if (this.selectedIndices.has(index)) {
      this.selectedIndices.delete(index);
    } else {
      this.selectedIndices.add(index);
    }
  }
}

/**
 * Open the manage features dialog via ctx.ui.custom().
 * Returns the action result, or null if the user pressed Esc.
 */
export async function openManageDialog(
  features: FeatureState[],
  ctx: ExtensionContext,
): Promise<ManageFeaturesResult | null> {
  return withCoordinator(() =>
    ctx.ui.custom<ManageFeaturesResult | null>(
      (tui, theme, _kb, done: (result: ManageFeaturesResult | null) => void) =>
        new ManageFeaturesComponent(features, tui, theme, done),
      {},
    ),
  );
}

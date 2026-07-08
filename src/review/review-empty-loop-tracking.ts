// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Reviewer empty-loop tracking.
 *
 * Tracks how many consecutive empty (no-change) loops each reviewer has produced
 * per feature slug. Used to decide when to skip a reviewer that keeps producing
 * empty results (configurable threshold).
 *
 * State is in-memory only — not persisted to disk.
 */

export class EmptyLoopTracker {
  private readonly loops = new Map<string, Map<string, number>>();

  private getEmptyLoops(slug: string): Map<string, number> {
    if (!this.loops.has(slug)) this.loops.set(slug, new Map());
    return this.loops.get(slug) as Map<string, number>;
  }

  incrementEmptyLoop(slug: string, reviewerName: string): void {
    const map = this.getEmptyLoops(slug);
    map.set(reviewerName, (map.get(reviewerName) ?? 0) + 1);
  }

  resetEmptyLoop(slug: string, reviewerName: string): void {
    this.getEmptyLoops(slug).delete(reviewerName);
  }

  getEmptyLoopsForSlug(slug: string): Record<string, number> {
    return Object.fromEntries(this.getEmptyLoops(slug));
  }

  getReviewerEmptyLoops(): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};
    for (const [slug, map] of this.loops) {
      result[slug] = Object.fromEntries(map);
    }
    return result;
  }

  isReviewerSkipped(slug: string, reviewerName: string, threshold: number): boolean {
    if (threshold === 0) return false;
    const count = this.getEmptyLoops(slug).get(reviewerName) ?? 0;
    return count >= threshold;
  }

  resetAllEmptyLoops(): void {
    this.loops.clear();
  }
}

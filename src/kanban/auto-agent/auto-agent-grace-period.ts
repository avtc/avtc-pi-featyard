// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../../log.js";

/** Options for GracePeriodManager. durationMs defaults to 30_000 when omitted. */
export type GracePeriodOpts = { durationMs?: number };

export class GracePeriodManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private remainingMs: number = 0;
  private readonly durationMs: number;
  private readonly tickMs = 1000;
  private active = false;
  private paused = false;

  constructor(
    private readonly onExpired: () => Promise<void>,
    private readonly onTick: (remainingSeconds: number) => void,
    private readonly onEnd: () => void,
    opts: GracePeriodOpts,
  ) {
    this.durationMs = opts.durationMs ?? 30_000;
  }

  start(): void {
    this.stop();
    this.active = true;
    this.remainingMs = this.durationMs;

    this.timer = setInterval(() => {
      if (this.paused) return;
      this.remainingMs -= this.tickMs;
      this.onTick(Math.max(0, Math.ceil(this.remainingMs / 1000)));

      if (this.remainingMs <= 0) {
        this.stop();
        this.onExpired().catch((err) => {
          log.error("[GracePeriodManager] onExpired error:", err);
        });
      }
    }, this.tickMs);

    this.onTick(Math.ceil(this.remainingMs / 1000));
    log.info(`[grace-period] started (${this.durationMs}ms)`);
  }

  onUserActivity(): void {
    if (!this.active) return;
    this.remainingMs = this.durationMs;
    if (!this.paused) {
      this.onTick(Math.ceil(this.durationMs / 1000));
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  stop(): void {
    const wasActive = this.active;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.active = false;
    this.paused = false;
    // Only call onEnd if we were actually active — avoids spurious onEnd during start()'s cleanup
    if (wasActive) this.onEnd();
  }

  isActive(): boolean {
    return this.active;
  }

  getRemainingSeconds(): number {
    return Math.max(0, Math.ceil(this.remainingMs / 1000));
  }
}

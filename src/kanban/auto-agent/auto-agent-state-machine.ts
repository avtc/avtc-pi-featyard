// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log, NO_ERROR } from "../../log.js";
import type { Feature, Lane } from "../data/kanban-types.js";
import type { KanbanTools } from "../kanban-operations.js";

/** Compute target lane for feature completion. Shared between handleFeatureCompletion and onFeatureComplete callback. */
export function computeTargetLane(currentFeatureLane: Lane, designApprovalEnabled: boolean): Lane {
  if (currentFeatureLane === "design") {
    return designApprovalEnabled ? "design-approval" : "ready";
  }
  return "done";
}

export type AutoAgentState =
  | "idle"
  | "working"
  | "waiting"
  | "polling"
  | "grace-period"
  | "paused"
  | "stopped"
  | "error";
export type AutoAgentRole = "worker" | "designer" | "agent";

/** Lanes each role picks from (ordered by priority) */
const ROLE_LANES: Record<AutoAgentRole, Lane[]> = {
  worker: ["in-progress", "ready"],
  designer: ["design"],
  agent: ["in-progress", "design", "ready"],
};

/** Skill to inject based on the lane the feature was picked from */
const LANE_TO_SKILL: Record<string, string> = {
  design: "fy-design",
  ready: "fy-plan",
};

// Cross-extension bridge: set by kanban extension, called by workflow-monitor
// Stored on globalThis.__piKanban.autoAgentCallback

export interface AutoAgentCallback {
  onFeatureComplete: (slug: string) => void;
  onFeatureError: (slug: string, error: string) => void;
  onBlock?: (slug: string) => void;
  onUnblock?: (slug: string) => void;
  /**
   * Called when a feature reaches UAT (after-review mode) and the agent should
   * release the lock and move to the next feature. The card stays in the UAT lane
   * for the user to accept/reject.
   */
  onFeatureUatHandoff?: (slug: string) => void;
  /** Returns true if any auto-agent is currently active (working/polling/waiting). */
  isActive?: () => boolean;
}

export function setAutoAgentCallback(cb: AutoAgentCallback | null): void {
  if (globalThis.__piKanban) {
    globalThis.__piKanban.autoAgentCallback = cb ?? undefined;
  }
}

/** Sentinel for setAutoAgentCallback() — clear the registered auto-agent callback. */
export const NO_AUTO_AGENT_CALLBACK: AutoAgentCallback | null = null;

export function getAutoAgentCallback(): AutoAgentCallback | null {
  return globalThis.__piKanban?.autoAgentCallback ?? null;
}

/** Pass as `status` to clear the overlay. */
const NO_OVERLAY_STATUS: string | null = null;

/** Start the agent heartbeat (refresh kanban heartbeat via getTools every interval) + the wait-timeout watchdog for the given feature. Shared by auto-agent-lifecycle (onActivate) and register-auto-agent (tryMatchSessionSlug). */
export function startAgentHeartbeat(
  sm: AutoAgentStateMachine,
  featureId: number,
  getTools: () => Promise<KanbanTools>,
): void {
  sm.startHeartbeat(featureId, (fid) => {
    getTools()
      .then((t) => t.kanbanHeartbeat(fid, sm.sessionId))
      .catch((e) => log.warn(`[kanban] heartbeat refresh failed: ${e}`));
  });
  sm.startWaitTimeoutForFeature(featureId);
}

export class AutoAgentStateMachine {
  private state: AutoAgentState = "idle";
  private pauseRequested = false;
  private currentFeatureId: number | null = null;
  private currentFeatureLane: Lane | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private overlayCallback: ((featureId: number, status: string | null) => void) | null = null;
  private waitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private startPollingFn: (() => void) | null = null;
  private waitTimeoutMs: number | null = null;
  private onWaitTimeout: ((featureId: number, reason: "timeout") => void) | null = null;

  // The role is the one mutable field that changes at runtime (role switch).
  // It is exposed read-only via the getRole() method so external callers cannot
  // bypass setRole() (which logs + persists). Mutation must go through setRole().
  private _role: AutoAgentRole;
  getRole(): AutoAgentRole {
    return this._role;
  }

  constructor(
    role: AutoAgentRole,
    public readonly projectId: number | undefined,
    public readonly sessionId: string,
  ) {
    this._role = role;
  }

  /**
   * Switch the agent's role in place (e.g. worker → designer) without tearing
   * down and recreating the state machine. Preserves the current feature, its
   * lock (same sessionId), all timers, and callback wiring. The next feature
   * pick will use the new role's lanes.
   */
  setRole(role: AutoAgentRole): void {
    if (this._role === role) return;
    log.info(`[auto-agent] role changed ${this._role} → ${role}`);
    this._role = role;
    this.persist();
  }

  /** Configure wait timeout behavior for this agent. */
  setWaitTimeoutConfig(timeoutMs: number | null, onTimeout: (featureId: number, reason: "timeout") => void): void {
    this.waitTimeoutMs = timeoutMs;
    this.onWaitTimeout = onTimeout;
  }

  /** Update only the wait-timeout duration, keeping the existing onTimeout callback.
   *  Used on role switch (e.g. worker → designer) so the next waiting state uses
   *  the new role's configured timeout instead of the stale prior value. */
  setWaitTimeoutMs(timeoutMs: number | null): void {
    this.waitTimeoutMs = timeoutMs;
  }

  /** The currently configured wait-timeout duration (or null if disabled).
   *  Exposed so callers/tests can verify the value (e.g. after a role switch). */
  getWaitTimeoutMs(): number | null {
    return this.waitTimeoutMs;
  }

  /** Adopt an existing feature (set private fields) for session-slug matching.
   *  Used when auto-agent starts in a session already working on a feature. */
  adoptFeature(featureId: number, lane: Lane): void {
    this.currentFeatureId = featureId;
    this.currentFeatureLane = lane;
  }

  /** Start wait timeout for a specific feature using stored config. */
  startWaitTimeoutForFeature(featureId: number): void {
    if (this.waitTimeoutMs !== null && this.onWaitTimeout !== null) {
      this.startWaitTimeout(featureId, this.waitTimeoutMs, this.onWaitTimeout);
    }
  }

  private persist(): void {
    // No-op: state lives in globalThis, no persistence needed.
  }

  getState(): AutoAgentState {
    return this.state;
  }

  start(): boolean {
    if (this.state !== "idle") return false;
    this.state = "working";
    this.pauseRequested = false;
    log.info(`[auto-agent] started (${this.getRole()})`);
    this.persist();
    return true;
  }

  complete(): void {
    this.stopHeartbeat();
    this.stopWaitTimeout();
    if (this.state !== "working" && this.state !== "waiting" && this.state !== "paused") return;
    // Clear overlay status if in waiting state
    if (this.state === "waiting") this.clearOverlayIfBlocked();
    this.currentFeatureId = null;
    if (this.pauseRequested) {
      this.state = "stopped";
      log.info("[auto-agent] stopped after feature completion");
    } else {
      this.state = "idle";
      log.info("[auto-agent] feature complete, returning to idle");
    }
    this.persist();
  }

  noFeatureAvailable(): void {
    if (this.state !== "working") return;
    if (this.pauseRequested) {
      this.state = "stopped";
    } else {
      this.state = "polling";
    }
    this.persist();
  }

  featureFound(): void {
    if (this.state !== "polling") return;
    this.state = "working";
    this.persist();
  }

  /**
   * Immediately and unconditionally stop the agent from any state.
   *
   * Clears all timers (heartbeat, polling, wait-timeout) and clears any
   * "waiting-for-response" overlay, then transitions to "stopped". This is an
   * immediate stop — there is no deferred "finish current feature first"
   * behavior. Callers that need the current feature's lock preserved must
   * reassign it themselves (e.g. /fy:auto-stop reassigns the UUID lock to
   * session:<slug> so it survives without a heartbeat).
   */
  requestStop(): void {
    this.stopHeartbeat();
    this.stopPollingTimer();
    this.stopWaitTimeout();
    // Clear waiting-for-response overlay if the agent was blocked
    if (this.state === "waiting") this.clearOverlayIfBlocked();
    this.state = "stopped";
    log.info(`[auto-agent] stopped (${this.getRole()})`);
    this.persist();
  }

  /**
   * Pause the auto-loop: stops polling, wait timeout, and auto-pick of next feature.
   * Keeps heartbeat running and preserves current feature assignment.
   * The user can continue working on the current feature manually.
   * To resume auto-loop, call unpause().
   */
  pause(): void {
    this.stopPollingTimer();
    this.stopWaitTimeout();
    this.pauseRequested = true;
    if (this.state === "grace-period") {
      // Grace period manager is stopped externally by the caller
    }
    this.state = "paused";
    log.info(`[auto-agent] paused (keeping heartbeat for feature ${this.currentFeatureId})`);
    this.persist();
  }

  /**
   * Unpause the auto-loop: resumes from paused state.
   * Only works if in "paused" state.
   */
  unpause(): boolean {
    if (this.state !== "paused") return false;
    this.pauseRequested = false;
    this.state = "working";
    log.info("[auto-agent] unpaused (resuming auto-loop)");
    this.persist();
    return true;
  }

  error(message: string): void {
    this.stopHeartbeat();
    this.stopWaitTimeout();
    this.stopPollingTimer();
    // Clear overlay status on error
    this.clearOverlayIfBlocked();
    log.error(`[auto-agent] error: ${message}`, NO_ERROR);
    this.state = "error";
    this.persist();
  }

  reset(): void {
    this.stopHeartbeat();
    this.stopWaitTimeout();
    this.stopPollingTimer();
    this.state = "idle";
    this.pauseRequested = false;
    this.persist();
  }

  /**
   * Start a periodic heartbeat timer to keep the feature lock alive.
   * @param featureId The feature to refresh the lock for
   * @param heartbeatFn Called with featureId on each interval tick
   * @param intervalMs Interval in milliseconds (default 60000 = 60s)
   */
  startHeartbeat(featureId: number, heartbeatFn: (featureId: number) => void, intervalMs = 60_000): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      heartbeatFn(featureId);
    }, intervalMs);
  }

  /** Stop the heartbeat timer if running. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Start a wait timeout timer. If the agent is blocked for longer than
   * timeoutMs, the onTimeout callback fires with the feature ID.
   * Pass null for timeoutMs to wait indefinitely (no timer set).
   */
  startWaitTimeout(
    featureId: number,
    timeoutMs: number | null,
    onTimeout: (featureId: number, reason: "timeout") => void,
  ): void {
    this.stopWaitTimeout();
    if (timeoutMs === null) return; // Infinite wait — no timer
    this.waitTimeoutTimer = setTimeout(() => {
      if (this.state === "waiting") {
        onTimeout(featureId, "timeout");
      }
    }, timeoutMs);
  }

  /** Stop the wait timeout timer if running. */
  stopWaitTimeout(): void {
    if (this.waitTimeoutTimer !== null) {
      clearTimeout(this.waitTimeoutTimer);
      this.waitTimeoutTimer = null;
    }
  }

  /** Set the polling timer from external code (index.ts). Timer is cleared on stop/reset/error. */
  setPollingTimer(timer: ReturnType<typeof setTimeout>): void {
    if (this.pollingTimer !== null) {
      clearTimeout(this.pollingTimer);
    }
    this.pollingTimer = timer;
  }

  /** Set the function to start a new polling cycle (used by onFeatureComplete to enter polling). */
  setStartPollingFn(fn: (() => void) | null): void {
    this.startPollingFn = fn;
  }

  /** Get the start polling function (for calling from onFeatureComplete). */
  getStartPollingFn(): (() => void) | null {
    return this.startPollingFn;
  }

  /** Stop the polling timer if running. */
  stopPollingTimer(): void {
    if (this.pollingTimer !== null) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Set the callback for managing overlay status on the current feature.
   * Called with (featureId, status) where status is 'waiting-for-response' or null.
   */
  setOverlayCallback(cb: (featureId: number, status: string | null) => void): void {
    this.overlayCallback = cb;
  }

  /** Clear the "waiting-for-response" overlay for the current feature, if any is set.
   *  Shared by complete()/requestStop()/error()/unblock() so the clear logic
   *  (and its null-guards) lives in one place. Callers that should only clear
   *  when actually blocked guard on state themselves. */
  private clearOverlayIfBlocked(): void {
    if (this.currentFeatureId !== null && this.overlayCallback) {
      this.overlayCallback(this.currentFeatureId, NO_OVERLAY_STATUS);
    }
  }

  /** Set the "waiting-for-response" overlay on the current feature. */
  private setOverlayWaitingForResponse(): void {
    if (this.currentFeatureId !== null && this.overlayCallback) {
      this.overlayCallback(this.currentFeatureId, "waiting-for-response");
    }
  }

  /**
   * Enter waiting state and set overlay status on the current feature.
   * Called when the agent needs user input (e.g., ask_user_question).
   */
  block(): void {
    if (this.state !== "working") return;
    this.state = "waiting";
    this.setOverlayWaitingForResponse();
    log.info(`[auto-agent] blocked, waiting for response (feature ${this.currentFeatureId})`);
    this.persist();
  }

  /**
   * Resume from waiting state and clear overlay status on the current feature.
   * Called when user provides input and agent can continue.
   */
  unblock(): void {
    if (this.state !== "waiting") return;
    this.stopWaitTimeout();
    this.state = "working";
    this.clearOverlayIfBlocked();
    log.info(`[auto-agent] unblocked, resuming work (feature ${this.currentFeatureId})`);
    this.persist();
  }

  /** Enter grace period state (from polling or working). Feature found but waiting before activating. */
  enterGracePeriod(): void {
    if (this.state !== "polling" && this.state !== "working") return;
    this.state = "grace-period";
    this.persist();
  }

  /** Exit grace period (feature activated). */
  exitGracePeriod(): void {
    if (this.state !== "grace-period") return;
    this.state = "working";
    this.persist();
  }

  /**
   * Get the lanes this role picks from.
   */
  getLanes(): Lane[] {
    return ROLE_LANES[this.getRole()];
  }

  /** Get the current feature ID being worked on */
  getCurrentFeatureId(): number | null {
    return this.currentFeatureId;
  }

  /** Get the original lane of the current feature (before kanbanTake moved it) */
  getCurrentFeatureLane(): Lane | null {
    return this.currentFeatureLane;
  }

  /**
   * Pick the next feature from kanban using the appropriate lanes for this role.
   * Returns the feature + skill to inject, or null if no feature available.
   */
  pickNextFeature(
    tools: KanbanTools,
    projectId: number,
    sessionId: string,
  ): { feature: Feature; skill: string; kanbanFeatureId: number } | null {
    if (this.state !== "working" && this.state !== "idle") return null;

    // Try lanes in order (design-first for agent role) to respect lane priority
    let feature: Feature | null = null;
    let foundInLane: Lane | null = null;
    const lanes = this.getLanes();
    for (const lane of lanes) {
      feature = tools.kanbanTake({
        projectId,
        lanes: [lane],
        sessionId,
      });
      if (feature) {
        foundInLane = lane;
        break;
      }
    }

    if (!feature) {
      this.noFeatureAvailable();
      return null;
    }

    // Track current feature for completion/error handling
    this.currentFeatureId = feature.id;
    // Use the lane we searched when the feature was found, not the (possibly moved) feature.lane.
    // kanbanTake moves ready→in-progress, so feature.lane may differ from the search lane.
    this.currentFeatureLane = foundInLane;
    const skill = foundInLane ? LANE_TO_SKILL[foundInLane] : "fy-design";

    // Handle null slug: assign temp slug kanban-{id}
    const resolvedFeature = feature.slug ? feature : { ...feature, slug: `kanban-${feature.id}` as string };
    if (!feature.slug) {
      log.info(`[auto-agent] assigned temp slug ${resolvedFeature.slug} to feature ${feature.id}`);
    }

    log.info(
      `[auto-agent] picked feature ${resolvedFeature.slug} from ${this.getLanes().join(",")} lane(s), injecting skill: ${skill}`,
    );
    return { feature: resolvedFeature, skill, kanbanFeatureId: feature.id };
  }

  /**
   * Handle completion of a feature: move to appropriate lane, release lock, check for next.
   * Design features move to ready (or design-approval if enabled).
   * Implementation features move to done.
   * Returns the next feature+skill pair if the loop should continue, or null.
   */
  handleFeatureCompletion(
    tools: KanbanTools,
    featureId: number,
    sessionId: string,
    projectId: number,
    opts?: { designApprovalEnabled?: boolean; completeOnly?: boolean },
  ): { feature: Feature; skill: string; kanbanFeatureId: number } | null {
    // Determine target lane based on original feature lane
    const designApprovalEnabled = opts?.designApprovalEnabled ?? true;
    if (!this.currentFeatureLane) {
      log.warn(`[auto-agent] handleFeatureCompletion: no currentFeatureLane for featureId=${featureId}`);
      this.complete();
      return null;
    }
    const targetLane = computeTargetLane(this.currentFeatureLane, designApprovalEnabled);

    log.info(
      `[auto-agent] handleFeatureCompletion: featureId=${featureId}, currentFeatureLane=${this.currentFeatureLane}, targetLane=${targetLane}, designApprovalEnabled=${designApprovalEnabled}`,
    );

    // Move feature to target lane and release lock
    tools.kanbanMove({
      featureId,
      toLane: targetLane,
      changedBy: `agent:${sessionId}`,
    });
    log.info(`[auto-agent] handleFeatureCompletion: moved feature ${featureId} to ${targetLane}`);
    tools.kanbanRelease({ featureId });
    log.info(`[auto-agent] handleFeatureCompletion: released lock on feature ${featureId}`);

    // Complete current feature in state machine
    this.complete();
    log.info(`[auto-agent] handleFeatureCompletion: state after complete()=${this.getState()}`);

    // If stopped (user requested stop), don't pick next
    if (this.getState() === "stopped") {
      log.info("[auto-agent] stop was requested, not picking next feature");
      return null;
    }

    // completeOnly: stop here — caller handles start() + pick/enterGracePeriod
    if (opts?.completeOnly) return null;

    // Start next cycle
    if (!this.start()) {
      return null;
    }

    return this.pickNextFeature(tools, projectId, sessionId);
  }

  /**
   * Handle UAT handoff: release lock (card stays in UAT lane), complete current feature,
   * and pick the next feature.
   * Used in after-review UAT mode where the user accepts/rejects in the UAT lane.
   * Returns the next feature+skill pair if the loop should continue, or null.
   */
  handleFeatureUatHandoff(
    tools: KanbanTools,
    featureId: number,
    sessionId: string,
    projectId: number,
  ): { feature: Feature; skill: string; kanbanFeatureId: number } | null {
    log.info(
      `[auto-agent] handleFeatureUatHandoff: featureId=${featureId}, currentFeatureLane=${this.currentFeatureLane}`,
    );

    // Release lock — card stays in UAT lane (already moved by sync callback)
    tools.kanbanRelease({ featureId });
    log.info(`[auto-agent] handleFeatureUatHandoff: released lock on feature ${featureId}`);

    // Complete current feature in state machine
    this.complete();
    log.info(`[auto-agent] handleFeatureUatHandoff: state after complete()=${this.getState()}`);

    // If stopped (user requested stop), don't pick next
    if (this.getState() === "stopped") {
      log.info("[auto-agent] stop was requested, not picking next feature");
      return null;
    }

    // Start next cycle
    if (!this.start()) {
      return null;
    }

    return this.pickNextFeature(tools, projectId, sessionId);
  }

  /**
   * Handle a transient error (network failure, usage limit) during feature processing.
   * Instead of releasing the lock and killing the agent, blocks the agent in
   * "waiting" state — heartbeat keeps running, feature stays in current lane.
   * When the user sends a message, onUnblock fires and auto-agent resumes.
   */
  handleFeatureTransientError(featureId: number, errorMessage: string): void {
    log.warn(`[auto-agent] transient error on feature ${featureId}: ${errorMessage}`);
    log.info("[auto-agent] blocking agent (waiting for user) — lock kept, heartbeat continues");

    // Transition to waiting with error context. Overlay logic mirrors block()
    // via the shared setOverlayWaitingForResponse() helper.
    if (this.state !== "working") return;
    this.state = "waiting";
    this.setOverlayWaitingForResponse();
    this.persist();
    log.info(`[auto-agent] blocked after transient error (feature ${this.currentFeatureId})`);
  }

  /**
   * Handle a fatal error during feature processing: release lock, move back, report.
   * Used for non-transient errors where the agent cannot continue.
   */
  handleFeatureError(
    tools: KanbanTools,
    featureId: number,
    sessionId: string,
    originalLane: Lane,
    errorMessage: string,
  ): void {
    log.error(`[auto-agent] error on feature ${featureId}: ${errorMessage}`, NO_ERROR);

    // Move back to original lane
    tools.kanbanMove({
      featureId,
      toLane: originalLane,
      changedBy: `agent:${sessionId}`,
      note: `Error: ${errorMessage}`,
    });
    tools.kanbanRelease({ featureId });

    this.error(errorMessage);
  }
}

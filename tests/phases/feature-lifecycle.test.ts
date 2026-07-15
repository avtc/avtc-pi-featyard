// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import type { Phase } from "../../src/phases/phase-progression.js";
import { isPhaseActive, type PhaseProgressionView } from "../../src/phases/phase-progression.js";
import {
  createFeatureState,
  loadFeatureState,
  saveFeatureState,
  scanActiveFeatures,
} from "../../src/state/feature-state.js";
import {
  createFakePi,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  setupPiCtx,
  TUI_MODE,
} from "../helpers/workflow-monitor-test-helpers.js";

/** Derived-status view from a FeatureState (null-safe). */
function view(
  state: { workflow: { currentPhase: string | null }; completedAt: string | null } | null,
): PhaseProgressionView {
  return {
    currentPhase: state?.workflow.currentPhase as PhaseProgressionView["currentPhase"],
    completedAt: state?.completedAt ?? null,
  };
}

/**
 * Full lifecycle integration test:
 * 1. Fresh project — no state files
 * 2. Write design doc → state file created, design complete
 * 3. Write implementation doc → plan complete
 * 4. Plan tracker init → implement phase active
 * 5. Advance through verify, review
 * 6. Finish → state file marked done
 * 7. New session start → no active features found
 */
describe("full feature lifecycle", () => {
  afterEach(() => {
    _resetFeatureState();
    delete globalThis.__piCtx;
  });

  test("complete feature lifecycle from design doc to finish", async () => {
    disableSubagentMode();
    const { fake, registeredTools, api } = createPiWithToolCapture();
    const _tempDir = process.cwd();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const _onToolResult = getSingleHandler(fake.handlers, "tool_result");
    const _onAgentEnd = getSingleHandler(fake.handlers, "agent_end");

    const noUICtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        notify: () => {},
        select: async (_msg: string, opts: string[]) => {
          // For unresolved phase dialogs, pick "Skip" option; for execution mode, pick first option
          const skipOpt = opts.find((o: string) => o.startsWith("Skip"));
          return skipOpt ?? opts[0];
        },
        setEditorText: () => {},
      },
    } as unknown as ExtensionContext;
    const uiCtx = (selectResponse: string) => ({
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        notify: () => {},
        select: async () => selectResponse,
        setEditorText: () => {},
      },
    });

    // --- 1. Fresh project — no state files ---
    expect(scanActiveFeatures(null)).toEqual([]);
    expect(getActiveFeatureSlug()).toBeNull();

    // --- 2. Write design doc → state file created, design complete ---
    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/featyard/designs/2026-05-08-lifecycle-test-design.md" },
      } as unknown as ExtensionEvent,
      noUICtx,
    );

    expect(getActiveFeatureSlug()).toBe("2026-05-08-lifecycle-test");
    expect(process.env.PI_FY_FEATURE).toBe("2026-05-08-lifecycle-test");

    const state1 = loadFeatureState("2026-05-08-lifecycle-test", null);
    expect(state1).not.toBeNull();
    expect(state1?.completedAt).toBeNull();
    expect(state1?.workflow.currentPhase).toBe("design");
    expect(isPhaseActive(view(state1), "design")).toBe(true);
    expect(state1?.design.doc).toBe("docs/featyard/designs/2026-05-08-lifecycle-test-design.md");

    // --- 3. Advance to plan phase and record the plan artifact ---
    // (In the SOTS model, phase changes are pointer moves on the in-memory record;
    // /skill inputs no longer auto-advance. Move the pointer and persist.)
    const advanceTo = (phase: string) => {
      const h = globalThis.__piWorkflowMonitor?.handler;
      h?.setCurrentPhase(phase as unknown as Phase);
      const fs = h?.getActiveFeatureState();
      if (fs) saveFeatureState(fs, null);
    };
    advanceTo("plan");

    // --- 4. Write implementation doc → plan artifact recorded ---
    await onToolCall(
      {
        toolCallId: "call-2",
        toolName: "write",
        input: { path: ".featyard/task-plans/2026-05-08-lifecycle-test-task-plan.md" },
      } as unknown as ExtensionEvent,
      noUICtx,
    );
    // The write records the doc in the in-memory tracker; mirror + persist it.
    {
      const h = globalThis.__piWorkflowMonitor?.handler;
      const fs = h?.getActiveFeatureState();
      if (fs) saveFeatureState(fs, null);
    }

    const state2 = loadFeatureState("2026-05-08-lifecycle-test", null);
    expect(isPhaseActive(view(state2), "plan")).toBe(true);
    expect(state2?.workflow.currentPhase).toBe("plan");
    expect(state2?.plan.doc).toBe(".featyard/task-plans/2026-05-08-lifecycle-test-task-plan.md");

    // --- 5. Advance plan → implement (phase_ready drives this in production) ---
    advanceTo("implement");

    const state3 = loadFeatureState("2026-05-08-lifecycle-test", null);
    expect(isPhaseActive(view(state3), "implement")).toBe(true);
    expect(state3?.workflow.currentPhase).toBe("implement");

    // --- 6. Advance through verify, review, and finish (pointer moves + persist) ---
    advanceTo("verify");
    const state4 = loadFeatureState("2026-05-08-lifecycle-test", null);
    expect(isPhaseActive(view(state4), "verify")).toBe(true);

    advanceTo("review");
    const state5 = loadFeatureState("2026-05-08-lifecycle-test", null);
    expect(isPhaseActive(view(state5), "review")).toBe(true);

    advanceTo("finish");
    const state6 = loadFeatureState("2026-05-08-lifecycle-test", null);
    expect(isPhaseActive(view(state6), "finish")).toBe(true);
    expect(state6?.workflow.currentPhase).toBe("finish");

    // --- 7. Finish → state file marked done ---
    // Set the pointer to finish (all prior phases derived done).
    const featureState = loadFeatureState("2026-05-08-lifecycle-test", null);
    if (!featureState) throw new Error("Feature state not found");
    featureState.workflow.currentPhase = "finish";

    saveFeatureState(featureState, null);

    // Reconstruct state from file
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, noUICtx);

    // Call phase_ready to signal finish completion
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>;
    };
    const result = await phaseReady.execute("tc-finish", {}, undefined, undefined, uiCtx("next"));
    expect(result.content[0].text).toBe("");

    const state7 = loadFeatureState("2026-05-08-lifecycle-test", null);
    expect(state7?.completedAt).not.toBeNull();
    expect(state7?.completedAt).toBeTruthy();

    // B1: the done feature stays the active one (slot kept, not cleared) so the
    // widget renders the terminal DONE line until the next feature displaces it.
    expect(getActiveFeatureSlug()).toBe(state7?.featureSlug);

    // --- 8. New session start → no active features ---
    _resetFeatureState();
    delete globalThis.__piCtx;
    const activeFeatures = scanActiveFeatures(null);
    expect(activeFeatures.length).toBe(0);

    // Create a fresh extension instance for the new session
    const fake2 = createFakePi();
    delete (globalThis as Record<string, unknown>).__avtcPiFeatyardWired;
    workflowMonitorExtension(fake2.api as unknown as ExtensionAPI);

    let selectCalled = false;
    const newSessionCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        notify: () => {},
        select: async () => {
          selectCalled = true;
          return "";
        },
        setEditorText: () => {},
      },
    };

    await fireAllHandlers(fake2.handlers, "session_start", { reason: "startup" }, newSessionCtx);

    // No prompt should be shown since no active features
    expect(selectCalled).toBe(false);
    expect(getActiveFeatureSlug()).toBeNull();
  });

  test("multiple features can coexist and be selected on session start", async () => {
    enableSubagentMode(); // simulates subagent session with hasUI: false
    // Create first extension instance and its temp dir
    const _fake = createFakePi();
    const _tempDir = process.cwd();

    // Create two feature state files in the same temp dir
    const state1 = createFeatureState(
      "2026-01-01-feature-alpha",
      "docs/featyard/designs/2026-01-01-feature-alpha-design.md",
    );
    state1.updatedAt = "2026-01-01T00:00:00.000Z";
    saveFeatureState(state1, null);

    const state2 = createFeatureState(
      "2026-02-01-feature-beta",
      "docs/featyard/designs/2026-02-01-feature-beta-design.md",
    );
    state2.updatedAt = "2026-02-01T00:00:00.000Z";
    state2.workflow.currentPhase = "implement";
    saveFeatureState(state2, null);

    // Verify 2 active features exist
    const active = scanActiveFeatures(null);
    expect(active.length).toBe(2);

    // Reset module-level state
    _resetFeatureState();
    delete globalThis.__piCtx;

    // Simulate root session setting env var before spawning new session
    process.env.PI_FY_FEATURE = "2026-02-01-feature-beta";

    // Create a new extension instance in the SAME temp dir
    // Don't call createFakePi (which changes CWD), manually set up
    const handlers = new Map<string, Array<(event: ExtensionEvent, ctx: ExtensionContext) => unknown>>();
    const api = {
      on(event: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      events: {
        on() {
          return () => {};
        },
      },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
    };
    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(
      handlers,
      "session_start",
      { reason: "new" },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // Should auto-load the most recently updated feature
    expect(getActiveFeatureSlug()).toBe("2026-02-01-feature-beta");
  });
});

/**
 * session_start reason="startup" restoration.
 *
 * `pi --session <id>` / `--continue` / `--fork` open an EXISTING session — pi emits
 * reason "startup" (not "resume"). The session branch carries the last-persisted
 * featyard_state custom entry, so startup MUST restore it (otherwise the
 * widget + feature-state never reactivate). A CLEAN new session has an empty
 * branch and must stay clean (fall through, no stale restore).
 */
describe("session_start startup restore", () => {
  const SLUG = "2026-06-01-startup-restore";

  /** Build a branch whose latest entry is a featyard_state custom snapshot. */
  function branchWithFeatureEntry(slug: string) {
    const fs = createFeatureState(slug, `docs/featyard/designs/${slug}-design.md`);
    fs.workflow.currentPhase = "implement";
    saveFeatureState(fs, null);
    const snapshot = { featureState: fs, guardrailsState: { tdd: { stage: "idle" }, verification: "not-run" } };
    return [{ type: "custom", customType: "featyard_state", data: snapshot }];
  }

  function makeCtx(branch: unknown[]) {
    const setWidget = vi.fn();
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => branch },
      ui: {
        setWidget,
        select: async () => "",
        setEditorText: () => {},
      },
    };
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);
    return { ctx, setWidget };
  }

  afterEach(() => {
    _resetFeatureState();
    delete globalThis.__piCtx;
    delete process.env.PI_FY_FEATURE;
  });

  test("startup with a feature entry in the branch restores feature state + widget", async () => {
    disableSubagentMode();
    // pi --session <id> opens an existing session whose branch holds the feature snapshot
    const { ctx, setWidget } = makeCtx(branchWithFeatureEntry(SLUG));

    const fake = createFakePi();
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "startup" }, ctx as unknown as ExtensionContext);

    // Feature state is reactivated from the session branch entry
    expect(getActiveFeatureSlug()).toBe(SLUG);
    expect(process.env.PI_FY_FEATURE).toBe(SLUG);
    // The restored in-memory record carries the persisted phase pointer
    expect(globalThis.__piWorkflowMonitor?.handler.getActiveFeatureState()?.workflow.currentPhase).toBe("implement");
    // Widget was rendered (not cleared)
    expect(setWidget).toHaveBeenCalled();
    const [, content] = setWidget.mock.calls.at(-1) ?? [];
    expect(content).not.toBeUndefined();
  });

  test("startup with an EMPTY branch stays clean (new session, no stale restore)", async () => {
    disableSubagentMode();
    const { ctx, setWidget } = makeCtx([]); // clean new `pi` → empty branch

    const fake = createFakePi();
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "startup" }, ctx as unknown as ExtensionContext);

    expect(getActiveFeatureSlug()).toBeNull();
    // Widget cleared (NO_WIDGET_CONTENT === undefined)
    expect(setWidget).toHaveBeenCalled();
    const [, content] = setWidget.mock.calls.at(-1) ?? [];
    expect(content).toBeUndefined();
  });

  test("startup fork-subagent (branch has entry + PI_SUBAGENT set) restores from session entries", async () => {
    // A fork subagent runs with `pi --session <fork>` (startup) and inherits the host's
    // session branch, which carries the feature snapshot — it must restore from it.
    enableSubagentMode();
    const { ctx } = makeCtx(branchWithFeatureEntry(SLUG));

    const fake = createFakePi();
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "startup" }, ctx as unknown as ExtensionContext);

    expect(getActiveFeatureSlug()).toBe(SLUG);
  });
});

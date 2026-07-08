// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { getSettings } from "../../src/settings/settings-ui.js";
import { loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  cleanupAfterTest,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  setupPiCtx,
  TUI_MODE,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("mark feature done on finish via phase_ready", () => {
  let originalUatMode: string | undefined;

  beforeEach(() => {
    setTestSettings(null);
    originalUatMode = getSettings().uatMode;
  });

  afterEach(() => {
    _resetFeatureState();
    if (originalUatMode !== undefined) {
      setSetting("uatMode", originalUatMode);
    }
    cleanupAfterTest();
  });

  const mockCtx = {
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget: () => {},
      select: async () => "next",
      setEditorText: () => {},
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  const noUICtx = {
    hasUI: false,
    sessionManager: { getBranch: () => [] },
    ui: { setWidget: () => {} },
  } as unknown as ExtensionContext;

  type PhaseReadyTool = { execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> };

  /** Drive a feature to the finish pointer (all prior phases derived done). */
  async function setupAtFinish(
    slug: string,
    designDocSlug: string,
  ): Promise<{ fake: ReturnType<typeof createPiWithToolCapture>["fake"]; phaseReady: PhaseReadyTool }> {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: `docs/ff/designs/${designDocSlug}-design.md` },
      } as unknown as ExtensionEvent,
      noUICtx,
    );
    const featureState = loadFeatureState(slug, null);
    if (!featureState) throw new Error("Feature state not found");
    featureState.workflow.currentPhase = "finish";
    saveFeatureState(featureState, null);
    enableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, noUICtx);
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as PhaseReadyTool;
    return { fake, phaseReady };
  }

  test("feature state file is marked done when phase_ready is called in finish phase", async () => {
    const { phaseReady } = await setupAtFinish("2026-04-01-done-feature", "2026-04-01-done-feature");
    disableSubagentMode();

    const result = await phaseReady.execute("tc-finish", {}, undefined, undefined, mockCtx);

    expect(result.content[0].text).toBe("");
    const stateAfter = loadFeatureState("2026-04-01-done-feature", null);
    expect(stateAfter?.completedAt).not.toBeNull();
    // B1: the done feature stays the active one (slot kept, not cleared) so the widget
    // can render the terminal DONE line until the next feature displaces it.
    expect(getActiveFeatureSlug()).toBe("2026-04-01-done-feature");
    expect(process.env.PI_FF_FEATURE).toBe("2026-04-01-done-feature");
  });

  // NOTE: In the redesigned pointer model, reaching the `finish` pointer means every
  // earlier phase — including uat — is DERIVED done (status is derived from the
  // pointer + completedAt; there is no stored status map). The old "uat still
  // pending at finish" guard is therefore unreachable: phase_ready at finish marks
  // the feature done regardless of uatMode. UAT now happens BEFORE finish
  // (after-review: review→uat→finish) or is accepted via /uat-accept. These two
  // tests assert the new reachable behavior (marked done at finish).
  test("phase_ready at finish marks the feature done (uat derived done from the finish pointer)", async () => {
    const { phaseReady } = await setupAtFinish("2026-04-01-uat-pending", "2026-04-01-uat-pending");
    disableSubagentMode();

    const result = await phaseReady.execute("tc-finish", {}, undefined, undefined, mockCtx);

    // No "UAT not resolved" guard — reaching finish derives uat as done.
    expect(result.content[0].text).not.toContain("UAT not yet resolved");
    const stateAfter = loadFeatureState("2026-04-01-uat-pending", null);
    expect(stateAfter?.completedAt).not.toBeNull();
  });

  test("phase_ready at finish marks done in after-finish mode too (UAT routed at review end)", async () => {
    setSetting("uatMode", "after-finish");
    const { phaseReady } = await setupAtFinish("2026-04-01-after-finish-uat", "2026-04-01-after-finish-uat");
    disableSubagentMode();

    const result = await phaseReady.execute("tc-finish", {}, undefined, undefined, mockCtx);

    expect(result.content[0].text).toBe("");
    const stateAfter = loadFeatureState("2026-04-01-after-finish-uat", null);
    expect(stateAfter?.completedAt).not.toBeNull();
  });

  test("agent_end does NOT mark feature done in finish phase (old detection removed)", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");
    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");

    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-04-01-agent-end-feature-design.md" },
      } as unknown as ExtensionEvent,
      noUICtx,
    );

    const featureState = loadFeatureState("2026-04-01-agent-end-feature", null);
    if (!featureState) throw new Error("Feature state not found");
    featureState.workflow.currentPhase = "finish";
    saveFeatureState(featureState, null);

    enableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, noUICtx);

    disableSubagentMode();
    await onToolCall(
      {
        toolCallId: "call-skill",
        toolName: "read",
        input: { path: "skills/ff-finish/SKILL.md" },
      } as unknown as ExtensionEvent,
      mockCtx,
    );
    await onToolResult(
      {
        toolCallId: "call-skill",
        toolName: "read",
        input: { path: "skills/ff-finish/SKILL.md" },
        content: [{ type: "text", text: "skill content" }],
      } as unknown as ExtensionEvent,
      mockCtx,
    );

    await onAgentEnd({} as unknown as ExtensionEvent, mockCtx);

    const stateAfter = loadFeatureState("2026-04-01-agent-end-feature", null);
    expect(stateAfter?.completedAt).toBeNull();
    expect(getActiveFeatureSlug()).toBe("2026-04-01-agent-end-feature");
  });

  test("retryable error does not prevent phase_ready from working", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");

    await onToolCall(
      {
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "docs/ff/designs/2026-04-01-retryable-feature-design.md" },
      } as unknown as ExtensionEvent,
      noUICtx,
    );

    const featureState = loadFeatureState("2026-04-01-retryable-feature", null);
    if (!featureState) throw new Error("Feature state not found");
    featureState.workflow.currentPhase = "finish";
    saveFeatureState(featureState, null);

    enableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, noUICtx);

    disableSubagentMode();
    await onAgentEnd(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider returned error: 502 Bad Gateway",
          } as unknown as import("@earendil-works/pi-agent-core").AgentMessage,
        ],
      } as unknown as ExtensionEvent,
      mockCtx,
    );

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as PhaseReadyTool;
    const result = await phaseReady.execute("tc-finish", {}, undefined, undefined, mockCtx);

    expect(result.content[0].text).toBe("");
    const stateAfter = loadFeatureState("2026-04-01-retryable-feature", null);
    expect(stateAfter?.completedAt).not.toBeNull();
    // B1: the done feature stays the active one (slot kept, not cleared).
    expect(getActiveFeatureSlug()).toBe("2026-04-01-retryable-feature");
  });

  test("completion notify carries the worth-notes pointer when the file exists", async () => {
    const slug = "2026-04-01-completion-worth-notes";
    const { phaseReady } = await setupAtFinish(slug, slug);
    disableSubagentMode();
    // Write a non-empty worth-notes file at the slug path so worthNotesPointer is non-null.
    const notesPath = path.join(process.cwd(), ".ff", "reviews", slug, `${slug}-worth-notes.md`);
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.writeFileSync(notesPath, "## worth noting\n- oddity\n");

    const notify = vi.fn();
    const ui = { setWidget: () => {}, select: async () => "next", setEditorText: () => {}, notify };
    const ctx = { hasUI: true, sessionManager: { getBranch: () => [] }, ui };
    // The completion notify reads from globalThis.__piCtx (not the raw ctx); stash our spy UI into
    // the guard so the notify is captured (setupAtFinish's session_start stashed noUICtx instead).
    setupPiCtx(ui, TUI_MODE);
    await phaseReady.execute("tc-finish", {}, undefined, undefined, ctx);

    // The completion notify ('Feature "<slug>" completed.') carries the worth-notes pointer
    // (existence + path) appended — never standalone (notifications are exclusive).
    expect(notify).toHaveBeenCalled();
    const msg = vi.mocked(notify).mock.calls[0][0] as string;
    expect(msg).toContain(`Feature "${slug}" completed.`);
    expect(msg).toContain("📝 worth-notes:");
  });

  test("after-finish UAT notify merges the worth-notes pointer when the file exists", async () => {
    setSetting("uatMode", "after-finish");
    const slug = "2026-04-01-after-finish-worth-notes";
    const { phaseReady } = await setupAtFinish(slug, slug);
    disableSubagentMode();
    // Write a non-empty worth-notes file at the slug path so worthNotesPointer is non-null.
    const notesPath = path.join(process.cwd(), ".ff", "reviews", slug, `${slug}-worth-notes.md`);
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.writeFileSync(notesPath, "## worth noting\n- oddity\n");

    const notify = vi.fn();
    const ui = { setWidget: () => {}, select: async () => "next", setEditorText: () => {}, notify };
    const ctx = { hasUI: true, sessionManager: { getBranch: () => [] }, ui };
    // transitionToUatPhase notifies via globalThis.__piCtx, not the raw ctx.
    setupPiCtx(ui, TUI_MODE);
    await phaseReady.execute("tc-finish", {}, undefined, undefined, ctx);

    // The after-finish UAT handoff notify (review summary + worth-notes pointer) is fired via
    // transitionToUatPhase with notifyMessage set. Worth-notes must be MERGED in.
    expect(notify).toHaveBeenCalled();
    const msgs = vi.mocked(notify).mock.calls.map((c) => c[0] as string);
    const uatNotify = msgs.find((m) => m.includes("📝 worth-notes:"));
    expect(uatNotify).toBeTruthy();
    // The merged message also carries the regenerated review report, not just the pointer.
    expect(uatNotify).not.toBe("📝 worth-notes:" + "");
  });

  test("after-finish UAT notify omits the worth-notes pointer when the file is absent", async () => {
    setSetting("uatMode", "after-finish");
    const slug = "2026-04-01-after-finish-no-notes";
    const { phaseReady } = await setupAtFinish(slug, slug);
    disableSubagentMode();
    // No worth-notes file written → pointer is null → notifyMessage is the report alone.

    const notify = vi.fn();
    const ui = { setWidget: () => {}, select: async () => "next", setEditorText: () => {}, notify };
    const ctx = { hasUI: true, sessionManager: { getBranch: () => [] }, ui };
    setupPiCtx(ui, TUI_MODE);
    await phaseReady.execute("tc-finish", {}, undefined, undefined, ctx);

    expect(notify).toHaveBeenCalled();
    const msgs = vi.mocked(notify).mock.calls.map((c) => c[0] as string);
    // The after-finish UAT notify fired (transitionToUatPhase got a notifyMessage = report),
    // but it must NOT carry a worth-notes pointer (none exists).
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.every((m) => !m.includes("📝 worth-notes:"))).toBe(true);
  });
});

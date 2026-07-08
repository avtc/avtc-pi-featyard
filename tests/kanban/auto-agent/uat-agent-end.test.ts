// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../../src/index.js";
import { loadFeatureState } from "../../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../../helpers/settings-test-helpers.js";
import {
  cleanupAfterTest,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  writeFeatureStateFile,
} from "../../helpers/workflow-monitor-test-helpers.js";

describe("phase_ready finish — UAT guard", () => {
  beforeEach(() => {
    setTestSettings(null);
  });

  afterEach(() => {
    _resetFeatureState();
    cleanupAfterTest();
  });

  const mockCtx = {
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget: () => {},
      notify: () => {},
      select: async () => "next",
      setEditorText: () => {},
    },
  };
  const noUICtx = {
    hasUI: false,
    sessionManager: { getBranch: () => [] },
    ui: { setWidget: () => {} },
  };

  /** Set up a feature at the finish pointer and return its phase_ready tool. */
  async function setupAtFinish(
    fake: { handlers: Map<string, unknown[]> },
    registeredTools: unknown[],
    slug: string,
  ): Promise<ToolDefinition> {
    writeFeatureStateFile(slug, {
      workflow: { currentPhase: "finish", designDoc: "docs/ff/designs/d.md", planDoc: ".ff/task-plans/p.md" },
    });
    enableSubagentMode();
    await fireAllHandlers(fake.handlers as Map<string, Handler[]>, "session_start", { reason: "new" }, noUICtx);
    return registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as unknown as ToolDefinition;
  }

  test("feature is marked done when uat is complete", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);

    const slug = "2026-05-16-uat-complete-test";
    const phaseReady = await setupAtFinish(fake, registeredTools, slug);
    disableSubagentMode();
    const result = await phaseReady.execute(
      "tc-finish",
      {},
      undefined,
      undefined,
      mockCtx as unknown as ExtensionContext,
    );

    expect((result.content[0] as { text: string }).text).toBe("");
    const state = loadFeatureState(slug, null);
    expect(state?.completedAt).not.toBeNull();
  });

  test("feature is marked done when uat is bypassed", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);

    const slug = "2026-05-16-uat-skipped-test";
    const phaseReady = await setupAtFinish(fake, registeredTools, slug);
    disableSubagentMode();
    const result = await phaseReady.execute(
      "tc-finish",
      {},
      undefined,
      undefined,
      mockCtx as unknown as ExtensionContext,
    );

    expect((result.content[0] as { text: string }).text).toBe("");
    const state = loadFeatureState(slug, null);
    expect(state?.completedAt).not.toBeNull();
  });

  // NOTE: The redesigned pointer model derives phase status from currentPhase +
  // completedAt (no status map). Reaching the `finish` pointer means uat (an
  // earlier phase) is DERIVED done, so the old "uat still pending at finish"
  // guard is unreachable. phase_ready at finish marks the feature done. UAT now
  // occurs before finish (after-review) or is accepted via /uat-accept.
  test("phase_ready at finish marks done (uat derived done from the finish pointer)", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);

    const slug = "2026-05-16-uat-pending-test";
    const phaseReady = await setupAtFinish(fake, registeredTools, slug);
    disableSubagentMode();
    const result = await phaseReady.execute(
      "tc-finish",
      {},
      undefined,
      undefined,
      mockCtx as unknown as ExtensionContext,
    );

    // No "UAT not resolved" guard fires — reaching finish derives uat as done.
    expect((result.content[0] as { text: string }).text).not.toContain("UAT not yet resolved");
    const state = loadFeatureState(slug, null);
    expect(state?.completedAt).not.toBeNull();
  });

  test("phase_ready at finish marks done in after-finish mode (UAT routed at review end)", async () => {
    const { fake, registeredTools, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setSetting("uatMode", "after-finish");

    const slug = "2026-05-16-after-finish-uat-test";
    const phaseReady = await setupAtFinish(fake, registeredTools, slug);
    disableSubagentMode();
    const result = await phaseReady.execute(
      "tc-finish",
      {},
      undefined,
      undefined,
      mockCtx as unknown as ExtensionContext,
    );

    expect((result.content[0] as { text: string }).text).toBe("");
    const state = loadFeatureState(slug, null);
    expect(state?.completedAt).not.toBeNull();
  });
});

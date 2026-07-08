// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../../src/index.js";
import { setAutoAgentCallback } from "../../../src/kanban/auto-agent/auto-agent-state-machine.js";
import {
  BRAINSTORM_ACTIVE_STATE,
  createPiWithToolCapture,
  fireAllHandlers,
  getSingleHandler,
  NO_AUTO_AGENT_CALLBACK,
  writeFeatureStateFile,
} from "../../helpers/workflow-monitor-test-helpers.js";

const UI_CTX = {
  hasUI: true,
  sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
  ui: { setWidget: () => {}, select: async () => "Continue" },
} as unknown as ExtensionContext;

describe("agent_end design-completion detection (removed)", () => {
  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FF_FEATURE;
    setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
  });

  test("does NOT fire onFeatureComplete when design doc exists and designReviewLoopCount === 0", async () => {
    // Regression test: the old agent_end heuristic fired onFeatureComplete whenever
    // a design doc was present and designReviewLoopCount was 0. This caused the
    // auto-designer to skip review iterations and pick the next feature immediately
    // if the agent's turn ended mid-design (e.g. asking a question, context limit).
    // Design completion is now handled exclusively by the phase_ready tool.
    const onFeatureComplete = vi.fn();
    setAutoAgentCallback({
      isActive: () => true,
      onFeatureComplete,
      onFeatureError: vi.fn(),
      onBlock: vi.fn(),
      onUnblock: vi.fn(),
      onFeatureUatHandoff: vi.fn(),
    });

    const { fake, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-30-no-agent-end-detect", {
      ...BRAINSTORM_ACTIVE_STATE,
      designReviewLoopCount: 0,
    });

    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/2026-05-30-no-agent-end-detect-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, UI_CTX);

    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd({ stopReason: "end_turn" } as unknown as ExtensionEvent, UI_CTX);

    // Should NOT have called onFeatureComplete — phase_ready is the sole mechanism
    expect(onFeatureComplete).not.toHaveBeenCalled();
  });

  test("does NOT fire onFeatureComplete when design doc exists and designReviewLoopCount > 0", async () => {
    const onFeatureComplete = vi.fn();
    setAutoAgentCallback({
      isActive: () => true,
      onFeatureComplete,
      onFeatureError: vi.fn(),
      onBlock: vi.fn(),
      onUnblock: vi.fn(),
      onFeatureUatHandoff: vi.fn(),
    });

    const { fake, api } = createPiWithToolCapture();
    writeFeatureStateFile("2026-05-30-review-in-progress", {
      ...BRAINSTORM_ACTIVE_STATE,
      designReviewLoopCount: 1,
    });

    fs.mkdirSync("docs/ff/designs", { recursive: true });
    fs.writeFileSync("docs/ff/designs/2026-05-30-review-in-progress-design.md", "# Design");

    await workflowMonitorExtension(api as unknown as ExtensionAPI);

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, UI_CTX);

    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd({ stopReason: "end_turn" } as unknown as ExtensionEvent, UI_CTX);

    expect(onFeatureComplete).not.toHaveBeenCalled();
  });
});

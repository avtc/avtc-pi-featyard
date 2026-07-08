// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import {
  createFakePi,
  EXECUTE_ACTIVE,
  fireAllHandlers,
  getSingleHandler,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

afterEach(() => {});

describe("recoverable escalation for verification", () => {
  test("preCommitDiscipline advisory never escalates verification violations", async () => {
    const fake = createFakePi();
    writeFeatureStateFile("test-verify-esc", {
      workflow: EXECUTE_ACTIVE,
      verification: { passed: false, waived: false },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    let promptCount = 0;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          promptCount++;
          return "Yes, continue";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Multiple verification violations with advisory — never prompt
    await onToolCall(
      { toolCallId: "b1", toolName: "bash", input: { command: "git commit -m 'test'" } } as unknown as ExtensionEvent,
      ctx,
    );
    await onToolCall(
      { toolCallId: "b2", toolName: "bash", input: { command: "git commit -m 'test2'" } } as unknown as ExtensionEvent,
      ctx,
    );
    expect(promptCount).toBe(0);
  });
});

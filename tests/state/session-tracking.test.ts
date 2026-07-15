// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, setWorkflowInitiatedNewSession } from "../../src/index.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import {
  createFakePi,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  getExtendedToolHandlers,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("session file tracking", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  test("session_start with reason=new appends session file to sessionFiles", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    const slug = writeFeatureStateFile("session-track-test", {});
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const prevEnv = process.env.PI_FY_FEATURE;
    process.env.PI_FY_FEATURE = slug;

    try {
      const mockCtx = {
        hasUI: true,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session-1.jsonl" },
        ui: { setWidget: () => {} },
      };

      await fireAllHandlers(fake.handlers, "session_start", { reason: "startup" }, mockCtx);

      const state = loadFeatureState(slug, null);
      expect(state?.sessionFiles).toContain("/tmp/session-1.jsonl");
    } finally {
      if (prevEnv) {
        process.env.PI_FY_FEATURE = prevEnv;
      } else {
        delete process.env.PI_FY_FEATURE;
      }
    }
  });

  test("sessionFiles starts empty for new feature", () => {
    const _fake = createFakePi();
    const slug = writeFeatureStateFile("session-empty-test", {});
    const state = loadFeatureState(slug, null);
    expect(state?.sessionFiles).toEqual([]);
  });

  test("session_start skips subagent sessions (hasUI=false)", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    const slug = writeFeatureStateFile("session-subagent-test", {});
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const prevEnv = process.env.PI_FY_FEATURE;
    process.env.PI_FY_FEATURE = slug;

    try {
      const mockCtx = {
        hasUI: false,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/subagent-session.jsonl" },
        ui: { setWidget: () => {} },
      };

      await fireAllHandlers(fake.handlers, "session_start", { reason: "startup" }, mockCtx);

      const state = loadFeatureState(slug, null);
      expect(state?.sessionFiles).not.toContain("/tmp/subagent-session.jsonl");
    } finally {
      if (prevEnv) {
        process.env.PI_FY_FEATURE = prevEnv;
      } else {
        delete process.env.PI_FY_FEATURE;
      }
    }
  });

  test("session_start does not duplicate session file", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    const slug = writeFeatureStateFile("session-dup-test", { sessionFiles: ["/tmp/session-1.jsonl"] });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const prevEnv = process.env.PI_FY_FEATURE;
    process.env.PI_FY_FEATURE = slug;

    try {
      const mockCtx = {
        hasUI: true,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session-1.jsonl" },
        ui: { setWidget: () => {} },
      };

      await fireAllHandlers(fake.handlers, "session_start", { reason: "startup" }, mockCtx);

      const state = loadFeatureState(slug, null);
      expect(state?.sessionFiles.filter((f: string) => f === "/tmp/session-1.jsonl")).toHaveLength(1);
    } finally {
      if (prevEnv) {
        process.env.PI_FY_FEATURE = prevEnv;
      } else {
        delete process.env.PI_FY_FEATURE;
      }
    }
  });

  test("writing design doc tracks current session in new feature state", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const handlers = getExtendedToolHandlers(fake);

    const mockCtx = {
      hasUI: true,
      sessionManager: {
        getBranch: () => [],
        getSessionFile: () => "/tmp/design-session.jsonl",
      },
      ui: { setWidget: () => {}, notify: () => {}, select: async () => "" },
    } as unknown as ExtensionContext;

    // Trigger designing skill to set phase
    await handlers.onInput({ text: "/skill:fy-design" } as unknown as ExtensionEvent, mockCtx);

    // Write a design doc — this creates the feature state
    const designPath = "docs/featyard/designs/2026-05-21-session-create-test-design.md";
    await handlers.onToolCall(
      {
        toolName: "write",
        toolCallId: "tc-design",
        input: { path: designPath, content: "# Design" },
      } as unknown as ExtensionEvent,
      mockCtx,
    );
    await handlers.onToolResult(
      {
        toolName: "write",
        toolCallId: "tc-design",
        input: { path: designPath, content: "# Design" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      mockCtx,
    );

    // Verify session file was tracked in the newly created state
    const state = loadFeatureState("2026-05-21-session-create-test", null);
    expect(state).not.toBeNull();
    expect(state?.sessionFiles).toContain("/tmp/design-session.jsonl");
  });

  test("workflow-initiated newSession does not leak session into previous feature", async () => {
    disableSubagentMode();
    // Simulate: Feature A was active, auto-agent picks Feature B.
    // _activateFeature clears the env var BEFORE calling newSession(),
    // so session_start(reason="new") should NOT bind to any feature.
    const fake = createFakePi();
    const slugA = writeFeatureStateFile("feature-a", { sessionFiles: ["/tmp/session-a1.jsonl"] });
    const slugB = writeFeatureStateFile("feature-b", {});
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const prevEnv = process.env.PI_FY_FEATURE;
    // Simulate what _activateFeature does: clear env var before newSession
    delete process.env.PI_FY_FEATURE;

    try {
      // Mark as workflow-initiated (simulates what _activateFeature does before newSession)
      setWorkflowInitiatedNewSession("/skill:fy-design Work on feature B");

      const mockCtx = {
        hasUI: true,
        sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session-b1.jsonl" },
        ui: { setWidget: () => {} },
      };

      await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

      // Feature A's sessionFiles must NOT contain the new session
      const stateA = loadFeatureState(slugA, null);
      expect(stateA?.sessionFiles).toEqual(["/tmp/session-a1.jsonl"]);

      // Feature B's sessionFiles must also NOT be touched by session_start
      // (the withSession callback handles that)
      const stateB = loadFeatureState(slugB, null);
      expect(stateB?.sessionFiles).toEqual([]);
    } finally {
      if (prevEnv) {
        process.env.PI_FY_FEATURE = prevEnv;
      } else {
        delete process.env.PI_FY_FEATURE;
      }
    }
  });

  test("writing design doc does not track session for subagent (hasUI=false)", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    const handlers = getExtendedToolHandlers(fake);

    const mockCtx = {
      hasUI: false, // subagent
      sessionManager: {
        getBranch: () => [],
        getSessionFile: () => "/tmp/subagent-session.jsonl",
      },
      ui: { setWidget: () => {}, notify: () => {}, select: async () => "" },
    } as unknown as ExtensionContext;

    // Trigger designing skill to set phase
    await handlers.onInput({ text: "/skill:fy-design" } as unknown as ExtensionEvent, mockCtx);

    // Write a design doc
    const designPath = "docs/featyard/designs/2026-05-21-subagent-track-test-design.md";
    await handlers.onToolCall(
      {
        toolName: "write",
        toolCallId: "tc-design",
        input: { path: designPath, content: "# Design" },
      } as unknown as ExtensionEvent,
      mockCtx,
    );
    await handlers.onToolResult(
      {
        toolName: "write",
        toolCallId: "tc-design",
        input: { path: designPath, content: "# Design" },
        content: [{ type: "text", text: "ok" }],
      } as unknown as ExtensionEvent,
      mockCtx,
    );

    // Verify session file was NOT tracked for subagent
    const state = loadFeatureState("2026-05-21-subagent-track-test", null);
    expect(state).not.toBeNull();
    expect(state?.sessionFiles).not.toContain("/tmp/subagent-session.jsonl");
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { createFakePi, fireAllHandlers, writeFeatureStateFile } from "../helpers/workflow-monitor-test-helpers.js";

// Session resume from last session file: when a feature is loaded on session_start
// and has tracked session files, the extension should offer to resume from the
// last session file for context recovery (section 3.3.2).

describe("Session resume from last session file", () => {
  afterEach(() => {
    _resetFeatureState();
  });

  test("offers to resume from last session file on feature load", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const slug = "2026-05-16-session-resume";
    // Create a fake session file
    const sessionDir = path.join(process.cwd(), ".pi", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "test-session.jsonl");
    fs.writeFileSync(sessionFile, "[]\n");

    writeFeatureStateFile(slug, {
      featureSlug: slug,
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: { designDoc: null, planDoc: null, reviewDocs: [] },
      },
      sessionFiles: [sessionFile],
    });

    process.env.PI_FY_FEATURE = slug;

    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        notify: () => {},
        select: vi.fn().mockResolvedValue("Resume from last session"),
      },
      switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    // Should have offered to resume from the last session file
    const selectCalls = mockCtx.ui.select.mock.calls;
    const resumeCall = selectCalls.find((c: string[]) => c[0]?.includes("resume") || c[0]?.includes("session"));
    expect(resumeCall).toBeDefined();

    // Since user chose "Resume", switchSession should be called with the session file and a withSession callback
    expect(mockCtx.switchSession).toHaveBeenCalledWith(
      sessionFile,
      expect.objectContaining({ withSession: expect.any(Function) }),
    );

    delete process.env.PI_FY_FEATURE;
  });

  test("continues fresh when user declines resume", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const slug = "2026-05-16-session-decline";
    const sessionDir = path.join(process.cwd(), ".pi", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "test-session-2.jsonl");
    fs.writeFileSync(sessionFile, "[]\n");

    writeFeatureStateFile(slug, {
      featureSlug: slug,
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: { designDoc: null, planDoc: null, reviewDocs: [] },
      },
      sessionFiles: [sessionFile],
    });

    process.env.PI_FY_FEATURE = slug;

    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        notify: () => {},
        select: vi.fn().mockResolvedValue("Continue fresh"),
      },
      switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    // User declined — switchSession should NOT be called
    expect(mockCtx.switchSession).not.toHaveBeenCalled();

    delete process.env.PI_FY_FEATURE;
  });

  test("skips resume offer when session file does not exist on disk", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const slug = "2026-05-16-session-missing";
    writeFeatureStateFile(slug, {
      featureSlug: slug,
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: { designDoc: null, planDoc: null, reviewDocs: [] },
      },
      sessionFiles: ["/nonexistent/session.jsonl"],
    });

    process.env.PI_FY_FEATURE = slug;

    const mockCtx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        notify: () => {},
        select: vi.fn().mockResolvedValue("Continue: 2026-05-16-session-missing"),
      },
      switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    };

    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, mockCtx);

    // Session file doesn't exist — should NOT offer resume
    const selectCalls = mockCtx.ui.select.mock.calls;
    const resumeCall = selectCalls.find(
      (c: string[]) => c[0]?.includes("resume") || (c[1] && JSON.stringify(c[1]).includes("Resume")),
    );
    expect(resumeCall).toBeUndefined();
    expect(mockCtx.switchSession).not.toHaveBeenCalled();

    delete process.env.PI_FY_FEATURE;
  });
});

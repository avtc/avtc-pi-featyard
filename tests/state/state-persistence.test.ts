// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import workflowMonitorExtension, { getStateFilePath, reconstructState } from "../../src/index.js";
import * as logging from "../../src/log.js";
import {
  createFeatureSession,
  createGuardrailsState,
  type FeatyardStatePatch,
} from "../../src/state/feature-session.js";
import type { FeatureState } from "../../src/state/feature-state.js";
import { createFakePi, getSingleHandler, withTempCwd } from "../helpers/workflow-monitor-test-helpers.js";

describe("FeatureSession aggregated state persistence", () => {
  test("getFullState aggregates feature + verification state", () => {
    const handler = createFeatureSession(null);

    handler.processSkillInput("/skill:fy-plan");
    handler.recordVerificationWaiver();

    // Guardrails state is now verification-only (the TDD write-order check is
    // stateless; git is its source of truth). featureState is null until a
    // feature is activated.
    expect(handler.getFullState()).toEqual({
      featureState: null,
      guardrailsState: { verification: "waived" },
    });
  });

  test("setFullState distributes state to all subsystems", () => {
    const handler = createFeatureSession(null);
    const featureState: FeatureState = {
      featureSlug: "2026-02-15-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
      createdAt: "2026-02-15T00:00:00.000Z",
      updatedAt: "2026-02-15T00:00:00.000Z",
      completedAt: null,
      workflow: {
        currentPhase: "plan",
        designDoc: "docs/featyard/designs/2026-02-15-feature-design.md",
        planDoc: null,
      },
      sessionFiles: [],
      featureId: null,
      design: { doc: "docs/featyard/designs/2026-02-15-feature-design.md", reviewActive: false, reviewLoopCount: 0 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
      implement: { taskReviewRounds: {}, currentTask: null },
      verify: { verifyLoopCount: 0 },
      review: { reviewLoopCount: 0, reviewHistory: [] },
    };
    const snapshot: FeatyardStatePatch = {
      featureState,
      guardrailsState: { verification: "waived" },
    };

    handler.setFullState(snapshot);

    expect(handler.getFullState()).toEqual(snapshot);
    expect(handler.getVerificationState()).toBe("waived");
  });

  test("round-trips full state snapshot", () => {
    const source = createFeatureSession(null);

    source.processSkillInput("/skill:fy-plan");
    source.recordVerificationWaiver();

    const snapshot = source.getFullState();

    const target = createFeatureSession(null);
    target.setFullState(snapshot);

    expect(target.getFullState()).toEqual(snapshot);
  });

  test("setFullState tolerates missing sections defensively", () => {
    const handler = createFeatureSession(null);

    expect(() => handler.setFullState({} as FeatyardStatePatch)).not.toThrow();
  });

  test("setFullState accepts partial guardrails input defensively", () => {
    const handler = createFeatureSession(null);

    // A partial guardrails patch (verification only) must apply without throwing.
    expect(() =>
      handler.setFullState({ guardrailsState: { verification: "waived" } } as FeatyardStatePatch),
    ).not.toThrow();

    expect(handler.getFullState().guardrailsState.verification).toBe("waived");
  });

  test("setFullState ignores a stale 'tdd' slice from older snapshots (backward-tolerant)", () => {
    const handler = createFeatureSession(null);

    // Older sessions persisted a `tdd` slice inside guardrailsState; the new
    // model has no such slice. An incoming patch carrying it must be ignored,
    // not crash, and only `verification` is applied.
    expect(() =>
      handler.setFullState({
        guardrailsState: {
          verification: "passed",
          tdd: { stage: "red", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        },
      } as FeatyardStatePatch),
    ).not.toThrow();

    expect(handler.getVerificationState()).toBe("passed");
  });

  test("resetState restores all subsystems to defaults", () => {
    const handler = createFeatureSession(null);

    handler.processSkillInput("/skill:fy-plan");
    handler.recordVerificationWaiver();

    handler.resetState();

    expect(handler.getFullState()).toEqual({
      featureState: null,
      guardrailsState: { verification: "not-run" },
    });
  });
});

describe("file-based state persistence", () => {
  test("getStateFilePath returns null when no active feature slug", () => {
    withTempCwd();

    const result = getStateFilePath();
    expect(result).toBeNull();
  });

  test("reconstructState reads from file when it exists", () => {
    const tempDir = withTempCwd();
    const handler = createFeatureSession(null);
    const featureState: FeatureState = {
      featureSlug: "file-feature",
      git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      workflow: {
        currentPhase: "plan",
        designDoc: "docs/featyard/designs/file-design.md",
        planDoc: null,
      },
      sessionFiles: [],
      featureId: null,
      design: { doc: "docs/featyard/designs/file-design.md", reviewActive: false, reviewLoopCount: 0 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
      implement: { taskReviewRounds: {}, currentTask: null },
      verify: { verifyLoopCount: 0 },
      review: { reviewLoopCount: 0, reviewHistory: [] },
    };

    const statePath = path.join(tempDir, ".pi", "test-state.json");
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(featureState, null, 2));

    reconstructState(
      {
        sessionManager: {
          getBranch: () => [{ type: "custom", customType: "featyard_state", data: { workflow: null } }],
        },
      } as unknown as ExtensionContext,
      handler,
      statePath,
    );

    expect(handler.getFullState()).toEqual({
      featureState,
      guardrailsState: createGuardrailsState(),
    });
  });

  test("reconstructState logs warning when state file has invalid JSON", () => {
    const tempDir = withTempCwd();
    const handler = createFeatureSession(null);

    const statePath = path.join(tempDir, ".pi", "test-state.json");
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(statePath, "not valid json{{{", "utf-8");

    const warnSpy = vi.spyOn(logging.log, "warn");

    reconstructState(
      {
        sessionManager: {
          getBranch: () => [],
        },
      } as unknown as ExtensionContext,
      handler,
      statePath,
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to read state file"));
    warnSpy.mockRestore();
  });

  test("reconstructState returns defaults when file does not exist", () => {
    withTempCwd();

    const handler = createFeatureSession(null);

    reconstructState(
      {
        sessionManager: {
          getBranch: () => [],
        },
      } as unknown as ExtensionContext,
      handler,
      null,
    );

    expect(handler.getFullState()).toEqual({
      featureState: null,
      guardrailsState: createGuardrailsState(),
    });
  });
});

describe("workflow-monitor state reconstruction + persistence wiring", () => {
  test("reconstructs fresh defaults when branch has no persisted state entries", () => {
    const handler = createFeatureSession(null);
    handler.processSkillInput("/skill:fy-plan");
    handler.recordVerificationWaiver();

    reconstructState(
      {
        sessionManager: {
          getBranch: () => [],
        },
      } as unknown as ExtensionContext,
      handler,
      false,
    );

    expect(handler.getFullState()).toEqual({
      featureState: null,
      guardrailsState: createGuardrailsState(),
    });
  });

  test("persists to session entries when no feature slug active", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    const onInput = getSingleHandler(fake.handlers, "input");
    await onInput(
      { type: "input", text: "/skill:fy-design" } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    await onToolResult(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "read",
        input: { path: "/home/pi/workspace/my-project/skills/fy-plan/SKILL.md" },
        content: [{ type: "text", text: "ok" }],
        details: {},
      } as unknown as ExtensionEvent,
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: () => {} },
      } as unknown as ExtensionContext,
    );

    expect(fake.appendedEntries.length).toBeGreaterThanOrEqual(1);
    const lastEntry = fake.appendedEntries[fake.appendedEntries.length - 1];
    expect((lastEntry as { customType?: string })?.customType).toBe("featyard_state");
    expect((lastEntry as { data?: { featureState?: FeatureState | null } })?.data?.featureState).toBeNull();
  });
});

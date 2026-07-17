// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import type { FeatyardConfig } from "../../src/settings/model-overrides.js";
import { resetFeatyardConfig, setFeatyardConfig } from "../../src/settings/settings-ui.js";
import { loadFeatureState } from "../../src/state/feature-state.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  getToolHandlers,
  settleAndDrainPostTurnFollowUp,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

/** No UI available (headless mode) */
const NO_UI = false;

/** Mock was called (track that a call occurred) */
const MOCK_CALLED = true;

/** setModel succeeded */
const SET_MODEL_SUCCEEDED = true;

/** No custom skill content (use default) */
const NO_SKILL_CONTENT: string | null = null;

/** No session entries */
const NO_BRANCH: unknown[] | null = null;

function createCtx(branch: unknown[] | null) {
  return {
    hasUI: NO_UI,
    sessionManager: {
      getBranch: () => branch ?? [],
    },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider: { id: provider }, id }),
    },
    ui: {
      setWidget: () => {},
      select: async () => "next",
      setEditorText: () => {},
      notify: () => {},
    },
  } as unknown as ExtensionContext;
}

/**
 * Simulate reading a skill SKILL.md file through the tool_result handler.
 */
async function readSkill(
  fake: ReturnType<typeof createFakePi>,
  ctx: ExtensionContext,
  skillPath: string,
  content: string | null,
) {
  const onToolResult = getSingleHandler(fake.handlers, "tool_result");
  return onToolResult(
    {
      type: "tool_call",
      toolCallId: "call-skill-read",
      toolName: "read",
      input: { path: skillPath },
      content: [{ type: "text", text: content ?? "# Skill\n..." }],
      details: {},
    } as unknown as ExtensionEvent,
    ctx,
  );
}

describe("skill-read model override removed", () => {
  test("skill read does not trigger setModel after handler removal", async () => {
    const fake = createFakePi();
    setTestSettings(null);
    const setModelCalls: unknown[] = [];
    fake.api.setModel = () => {
      setModelCalls.push(MOCK_CALLED);
      return Promise.resolve(SET_MODEL_SUCCEEDED);
    };
    fake.api.getModel = () => undefined;
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const ctx = createCtx(NO_BRANCH);
    await readSkill(fake, ctx, "/skills/fy-review/SKILL.md", NO_SKILL_CONTENT);

    expect(setModelCalls).toHaveLength(0);
  });
});

describe("auto-advance model overrides", () => {
  beforeEach(async () => {
    _resetFeatureState();
    resetFeatyardConfig();
  });

  test("setModel is called with review model override on verify→review via phase_ready", async () => {
    const slug = "2026-05-12-verify-to-review";
    const { fake, registeredTools, api } = createPiWithToolCapture();
    const setModelCalls: { provider: string; id: string }[] = [];
    api.setModel = ((model: Model<Api>) => {
      const m = model as { id?: string } | string;
      const mid: string = typeof m === "object" && "id" in m && m.id ? m.id : "unknown";
      const mp = model as { provider?: { id?: string } | string };
      const provider = mp?.provider;
      const pid =
        typeof provider === "object" && "id" in provider
          ? provider.id
          : typeof provider === "string"
            ? provider
            : undefined;
      setModelCalls.push({ provider: pid ?? "unknown", id: mid });
      return Promise.resolve(SET_MODEL_SUCCEEDED);
    }) as unknown as () => Promise<boolean>;
    api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "in-progress",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "verify",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    setFeatyardConfig({
      "stage-models": { review: "anthropic/claude-sonnet-4-5" },
      "default-model": null,
      "kanban-port": null,
    } as unknown as Required<FeatyardConfig>);

    setSetting("maxFeatureReviewRounds", 3);

    const { onToolCall, onToolResult } = getToolHandlers(fake);
    const ctx = createCtx(NO_BRANCH);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Simulate a bash tool_call + tool_result with a passing test command during verify phase
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "tc-bash-verify",
        toolName: "bash",
        input: { command: "npx vitest run" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    await onToolResult(
      {
        type: "tool_call",
        toolCallId: "tc-bash-verify",
        toolName: "bash",
        input: { command: "npx vitest run" },
        content: [{ type: "text", text: "\n Test Files  5 passed (5)\n Tests  42 passed (42)\n" }],
        details: { exitCode: 0 },
      } as unknown as ExtensionEvent,
      ctx,
    );

    // Call phase_ready to trigger verify→review transition
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-pr1", {}, undefined, undefined, ctx);

    // applyModelOverrideForPhase("review") should have been called during transition
    expect(setModelCalls.length).toBeGreaterThanOrEqual(1);
    expect(setModelCalls[0]).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });

    // Verify the review skill was dispatched
    await fireAllHandlers(fake.handlers, "agent_end", {}, ctx);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(fake.sentMessages[0].message).toContain("review");
  });

  test("setModel is called with verify model override on implement→verify via task_ready_advance", async () => {
    const slug = "2026-05-12-execute-to-verify";
    const { fake, registeredTools, api } = createPiWithToolCapture();
    const setModelCalls: { provider: string; id: string }[] = [];
    api.setModel = ((model: Model<Api>) => {
      const m = model as { id?: string } | string;
      const mid: string = typeof m === "object" && "id" in m && m.id ? m.id : "unknown";
      const mp = model as { provider?: { id?: string } | string };
      const provider = mp?.provider;
      const pid =
        typeof provider === "object" && "id" in provider
          ? provider.id
          : typeof provider === "string"
            ? provider
            : undefined;
      setModelCalls.push({ provider: pid ?? "unknown", id: mid });
      return Promise.resolve(SET_MODEL_SUCCEEDED);
    }) as unknown as () => Promise<boolean>;
    api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      implement: { taskReviewRounds: { "1-final-task": 1 }, currentTask: "1. Final task" },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    setFeatyardConfig({
      "stage-models": { verify: "deepseek/deepseek-chat" },
      "default-model": null,
      "kanban-port": null,
    } as unknown as Required<FeatyardConfig>);

    setSetting("maxFeatureReviewRounds", 0);

    const ctx = createCtx(NO_BRANCH);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Last task: call task_ready_advance with nextTask omitted → advances to verify.
    // (phase_ready is blocked in implement by the guardrails interceptor.)
    const taskReadyAdvance = registeredTools.find(
      (t) => (t as { name: string }).name === "task_ready_advance",
    ) as ToolDefinition;
    await taskReadyAdvance.execute("tc-tra1", {}, undefined, undefined, ctx);

    // applyModelOverrideForPhase("verify") should have been called during transition
    expect(setModelCalls.length).toBeGreaterThanOrEqual(1);
    expect(setModelCalls[0]).toEqual({ provider: "deepseek", id: "deepseek-chat" });

    // Verify the verification skill was dispatched
    await fireAllHandlers(fake.handlers, "agent_end", {}, ctx);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(fake.sentMessages[0].message).toContain("fy-verify");
  });
});

describe("env var sync after state transitions", () => {
  beforeEach(async () => {
    _resetFeatureState();
    resetFeatyardConfig();
    delete process.env.PI_FY_STAGE;
    delete process.env.PI_FY_REVIEW_LOOP;
  });

  test("verify→review via phase_ready syncs PI_FY_STAGE to review", async () => {
    const slug = "2026-05-12-env-verify-review";
    const { fake, registeredTools, api } = createPiWithToolCapture();
    api.setModel = () => Promise.resolve(SET_MODEL_SUCCEEDED);
    api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "verify",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
      review: { reviewLoopCount: 3, reviewHistory: [] },
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    setSetting("maxFeatureReviewRounds", 3);

    const { onToolCall, onToolResult } = getToolHandlers(fake);
    const ctx = createCtx(NO_BRANCH);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Simulate a bash tool_call + tool_result with a passing test command during verify phase
    await onToolCall(
      {
        type: "tool_call",
        toolCallId: "tc-bash-verify",
        toolName: "bash",
        input: { command: "npx vitest run" },
      } as unknown as ExtensionEvent,
      ctx,
    );
    await onToolResult(
      {
        type: "tool_call",
        toolCallId: "tc-bash-verify",
        toolName: "bash",
        input: { command: "npx vitest run" },
        content: [{ type: "text", text: "\n Test Files  5 passed (5)\n Tests  42 passed (42)\n" }],
        details: { exitCode: 0 },
      } as unknown as ExtensionEvent,
      ctx,
    );

    // Call phase_ready to trigger verify→review transition
    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-pr1", {}, undefined, undefined, ctx);

    // After verify→review transition, env vars should be synced
    expect(process.env.PI_FY_STAGE).toBe("review");
    // Loop count is the durable source of truth in feature-state (consumers read it
    // directly, not mirrored to an env var).
    expect(loadFeatureState(slug, null)?.review.reviewLoopCount).toBe(3);
  });

  test("implement→verify via task_ready_advance syncs PI_FY_STAGE to verify", async () => {
    const slug = "2026-05-12-env-execute-verify";
    const { fake, registeredTools, api } = createPiWithToolCapture();
    api.setModel = () => Promise.resolve(SET_MODEL_SUCCEEDED);
    api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      implement: { taskReviewRounds: { "1-final-task": 1 }, currentTask: "1. Final task" },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    setTestSettings(null);
    setTestSettings(null);

    setSetting("maxFeatureReviewRounds", 0);

    const ctx = createCtx(NO_BRANCH);

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Last task: call task_ready_advance with nextTask omitted → advances to verify.
    // (phase_ready is blocked in implement by the guardrails interceptor.)
    const taskReadyAdvance = registeredTools.find(
      (t) => (t as { name: string }).name === "task_ready_advance",
    ) as ToolDefinition;
    await taskReadyAdvance.execute("tc-tra1", {}, undefined, undefined, ctx);

    // After implement→verify transition, env vars should be synced
    expect(process.env.PI_FY_STAGE).toBe("verify");
  });

  test("session_start reload syncs env vars from restored state", async () => {
    const slug = "2026-05-12-env-reload";
    const fake = createFakePi();
    setTestSettings(null);
    fake.api.setModel = () => Promise.resolve(SET_MODEL_SUCCEEDED);
    fake.api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "review",
        designDoc: `docs/featyard/designs/${slug}-design.md`,
        planDoc: `.featyard/task-plans/${slug}-task-plan.md`,
      },
      review: { reviewLoopCount: 5, reviewHistory: [] },
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setSetting("maxFeatureReviewRounds", 3);

    const ctx = createCtx(NO_BRANCH);

    // Ensure env vars are not set before reload
    delete process.env.PI_FY_STAGE;
    delete process.env.PI_FY_REVIEW_LOOP;

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // After reload, the stage env var is restored from feature state; the review
    // loop count lives in feature-state (durable source of truth) directly.
    expect(process.env.PI_FY_STAGE).toBe("review");
    expect(loadFeatureState(slug, null)?.review.reviewLoopCount).toBe(5);
  });
});

describe("parseModelRef with multi-slash strings", () => {
  test("splits multi-slash model string correctly for modelRegistry.find", async () => {
    const slug = "2026-05-12-multi-slash-model";
    const fake = createFakePi();
    setTestSettings(null);
    const registryCalls: { provider: string; id: string }[] = [];

    fake.api.setModel = () => Promise.resolve(SET_MODEL_SUCCEEDED);
    fake.api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setFeatyardConfig({
      "stage-models": { verify: "openrouter/anthropic/claude-sonnet-4-5" },
      "default-model": null,
      "kanban-port": null,
    } as unknown as Required<FeatyardConfig>);

    setSetting("maxFeatureReviewRounds", 0);

    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        find: (provider: string, id: string) => {
          registryCalls.push({ provider, id });
          return { provider: { id: provider }, id };
        },
      },
      ui: { setWidget: () => {}, select: async () => "next", setEditorText: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;

    // Load the feature state written above into the handler so currentPhase="verify"
    // (verify/review/finish skills do not activate a fresh workflow on their own).
    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const onSkillRead = getSingleHandler(fake.handlers, "input");
    try {
      await onSkillRead({ type: "input", text: "/skill:fy-verify" } as unknown as ExtensionEvent, ctx);

      // parseModelRef should split on first slash: provider=openrouter, id=anthropic/claude-sonnet-4-5
      expect(registryCalls.length).toBeGreaterThanOrEqual(1);
      expect(registryCalls[0].provider).toBe("openrouter");
      expect(registryCalls[0].id).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      resetFeatyardConfig();
    }
  });
});

describe("subagent tool guards", () => {
  test("phase_ready is blocked when hasUI=false", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const ctx = createCtx(NO_BRANCH); // hasUI: false by default

    const result = await onToolCall(
      { type: "tool_call", toolCallId: "tc-1", toolName: "phase_ready", input: {} } as unknown as ExtensionEvent,
      ctx,
    );

    expect(result).toEqual({ block: true, reason: "phase_ready is not available in subagent sessions." });
  });

  test("phase_ready is blocked for an RPC child (hasUI=true, subagent)", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const ctx = { ...createCtx(NO_BRANCH), hasUI: true };

    const result = await onToolCall(
      { type: "tool_call", toolCallId: "tc-1", toolName: "phase_ready", input: {} } as unknown as ExtensionEvent,
      ctx,
    );

    expect(result).toEqual({ block: true, reason: "phase_ready is not available in subagent sessions." });
  });

  test("phase_ready is NOT blocked when hasUI=true", async () => {
    disableSubagentMode();
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const ctx = { ...createCtx(NO_BRANCH), hasUI: true };

    const result = await onToolCall(
      { type: "tool_call", toolCallId: "tc-1", toolName: "phase_ready", input: {} } as unknown as ExtensionEvent,
      ctx,
    );

    // Should NOT return a block result — handler proceeds to normal phase_ready logic
    expect((result as { block?: boolean })?.block).toBeFalsy();
  });

  // task_ready_advance is blocked in subagent sessions (parity with phase_ready).
  test("task_ready_advance is blocked when hasUI=false (subagent)", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const ctx = createCtx(NO_BRANCH);

    const result = await onToolCall(
      { type: "tool_call", toolCallId: "tc-1", toolName: "task_ready_advance", input: {} } as unknown as ExtensionEvent,
      ctx,
    );

    expect(result).toEqual({ block: true, reason: "task_ready_advance is not available in subagent sessions." });
  });

  test("task_ready_advance is blocked for an RPC child (hasUI=true, subagent)", async () => {
    enableSubagentMode();
    const fake = createFakePi();
    setTestSettings(null);
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const ctx = { ...createCtx(NO_BRANCH), hasUI: true };

    const result = await onToolCall(
      { type: "tool_call", toolCallId: "tc-1", toolName: "task_ready_advance", input: {} } as unknown as ExtensionEvent,
      ctx,
    );

    expect(result).toEqual({ block: true, reason: "task_ready_advance is not available in subagent sessions." });
  });

  test("phase_ready in implement during a subagent session → subagent block fires first", async () => {
    enableSubagentMode();
    const slug = "2026-07-03-phase-ready-subagent-implement";
    const fake = createFakePi();
    setTestSettings(null);
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const ctx = { ...createCtx(NO_BRANCH), hasUI: true };

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    // Both conditions hold (subagent AND implement) — the subagent block wins.
    const result = await onToolCall(
      { type: "tool_call", toolCallId: "tc-1", toolName: "phase_ready", input: {} } as unknown as ExtensionEvent,
      ctx,
    );
    expect(result).toEqual({ block: true, reason: "phase_ready is not available in subagent sessions." });
  });
});

describe("phase_ready implement-phase redirect", () => {
  test("phase_ready in implement is blocked and redirects to task_ready_advance", async () => {
    disableSubagentMode();
    const slug = "2026-07-03-phase-ready-implement-redirect";
    const fake = createFakePi();
    setTestSettings(null);
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "in-progress",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "implement",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
    });
    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const ctx = { ...createCtx(NO_BRANCH), hasUI: true };

    await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

    const result = await onToolCall(
      { type: "tool_call", toolCallId: "tc-1", toolName: "phase_ready", input: {} } as unknown as ExtensionEvent,
      ctx,
    );

    // Blocked with a reason naming task_ready_advance.
    expect((result as { block?: boolean })?.block).toBe(true);
    expect((result as { reason?: string })?.reason).toContain("task_ready_advance");
    // The implement→verify machinery must NOT run (phase stays implement, no followUp).
    expect((result as { reason?: string })?.reason).not.toContain("followUp");
    const state = loadFeatureState(slug, null);
    expect(state?.workflow.currentPhase).toBe("implement");
    expect(fake.sentMessages.length).toBe(0);
  });

  // The implement-phase block must not leak to other phases. Each non-implement
  // phase proceeds to normal phase_ready logic (no redirect to task_ready_advance).
  for (const phase of ["design", "plan", "verify"] as const) {
    test(`phase_ready in ${phase} is NOT blocked by the implement redirect`, async () => {
      disableSubagentMode();
      const slug = `2026-07-03-phase-ready-${phase}-no-block`;
      const fake = createFakePi();
      setTestSettings(null);
      writeFeatureStateFile(slug, {
        workflow: {
          phases: {
            design: phase === "design" ? "in-progress" : "pending",
            plan: phase === "plan" ? "in-progress" : "pending",
            implement: "pending",
            verify: phase === "verify" ? "in-progress" : "pending",
            review: "pending",
            finish: "pending",
          },
          currentPhase: phase,
          artifacts: {
            design: `docs/featyard/designs/${slug}-design.md`,
            plan: `.featyard/task-plans/${slug}-task-plan.md`,
            implement: null,
            verify: null,
            review: null,
            finish: null,
          },
        },
      });
      workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
      setTestSettings(null);
      const onToolCall = getSingleHandler(fake.handlers, "tool_call");
      const ctx = { ...createCtx(NO_BRANCH), hasUI: true };

      await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);

      const result = await onToolCall(
        { type: "tool_call", toolCallId: "tc-1", toolName: "phase_ready", input: {} } as unknown as ExtensionEvent,
        ctx,
      );

      // Not the implement-phase block — proceeds to normal phase_ready logic.
      expect((result as { block?: boolean })?.block).not.toBe(true);
      if ((result as { reason?: string })?.reason) {
        expect((result as { reason?: string }).reason).not.toContain("task_ready_advance");
      }
    });
  }
});

describe("session start model override", () => {
  test("default-model applied at session start for main session (hasUI=true)", async () => {
    const slug = "2026-05-12-session-start-model";
    const fake = createFakePi();
    setTestSettings(null);
    const setModelCalls: { provider: string; id: string }[] = [];
    fake.api.setModel = ((model: Model<Api>) => {
      const m = model as { id?: string } | string;
      const mid: string = typeof m === "object" && "id" in m && m.id ? m.id : "unknown";
      const mp = model as { provider?: { id?: string } | string };
      const provider = mp?.provider;
      const pid = typeof provider === "object" && "id" in provider ? provider.id : undefined;
      setModelCalls.push({ provider: pid ?? "unknown", id: mid });
      return Promise.resolve(SET_MODEL_SUCCEEDED);
    }) as unknown as () => Promise<boolean>;
    fake.api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "in-progress",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "plan",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: null,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    // CRITICAL: set env var so session_start enters the feature-state loading path
    process.env.PI_FY_FEATURE = slug;

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setFeatyardConfig({
      "stage-models": {},
      "default-model": "anthropic/claude-sonnet-4-5",
      "kanban-port": null,
    } as unknown as Required<FeatyardConfig>);

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: (p: string, i: string) => ({ provider: { id: p }, id: i }) },
      ui: {
        setWidget: () => {},
        select: async (msg: string, opts: string[]) => {
          if (msg.includes("Continue or reset")) return opts[0]; // "Continue: <slug>"
          return "Continue fresh";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    try {
      await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "new" }, ctx);

      expect(setModelCalls.length).toBeGreaterThanOrEqual(1);
      expect(setModelCalls[0]).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
    } finally {
      delete process.env.PI_FY_FEATURE;
    }
  });

  test("default-model NOT applied at session start for subagent session (hasUI=false)", async () => {
    const slug = "2026-05-12-session-start-no-model";
    enableSubagentMode();
    const fake = createFakePi();
    setTestSettings(null);
    const setModelCalls: { provider: string; id: string }[] = [];
    fake.api.setModel = ((model: Model<Api>) => {
      const m = model as { id?: string } | string;
      const mid: string = typeof m === "object" && "id" in m && m.id ? m.id : "unknown";
      const mp = model as { provider?: { id?: string } | string };
      const provider = mp?.provider;
      const pid = typeof provider === "object" && "id" in provider ? provider.id : undefined;
      setModelCalls.push({ provider: pid ?? "unknown", id: mid });
      return Promise.resolve(SET_MODEL_SUCCEEDED);
    }) as unknown as () => Promise<boolean>;
    fake.api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "in-progress",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "plan",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: null,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    // CRITICAL: set env var so session_start enters the feature-state loading path
    process.env.PI_FY_FEATURE = slug;

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const ctx = {
      hasUI: false, // subagent session — model override should be skipped
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: (p: string, i: string) => ({ provider: { id: p }, id: i }) },
      ui: {
        setWidget: () => {},
        select: async (msg: string, opts: string[]) => {
          if (msg.includes("Continue or reset")) return opts[0]; // "Continue: <slug>"
          return "Continue fresh";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    };

    try {
      await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "new" }, ctx);

      // setModel should NOT have been called for subagent session
      expect(setModelCalls.length).toBe(0);
    } finally {
      delete process.env.PI_FY_FEATURE;
      disableSubagentMode();
    }
  });

  test("default-model NOT applied at session start for an RPC child (hasUI=true, subagent)", async () => {
    // RPC children have ctx.hasUI=true. The bind gate keys on isSubagentSession(), not hasUI,
    // so an RPC subagent must STILL skip the model override — matching the json-child cell above.
    // A revert to ctx.hasUI would re-grant the override to RPC subagents (json↔RPC divergence).
    const slug = "2026-05-12-session-start-rpc-child";
    const fake = createFakePi();
    setTestSettings(null);
    const setModelCalls: { provider: string; id: string }[] = [];
    fake.api.setModel = ((model: Model<Api>) => {
      const m = model as { id?: string } | string;
      const mid: string = typeof m === "object" && "id" in m && m.id ? m.id : "unknown";
      const mp = model as { provider?: { id?: string } | string };
      const provider = mp?.provider;
      const pid = typeof provider === "object" && "id" in provider ? provider.id : undefined;
      setModelCalls.push({ provider: pid ?? "unknown", id: mid });
      return Promise.resolve(SET_MODEL_SUCCEEDED);
    }) as unknown as () => Promise<boolean>;
    fake.api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "in-progress",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "plan",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: null,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    process.env.PI_FY_FEATURE = slug;
    enableSubagentMode(); // RPC child: IS a subagent, but has UI capability

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    setFeatyardConfig({
      "stage-models": {},
      "default-model": "anthropic/claude-sonnet-4-5",
      "kanban-port": null,
    } as unknown as Required<FeatyardConfig>);

    const ctx = {
      hasUI: true, // RPC child has UI capability
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: (p: string, i: string) => ({ provider: { id: p }, id: i }) },
      ui: {
        setWidget: () => {},
        select: async () => "Continue fresh",
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    try {
      await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "new" }, ctx);
      // setModel should NOT be called for an RPC subagent (migrated gate skips it):
      expect(setModelCalls.length).toBe(0);
    } finally {
      delete process.env.PI_FY_FEATURE;
      disableSubagentMode();
    }
  });

  test("stage-models takes priority over default-model at session start", async () => {
    const slug = "2026-05-12-session-start-priority";
    const fake = createFakePi();
    setTestSettings(null);
    const setModelCalls: { provider: string; id: string }[] = [];
    fake.api.setModel = ((model: Model<Api>) => {
      const m = model as { id?: string } | string;
      const mid: string = typeof m === "object" && "id" in m && m.id ? m.id : "unknown";
      const mp = model as { provider?: { id?: string } | string };
      const provider = mp?.provider;
      const pid = typeof provider === "object" && "id" in provider ? provider.id : undefined;
      setModelCalls.push({ provider: pid ?? "unknown", id: mid });
      return Promise.resolve(SET_MODEL_SUCCEEDED);
    }) as unknown as () => Promise<boolean>;
    fake.api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "in-progress",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "plan",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: null,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    // CRITICAL: set env var so session_start enters the feature-state loading path
    process.env.PI_FY_FEATURE = slug;

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    // Both stage-models and default-model configured — stage-models should win
    setFeatyardConfig({
      "stage-models": { plan: "openai/gpt-4o" },
      "default-model": "anthropic/claude-sonnet-4-5",
      "kanban-port": null,
    } as unknown as Required<FeatyardConfig>);

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: (p: string, i: string) => ({ provider: { id: p }, id: i }) },
      ui: {
        setWidget: () => {},
        select: async (msg: string, opts: string[]) => {
          if (msg.includes("Continue or reset")) return opts[0]; // "Continue: <slug>"
          return "Continue fresh";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    try {
      await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "new" }, ctx);

      // stage-models.plan (openai/gpt-4o) should win over default-model (anthropic/claude-sonnet-4-5)
      expect(setModelCalls.length).toBeGreaterThanOrEqual(1);
      expect(setModelCalls[0]).toEqual({ provider: "openai", id: "gpt-4o" });
    } finally {
      delete process.env.PI_FY_FEATURE;
    }
  });

  test("setModel is NOT called when modelRegistry.find returns null", async () => {
    const slug = "2026-05-12-session-start-model-not-found";
    const fake = createFakePi();
    setTestSettings(null);
    const setModelCalls: { provider: string; id: string }[] = [];
    fake.api.setModel = ((model: Model<Api>) => {
      const m = model as { id?: string } | string;
      const mid: string = typeof m === "object" && "id" in m && m.id ? m.id : "unknown";
      const mp = model as { provider?: { id?: string } | string };
      const provider = mp?.provider;
      const pid = typeof provider === "object" && "id" in provider ? provider.id : undefined;
      setModelCalls.push({ provider: pid ?? "unknown", id: mid });
      return Promise.resolve(SET_MODEL_SUCCEEDED);
    }) as unknown as () => Promise<boolean>;
    fake.api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "in-progress",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "plan",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: null,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    process.env.PI_FY_FEATURE = slug;

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: () => null }, // model not found in registry
      ui: {
        setWidget: () => {},
        select: async (msg: string, opts: string[]) => {
          if (msg.includes("Continue or reset")) return opts[0];
          return "Continue fresh";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    };

    try {
      await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "new" }, ctx);

      // setModel should NOT be called when model is not found in registry
      expect(setModelCalls.length).toBe(0);
    } finally {
      delete process.env.PI_FY_FEATURE;
    }
  });

  test("setModel is NOT called at session start when no override is configured", async () => {
    const slug = "2026-05-12-session-start-no-override";
    const fake = createFakePi();
    setTestSettings(null);
    const setModelCalls: { provider: string; id: string }[] = [];
    fake.api.setModel = ((model: Model<Api>) => {
      const m = model as { id?: string } | string;
      const mid: string = typeof m === "object" && "id" in m && m.id ? m.id : "unknown";
      const mp = model as { provider?: { id?: string } | string };
      const provider = mp?.provider;
      const pid = typeof provider === "object" && "id" in provider ? provider.id : undefined;
      setModelCalls.push({ provider: pid ?? "unknown", id: mid });
      return Promise.resolve(SET_MODEL_SUCCEEDED);
    }) as unknown as () => Promise<boolean>;
    fake.api.getModel = () => undefined;

    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "in-progress",
          implement: "pending",
          verify: "pending",
          review: "pending",
          finish: "pending",
        },
        currentPhase: "plan",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: null,
          implement: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      reviewLoopCount: 0,
      reviewHistory: [],
    });

    process.env.PI_FY_FEATURE = slug;

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setTestSettings(null);

    // No model overrides configured at all
    setFeatyardConfig({
      "stage-models": {},
      "default-model": null,
      "kanban-port": null,
    } as unknown as Required<FeatyardConfig>);

    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: (p: string, i: string) => ({ provider: { id: p }, id: i }) },
      ui: {
        setWidget: () => {},
        select: async (msg: string, opts: string[]) => {
          if (msg.includes("Continue or reset")) return opts[0];
          return "Continue fresh";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    try {
      await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "new" }, ctx);

      // setModel should NOT be called when no override is configured
      expect(setModelCalls.length).toBe(0);
    } finally {
      delete process.env.PI_FY_FEATURE;
    }
  });
});

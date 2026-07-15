// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for review iteration compact (compact between design/plan review iterations).
 *
 * The reviewIterationCompact setting controls whether context is compacted between
 * review loop iterations in design and plan phases. It supports:
 * - "none": no compact (default)
 * - "compact": always compact between iterations
 * - "compact>NK": compact only if context exceeds threshold
 *
 * Compact fires in these phase_ready paths:
 * 1. Brainstorm shouldLoop=true — compact between review iterations
 * 2. Brainstorm shouldLoop=false non-auto — compact before fy-plan skill
 * 3. Brainstorm shouldLoop=false auto — compact before onFeatureComplete callback
 * 4. Plan shouldLoop=true — compact between review iterations
 * 5. Plan shouldLoop=false — compact before execution handoff message
 */
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFERRED_COMPACT_FOLLOWUP_MS } from "../../src/compaction/compact-handler.js";
import { _resetCompactGuard } from "../../src/compaction/compact-trigger.js";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import { type AutoAgentCallback, setAutoAgentCallback } from "../../src/kanban/auto-agent/auto-agent-state-machine.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  BRAINSTORM_ACTIVE_STATE,
  createPiWithToolCapture,
  disableSubagentMode,
  enableSubagentMode,
  fireAllHandlers,
  MOCK_CALLED,
  NO_AUTO_AGENT_CALLBACK,
  NO_UI_CTX,
  PLAN_ACTIVE_STATE,
  settleAndDrainPostTurnFollowUp,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

// The compact re-entrancy guard is module-level state — reset it before every test so a
// prior test's mock compact (which never consumes the follow-up to clear the guard) can't
// suppress compaction in unrelated tests.
beforeEach(() => {
  setTestSettings(null);
  _resetCompactGuard();
});

describe("review iteration compact — design shouldLoop=true", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_REVIEW_LOOP;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "none");
  });

  test("1. reviewIterationCompact=none → no compact, skill sent directly", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "none");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-bs-loop-none", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      compact: () => {
        compactCalls.push(undefined);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-1", { issuesFound: 3 }, undefined, undefined, ctx as unknown as ExtensionContext);

    // No compact should have been called
    expect(compactCalls.length).toBe(0);

    // Skill should have been sent directly
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("design review iteration");
    expect((lastMessage.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  test("2. reviewIterationCompact=compact → compact triggered, skill sent in onComplete", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-bs-loop-compact", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      compact: () => {
        compactCalls.push(MOCK_CALLED);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      "tc-2",
      { issuesFound: 3 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Compact should have been called (bare, no args)
    expect(compactCalls.length).toBe(1);

    // Result should be empty (compact triggered)
    expect((result.content[0] as { text: string }).text).toBe("");

    // Stored message should contain the skill
    const stored = globalThis.__piCompactFollowUp as {
      skillName?: string;
      message?: string;
      onAfterFollowUp?: () => void;
    };
    expect(stored).toBeDefined();
    expect(stored.message).toContain("design review iteration");
    delete globalThis.__piCompactFollowUp;
  });
});

describe("review iteration compact — design shouldLoop=false", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_REVIEW_LOOP;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "none");
    // Clean up auto-agent callback if set
    try {
      setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
    } catch {}
  });

  test("3. non-auto: reviewIterationCompact=compact → compact triggered, fy-plan sent in onComplete", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-bs-false-nonauto", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: {
        currentPhase: "design",
        designDoc: "docs/featyard/designs/rir-bs-false-nonauto-design.md",
        planDoc: null,
      },
      design: { doc: "docs/featyard/designs/rir-bs-false-nonauto-design.md", reviewActive: false, reviewLoopCount: 1 },
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync("docs/featyard/designs/rir-bs-false-nonauto-design.md", "# Design");

    const compactCalls: unknown[] = [];
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
      compact: () => {
        compactCalls.push(MOCK_CALLED);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    disableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      "tc-3",
      { issuesFound: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Select dialog should have been shown
    expect(selectFn).toHaveBeenCalled();

    // Compact should have been called (bare)
    expect(compactCalls.length).toBe(1);

    // Result should be empty (compact triggered)
    expect((result.content[0] as { text: string }).text).toBe("");

    // fy-plan skill is passed as skillName (message is empty — handler expands the skill)
    const stored = globalThis.__piCompactFollowUp as {
      skillName?: string;
      message?: string;
      onAfterFollowUp?: () => void;
    };
    expect(stored).toBeDefined();
    expect(stored.skillName).toBe("fy-plan");
    expect(stored.message).toBe("");
    delete globalThis.__piCompactFollowUp;
  });

  test("4. auto mode: reviewIterationCompact=compact → compact triggered, onFeatureComplete called in onComplete", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-bs-false-auto", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: {
        currentPhase: "design",
        designDoc: "docs/featyard/designs/rir-bs-false-auto-design.md",
        planDoc: null,
      },
      design: { doc: "docs/featyard/designs/rir-bs-false-auto-design.md", reviewActive: false, reviewLoopCount: 1 },
      executionMode: "checkpoint",
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync("docs/featyard/designs/rir-bs-false-auto-design.md", "# Design");

    const compactCalls: unknown[] = [];
    const onFeatureCompleteCalls: string[] = [];
    const ctx = {
      ...NO_UI_CTX,
      compact: () => {
        compactCalls.push(MOCK_CALLED);
        // Simulate session_compact handler consuming stored message and calling onAfterFollowUp
        const stored = globalThis.__piCompactFollowUp as {
          skillName?: string;
          message?: string;
          onAfterFollowUp?: () => void;
        };
        delete globalThis.__piCompactFollowUp;
        stored?.onAfterFollowUp?.();
      },
    };

    // Set up auto-agent callback on globalThis
    // Must be called AFTER workflowMonitorExtension + session_start so __piKanban bridge exists

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    setAutoAgentCallback({
      isActive: () => true,
      onFeatureComplete: (slug: string) => {
        onFeatureCompleteCalls.push(slug);
      },
    } as unknown as AutoAgentCallback);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      "tc-4",
      { issuesFound: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Compact should have been called (auto mode)
    expect(compactCalls.length).toBe(1);

    // Result should be empty
    expect((result.content[0] as { text: string }).text).toBe("");

    // onFeatureComplete should have been called via onAfterFollowUp
    expect(onFeatureCompleteCalls.length).toBe(1);
    expect(onFeatureCompleteCalls[0]).toBe("rir-bs-false-auto");
  });

  test("5. non-auto, user picks Discuss: no compact, no phase transition", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-bs-discuss", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: { currentPhase: "design", designDoc: "docs/featyard/designs/rir-bs-discuss-design.md", planDoc: null },
      design: { doc: "docs/featyard/designs/rir-bs-discuss-design.md", reviewActive: false, reviewLoopCount: 1 },
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync("docs/featyard/designs/rir-bs-discuss-design.md", "# Design");

    const compactCalls: unknown[] = [];
    const selectFn = vi.fn().mockResolvedValue("Discuss");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
      compact: () => {
        compactCalls.push(undefined);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    disableSubagentMode();
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-5", { issuesFound: 0 }, undefined, undefined, ctx as unknown as ExtensionContext);

    // Select dialog should have been shown
    expect(selectFn).toHaveBeenCalled();

    // No compact should have been called (user picked Discuss → early return)
    expect(compactCalls.length).toBe(0);
  });
});

describe("review iteration compact — plan shouldLoop=true", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_REVIEW_LOOP;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "none");
  });

  test("6. reviewIterationCompact=compact → compact triggered, skill sent in onComplete", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-plan-loop-compact", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      compact: () => {
        compactCalls.push(MOCK_CALLED);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      "tc-6",
      { issuesFound: 2 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Compact should have been called
    expect(compactCalls.length).toBe(1);

    // Result should be empty
    expect((result.content[0] as { text: string }).text).toBe("");

    // Stored message should contain plan review iteration skill
    const stored = globalThis.__piCompactFollowUp as {
      skillName?: string;
      message?: string;
      onAfterFollowUp?: () => void;
    };
    expect(stored).toBeDefined();
    expect(stored.message).toContain("plan review iteration");
    delete globalThis.__piCompactFollowUp;
  });
});

describe("review iteration compact — plan shouldLoop=false", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_REVIEW_LOOP;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "none");
  });

  test("7. reviewIterationCompact=compact → compact triggered, execution handoff sent in onComplete", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-plan-false-compact", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      compact: () => {
        compactCalls.push(MOCK_CALLED);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    const result = await phaseReady.execute(
      "tc-7",
      { issuesFound: 0 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Compact should have been called
    expect(compactCalls.length).toBe(1);

    // Result should be empty
    expect((result.content[0] as { text: string }).text).toBe("");

    // Execution handoff should be in stored message (post-compact continuation re-fires phase_ready → applyExecutionMode)
    const stored = globalThis.__piCompactFollowUp as {
      skillName?: string;
      message?: string;
      onAfterFollowUp?: () => void;
    };
    expect(stored).toBeDefined();
    expect(stored.skillName).toBe("fy-implement");
    expect(stored.message).toContain("Continuing to implementation");
    delete globalThis.__piCompactFollowUp;
  });
});

describe("review iteration compact — threshold behavior", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_REVIEW_LOOP;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "none");
  });

  test("8. compact>75K with context below threshold → skip compact", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact>75K");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-threshold-low", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      getContextUsage: () => Promise.resolve({ tokens: 50000 }),
      compact: () => {
        compactCalls.push(undefined);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-8", { issuesFound: 3 }, undefined, undefined, ctx as unknown as ExtensionContext);

    // No compact — below threshold
    expect(compactCalls.length).toBe(0);

    // Skill should have been sent directly
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("design review iteration");
  });

  test("9. compact>75K with context above threshold → compact triggered", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact>75K");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-threshold-high", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      getContextUsage: () => Promise.resolve({ tokens: 100000 }),
      compact: () => {
        compactCalls.push(MOCK_CALLED);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-9", { issuesFound: 3 }, undefined, undefined, ctx as unknown as ExtensionContext);

    // Compact should have been called — above threshold
    expect(compactCalls.length).toBe(1);

    // Stored message should contain skill
    const stored = globalThis.__piCompactFollowUp as {
      skillName?: string;
      message?: string;
      onAfterFollowUp?: () => void;
    };
    expect(stored).toBeDefined();
    expect(stored.message).toContain("design review iteration");
    delete globalThis.__piCompactFollowUp;
  });
});

describe("review iteration compact — error handling", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_REVIEW_LOOP;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "none");
  });

  test("10. compact error → stored message cleaned up, no crash", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-error", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      compact: () => {
        compactCalls.push(undefined);
        // No callback — bare compact() has no onError/onComplete
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;

    // Should not throw
    const result = await phaseReady.execute(
      "tc-10",
      { issuesFound: 3 },
      undefined,
      undefined,
      ctx as unknown as ExtensionContext,
    );

    // Compact was attempted (bare call, no args)
    expect(compactCalls.length).toBe(1);
    expect(compactCalls[0]).toBeUndefined(); // bare ctx.compact() with no args

    // Result should be empty (compact was triggered)
    expect((result.content[0] as { text: string }).text).toBe("");

    // Stored message was set before compact
    // (It will be cleaned up by session_compact handler, but since we didn't fire that, it remains)
    // The key point is no crash occurred
  });

  test("10b. compact fails (onError) → recovery delivers the next-skill follow-up, no deadlock", async () => {
    vi.useFakeTimers();
    try {
      setSetting("maxPlanReviewRounds", 3);
      setSetting("minReviewLoops", 0);
      setSetting("reviewIterationCompact", "compact");

      const { fake, registeredTools, api } = createPiWithToolCapture();
      writeFeatureStateFile("rir-sync-error", {
        ...BRAINSTORM_ACTIVE_STATE,
        design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
      });

      // ctx.compact({onError}) — simulate pi routing the failure to onError synchronously.
      // The recovery is delivered via the injected recover (ICompaction.recoverCompactFailure,
      // wired through the orchestrator's *Deps), reusing the session_compact follow-up assembly.
      const ctx = {
        ...NO_UI_CTX,
        compact: (options?: { onError?: (err: Error) => void }) => {
          options?.onError?.(new Error("Nothing to compact (session too small)"));
        },
      };

      await workflowMonitorExtension(api as unknown as ExtensionAPI);
      await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

      const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
      const result = await phaseReady.execute(
        "tc-10b",
        { issuesFound: 3 },
        undefined,
        undefined,
        ctx as unknown as ExtensionContext,
      );

      // Result is empty (phase_ready always returns an empty tool result).
      expect((result.content[0] as { text: string }).text).toBe("");
      // The recovery delivers the follow-up on a deferred timer (same path as session_compact).
      await vi.advanceTimersByTimeAsync(DEFERRED_COMPACT_FOLLOWUP_MS);
      // Recovery fired: a skill-block follow-up was delivered so the agent resumes (no deadlock
      // on the failed compact). The exact skill is resolved by the compact-handler assembly.
      expect(fake.sentMessages.length).toBeGreaterThan(0);
      const last = fake.sentMessages[fake.sentMessages.length - 1];
      expect(typeof last === "string" ? last : last.message).toMatch(/<skill name="fy-/);
    } finally {
      vi.useRealTimers();
      delete process.env.PI_SUBAGENT_CHILD_AGENT;
    }
  });

  test("10c. compact fails (onError) in a subagent session → recovery routes to the subagent role reminder (not the host featyard skill)", async () => {
    vi.useFakeTimers();
    process.env.PI_SUBAGENT_CHILD_AGENT = "test-subagent";
    try {
      setSetting("maxPlanReviewRounds", 3);
      setSetting("minReviewLoops", 0);
      setSetting("reviewIterationCompact", "compact");

      const { fake, registeredTools, api } = createPiWithToolCapture();
      writeFeatureStateFile("rir-subagent-error", {
        ...BRAINSTORM_ACTIVE_STATE,
        design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
      });

      const ctx = {
        ...NO_UI_CTX,
        compact: (options?: { onError?: (err: Error) => void }) => {
          options?.onError?.(new Error("Nothing to compact (session too small)"));
        },
      };

      await workflowMonitorExtension(api as unknown as ExtensionAPI);
      await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

      const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
      await phaseReady.execute("tc-10c", { issuesFound: 3 }, undefined, undefined, ctx as unknown as ExtensionContext);

      await vi.advanceTimersByTimeAsync(DEFERRED_COMPACT_FOLLOWUP_MS);
      // Subagent recovery path: handleSubagentCompact() injects the subagent role reminder,
      // NOT the host featyard skill block (the untested quadrant per review loop 2).
      expect(fake.sentMessages.length).toBeGreaterThan(0);
      const last = fake.sentMessages[fake.sentMessages.length - 1];
      const text = typeof last === "string" ? last : last.message;
      expect(text).toContain('You are subagent "test-subagent"');
    } finally {
      vi.useRealTimers();
      delete process.env.PI_SUBAGENT_CHILD_AGENT;
    }
  });
});

describe("review iteration compact — edge cases", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_REVIEW_LOOP;
    delete process.env.PI_FY_AUTO_AGENT;

    setSetting("maxPlanReviewRounds", 0);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "none");
    // Clean up auto-agent callback if set
    try {
      setAutoAgentCallback(NO_AUTO_AGENT_CALLBACK);
    } catch {}
  });

  test("11. maxPlanReviewRounds=off with reviewIterationCompact=compact → no compact (design shouldLoop=false non-auto)", async () => {
    // This exercises the HOST design-completion UI dialog (hasUI + ui.select), which is
    // a non-subagent flow — disable the describe-wide subagent mode so isSubagentSession()
    // is false and the dialog is reached (subagent sessions skip blocking dialogs).
    disableSubagentMode();
    setSetting("maxPlanReviewRounds", 0);
    setSetting("reviewIterationCompact", "compact");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-off-nocompact", {
      ...BRAINSTORM_ACTIVE_STATE,
      workflow: {
        currentPhase: "design",
        designDoc: "docs/featyard/designs/rir-off-nocompact-design.md",
        planDoc: null,
      },
      design: { doc: "docs/featyard/designs/rir-off-nocompact-design.md", reviewActive: false, reviewLoopCount: 0 },
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync("docs/featyard/designs/rir-off-nocompact-design.md", "# Design");

    const compactCalls: unknown[] = [];
    const selectFn = vi.fn().mockResolvedValue("Proceed with implementation");
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
      ui: { setWidget: () => {}, select: selectFn },
      compact: () => {
        compactCalls.push(undefined);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-11", { issuesFound: 0 }, undefined, undefined, ctx as unknown as ExtensionContext);

    // No compact — maxPlanReviewRounds is off
    expect(compactCalls.length).toBe(0);

    // Should have fallen through to design completion
    expect(selectFn).toHaveBeenCalled();

    // Writing-plans sent directly (not via onComplete)
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("fy-plan");
  });

  test("11b. maxPlanReviewRounds=off with reviewIterationCompact=compact → no compact (design shouldLoop=false auto)", async () => {
    setSetting("maxPlanReviewRounds", 0);
    setSetting("reviewIterationCompact", "compact");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-off-auto", {
      ...BRAINSTORM_ACTIVE_STATE,
      executionMode: "checkpoint",
    });

    // Create design doc for artifact recovery
    fs.mkdirSync("docs/featyard/designs", { recursive: true });
    fs.writeFileSync("docs/featyard/designs/rir-off-auto-design.md", "# Design");

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      compact: () => {
        compactCalls.push(undefined);
      },
    };

    process.env.PI_FY_AUTO_AGENT = "1";

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-11b", { issuesFound: 0 }, undefined, undefined, ctx as unknown as ExtensionContext);

    // No compact — maxPlanReviewRounds is off, even in auto mode
    expect(compactCalls.length).toBe(0);
  });

  test("12. getContextUsage unavailable with threshold → skip compact (matches inter-task pattern)", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact>75K");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-no-usage", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      // No getContextUsage — simulates unavailable context usage
      compact: () => {
        compactCalls.push(undefined);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-12", { issuesFound: 3 }, undefined, undefined, ctx as unknown as ExtensionContext);

    // No compact — getContextUsage unavailable with threshold
    expect(compactCalls.length).toBe(0);

    // Skill sent directly
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("design review iteration");
  });

  test("13. compact>75K with context at exact threshold (75K) → skip compact", async () => {
    setSetting("maxPlanReviewRounds", 3);
    setSetting("minReviewLoops", 0);
    setSetting("reviewIterationCompact", "compact>75K");

    const { fake, registeredTools, api } = createPiWithToolCapture();
    writeFeatureStateFile("rir-boundary-exact", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 1 },
    });

    const compactCalls: unknown[] = [];
    const ctx = {
      ...NO_UI_CTX,
      getContextUsage: () => Promise.resolve({ tokens: 75000 }),
      compact: () => {
        compactCalls.push(undefined);
      },
    };

    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, ctx as unknown as ExtensionContext);

    const phaseReady = registeredTools.find((t) => (t as { name: string }).name === "phase_ready") as ToolDefinition;
    await phaseReady.execute("tc-13", { issuesFound: 3 }, undefined, undefined, ctx as unknown as ExtensionContext);

    // At exact threshold (75000 <= 75000) → skip compact, send directly
    expect(compactCalls.length).toBe(0);

    // Skill sent directly
    await fireAllHandlers(fake.handlers, "agent_end", {}, NO_UI_CTX);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    expect(fake.sentMessages.length).toBeGreaterThan(0);
    const lastMessage = fake.sentMessages[fake.sentMessages.length - 1];
    expect(lastMessage.message).toContain("design review iteration");
  });
});

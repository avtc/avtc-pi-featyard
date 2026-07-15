// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFERRED_COMPACT_FOLLOWUP_MS } from "../../src/compaction/compact-handler.js";
import workflowMonitorExtension, { _getExpectedSkill, _resetFeatureState } from "../../src/index.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  setupPiCtx,
  TUI_MODE,
  withTempCwd,
} from "../helpers/workflow-monitor-test-helpers.js";

describe("session_compact skill injection", () => {
  beforeEach(() => {
    setTestSettings(null);
    delete globalThis.__piCtx;
    vi.useFakeTimers();
    withTempCwd();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
    enableSubagentMode();
  });

  afterEach(() => {
    delete globalThis.__piCtx;
    vi.useRealTimers();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
  });

  test("injects skill message after compaction when execute phase is active", async () => {
    const slug = "test-checkpoint";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        featureSlug: slug,
        executionMode: "checkpoint",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        workflow: {
          currentPhase: "implement",
          designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
          planDoc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
        },
        tdd: { stage: "none", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: { passed: false, waived: false },
        design: { doc: "docs/featyard/designs/2026-05-10-test-design.md", reviewActive: false, reviewLoopCount: 0 },
        plan: {
          doc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
          verifyLoopCount: 0,
          reviewActive: false,
          reviewLoopCount: 0,
        },
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
      }),
    );

    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Trigger session_start to load state
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // Trigger session_compact
    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-implement"/);
    expect(sendUserMessageCalls[0]).toContain("compacted");
  });

  test("does not inject when no workflow state", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );

    expect(sendUserMessageCalls.length).toBe(0);
  });

  test("does not inject when phase is complete (not active)", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // No phases advanced — getExpectedSkill should return null
    expect(_getExpectedSkill()).toBeNull();

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );

    expect(sendUserMessageCalls.length).toBe(0);
  });

  test("injects subagent role reminder when PI_SUBAGENT_CHILD_AGENT is set", async () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "test-subagent";

    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Subagent with no discoverable skills gets a role reminder
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toContain("test-subagent");
    expect(sendUserMessageCalls[0]).toContain("Context was compacted");
  });

  test("stored-message pattern: stored message replaces skill injection", async () => {
    const fake = createFakePi();
    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // Advance to execute phase
    const onInput = getSingleHandler(fake.handlers, "input");
    onInput(
      { type: "input", text: "/skill:fy-implement" } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );

    // Set stored message instead of suppress flag
    globalThis.__piCompactFollowUp = {
      message: "Custom followUp from task-tracker",
    };

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    // Should inject skill + stored message
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-implement"/);
    expect(sendUserMessageCalls[0]).toContain("Custom followUp from task-tracker");

    // Stored message should be deleted
    expect(globalThis.__piCompactFollowUp).toBeUndefined();

    // Next compact without stored message should inject skill normally
    await onCompact(
      {
        compactionEntry: { id: "c2", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);
    expect(sendUserMessageCalls.length).toBe(2);
    expect(sendUserMessageCalls[1]).toMatch(/^<skill name="fy-implement"/);
    expect(sendUserMessageCalls[1]).not.toContain("Custom followUp");
  });

  test("skips injection when agent just finished (human's turn)", async () => {
    const slug = "test-checkpoint";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        featureSlug: slug,
        executionMode: "checkpoint",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        workflow: {
          currentPhase: "implement",
          designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
          planDoc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
        },
        tdd: { stage: "none", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: { passed: false, waived: false },
        design: { doc: "docs/featyard/designs/2026-05-10-test-design.md", reviewActive: false, reviewLoopCount: 0 },
        plan: {
          doc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
          verifyLoopCount: 0,
          reviewActive: false,
          reviewLoopCount: 0,
        },
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
      }),
    );

    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Load state
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // Fire agent_end — simulates LLM finishing its turn
    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd({} as unknown as ExtensionEvent, { hasUI: false } as unknown as ExtensionContext);

    // Now compact — should NOT inject because it's the human's turn
    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );

    expect(sendUserMessageCalls.length).toBe(0);
  });

  test("injects after compaction when agent_start reset the flag (LLM's turn)", async () => {
    const slug = "test-checkpoint";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        featureSlug: slug,
        executionMode: "checkpoint",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        workflow: {
          currentPhase: "implement",
          designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
          planDoc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
        },
        tdd: { stage: "none", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: { passed: false, waived: false },
        design: { doc: "docs/featyard/designs/2026-05-10-test-design.md", reviewActive: false, reviewLoopCount: 0 },
        plan: {
          doc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
          verifyLoopCount: 0,
          reviewActive: false,
          reviewLoopCount: 0,
        },
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
      }),
    );

    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    // Load state
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // Fire agent_end then agent_start — simulates: LLM finished, then new LLM loop started
    const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");
    await onAgentEnd({} as unknown as ExtensionEvent, { hasUI: false } as unknown as ExtensionContext);

    const onAgentStart = getSingleHandler(fake.handlers, "agent_start");
    await onAgentStart({} as unknown as ExtensionEvent, {} as unknown as ExtensionContext);

    // Now compact — should inject because agent_start reset the flag
    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-implement"/);
  });
});

describe("session_compact review skill injection", () => {
  function createReviewPhaseState(slug: string) {
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        featureSlug: slug,
        executionMode: "checkpoint",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        workflow: {
          currentPhase: "review",
          designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
          planDoc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
        },
        tdd: { stage: "none", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: { passed: true, waived: false },
        design: { doc: "docs/featyard/designs/2026-05-10-test-design.md", reviewActive: false, reviewLoopCount: 0 },
        plan: {
          doc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
          verifyLoopCount: 0,
          reviewActive: false,
          reviewLoopCount: 0,
        },
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
      }),
    );
  }

  beforeEach(() => {
    setTestSettings(null);
    delete globalThis.__piCtx;
    vi.useFakeTimers();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
  });

  afterEach(() => {
    delete globalThis.__piCtx;
    vi.useRealTimers();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
  });

  test("injects fy-review when featureReviewMode is comprehensive and maxFeatureReviewRounds is on", async () => {
    const slug = "test-review-compact";
    process.env.PI_FY_FEATURE = slug;

    const sendUserMessageCalls: string[] = [];
    const fake = createFakePi();
    createReviewPhaseState(slug);

    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);
    setSetting("featureReviewMode", "comprehensive");
    setSetting("maxFeatureReviewRounds", 3);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-review"/);
    expect(sendUserMessageCalls[0]).toContain("review");
  });

  test("injects fy-review when featureReviewMode is general and maxFeatureReviewRounds is on", async () => {
    const slug = "test-review-compact";
    process.env.PI_FY_FEATURE = slug;

    const sendUserMessageCalls: string[] = [];
    const fake = createFakePi();
    createReviewPhaseState(slug);

    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);
    setSetting("featureReviewMode", "general");
    setSetting("maxFeatureReviewRounds", 3);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-review"/);
  });

  test("injects no skill when maxFeatureReviewRounds is off (review skipped)", async () => {
    const slug = "test-review-compact";
    process.env.PI_FY_FEATURE = slug;

    const sendUserMessageCalls: string[] = [];
    const fake = createFakePi();
    createReviewPhaseState(slug);

    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);
    setSetting("featureReviewMode", "comprehensive");
    setSetting("maxFeatureReviewRounds", 0);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );

    // maxFeatureReviewRounds=off means review is skipped — no skill injected
    expect(sendUserMessageCalls.length).toBe(0);
  });
});

describe("session_compact iteration skill injection", () => {
  beforeEach(() => {
    setTestSettings(null);
    delete globalThis.__piCtx;
    vi.useFakeTimers();
    withTempCwd();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
  });

  afterEach(() => {
    delete globalThis.__piCtx;
    vi.useRealTimers();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
  });

  test("injects design-review with context during design review", async () => {
    const slug = "test-design-compact-iter";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        featureSlug: slug,
        executionMode: "checkpoint",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        workflow: { currentPhase: "design", designDoc: null, planDoc: null },
        tdd: { stage: "none", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: { passed: false, waived: false },
        design: { doc: null, reviewActive: true, reviewLoopCount: 1 }, // design-review started
        plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
      }),
    );

    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string, _opts: unknown | null) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    expect(sendUserMessageCalls.length).toBe(1);
    const message = sendUserMessageCalls[0];
    expect(message).toMatch(/^<skill name="fy-design-review"/);
    expect(message).toContain(`**Feature:** \`${slug}\``);
    expect(message).toContain("**Review loop:** `0`");
    expect(message).toContain(
      ".featyard/reviews/test-design-compact-iter/test-design-compact-iter-design-known-issues.md",
    );
    expect(message).toContain("compacted");
    expect(message).not.toContain("{{PI_FY_");
  });

  test("injects plan-review with context during plan review", async () => {
    const slug = "test-plan-compact-iter";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        featureSlug: slug,
        executionMode: "checkpoint",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        workflow: {
          currentPhase: "plan",
          designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
          planDoc: null,
        },
        tdd: { stage: "none", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: { passed: false, waived: false },
        design: { doc: "docs/featyard/designs/2026-05-10-test-design.md", reviewActive: false, reviewLoopCount: 0 },
        plan: { doc: null, verifyLoopCount: 0, reviewActive: true, reviewLoopCount: 2 }, // plan-review in progress (1 iteration completed)
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
      }),
    );

    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string, _opts: unknown | null) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    expect(sendUserMessageCalls.length).toBe(1);
    const message = sendUserMessageCalls[0];
    expect(message).toMatch(/^<skill name="fy-plan-review"/);
    expect(message).toContain(`**Feature:** \`${slug}\``);
    expect(message).toContain("**Review loop:** `1`");
    expect(message).toContain(".featyard/reviews/test-plan-compact-iter/test-plan-compact-iter-plan-known-issues.md");
    expect(message).toContain("compacted");
    expect(message).not.toContain("{{PI_FY_");
  });

  test("injects base skill when review loop count is 0 (no review active)", async () => {
    const slug = "test-design-no-review-compact";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        featureSlug: slug,
        executionMode: "checkpoint",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        workflow: { currentPhase: "design", designDoc: null, planDoc: null },
        tdd: { stage: "none", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: { passed: false, waived: false },
        design: { doc: null, reviewActive: false, reviewLoopCount: 0 }, // no review active
        plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
      }),
    );

    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string, _opts: unknown | null) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);

    expect(sendUserMessageCalls.length).toBe(1);
    const message = sendUserMessageCalls[0];
    // Should inject designing (base skill), not design-review
    expect(message).toMatch(/^<skill name="fy-design"/);
    expect(message).toContain("compacted");
  });
});

describe("session_compact routing by reason (regression: manual user-initiated)", () => {
  function writeExecuteState(slug: string): void {
    fs.mkdirSync(path.join(".featyard", "feature-state"), { recursive: true });
    const statePath = path.join(".featyard", "feature-state", `${slug}.json`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        featureSlug: slug,
        executionMode: "checkpoint",
        git: { branch: null, baseCommitSha: null, worktreePath: null, baseBranch: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        workflow: {
          currentPhase: "implement",
          designDoc: "docs/featyard/designs/2026-05-10-test-design.md",
          planDoc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
        },
        tdd: { stage: "none", testFiles: [], sourceFiles: [], redAwaitingConfirmation: false },
        verification: { passed: false, waived: false },
        design: { doc: "docs/featyard/designs/2026-05-10-test-design.md", reviewActive: false, reviewLoopCount: 0 },
        plan: {
          doc: ".featyard/task-plans/2026-05-10-test-task-plan.md",
          verifyLoopCount: 0,
          reviewActive: false,
          reviewLoopCount: 0,
        },
        implement: { tasks: [] },
        verify: { verifyLoopCount: 0 },
        review: { reviewLoopCount: 0, reviewHistory: [] },
        sessionFiles: [],
        featureId: null,
      }),
    );
  }

  beforeEach(() => {
    setTestSettings(null);
    delete globalThis.__piCtx;
    vi.useFakeTimers();
    withTempCwd();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
    enableSubagentMode();
  });

  afterEach(() => {
    delete globalThis.__piCtx;
    vi.useRealTimers();
    _resetFeatureState();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_FY_FEATURE;
  });

  test("user-initiated manual compact (reason=manual, no triggers) routes to editor, NOT sendUserMessage", async () => {
    const slug = "test-manual-compact";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    writeExecuteState(slug);

    const sendUserMessageCalls: string[] = [];
    const editorText: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    // User-initiated manual compact: reason="manual", no storedFollowUp, no completedItemId.
    // agentJustFinished is false here (default), so without the reason guard this would inject.
    const compactCtx = {
      hasUI: true,
      ui: {
        setWidget: () => {},
        setEditorText: (t: string) => editorText.push(t),
        getEditorText: () => "",
        notify: () => {},
      } as unknown as ExtensionUIContext,
    } as unknown as ExtensionContext;
    setupPiCtx(compactCtx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      } as unknown as ExtensionEvent,
      compactCtx,
    );

    // Must NOT auto-inject (would start a blocking turn that hangs the user's steer)
    expect(sendUserMessageCalls.length).toBe(0);
    // Routes the content to the editor instead (user is in control)
    expect(editorText.length).toBe(1);
    expect(editorText[0]).toMatch(/^<skill name="fy-implement"/);
  });

  test("extension-triggered compact (reason=manual + storedFollowUp) still injects via sendUserMessage", async () => {
    const slug = "test-extension-compact";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    writeExecuteState(slug);

    const sendUserMessageCalls: string[] = [];
    const editorText: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    // Extension sets __piCompactFollowUp before calling ctx.compact() (review loop / inter-task compact)
    globalThis.__piCompactFollowUp = {
      skillName: "fy-implement",
      message: 'Context was reset between tasks — next task: "X".',
    };

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      } as unknown as ExtensionEvent,
      {
        hasUI: true,
        ui: {
          setWidget: () => {},
          setEditorText: (t: string) => editorText.push(t),
          getEditorText: () => "",
          notify: () => {},
        } as unknown as ExtensionUIContext,
      } as unknown as ExtensionContext,
    );

    // Extension-triggered compaction still auto-resumes via sendUserMessage
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-implement"/);
    expect(sendUserMessageCalls[0]).toContain('next task: "X"');
    expect(editorText.length).toBe(0);
    expect(globalThis.__piCompactFollowUp).toBeUndefined();
  });

  test("auto compact (reason=threshold) mid-turn injects via sendUserMessage", async () => {
    const slug = "test-auto-compact";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    writeExecuteState(slug);

    const sendUserMessageCalls: string[] = [];
    const editorText: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    // Auto compaction: reason=threshold. agentJustFinished is false (default) → injects.
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
        reason: "threshold",
        willRetry: false,
      } as unknown as ExtensionEvent,
      {
        hasUI: true,
        ui: {
          setWidget: () => {},
          setEditorText: (t: string) => editorText.push(t),
          getEditorText: () => "",
          notify: () => {},
        } as unknown as ExtensionUIContext,
      } as unknown as ExtensionContext,
    );

    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-implement"/);
    expect(editorText.length).toBe(0);
  });

  test("follow-up inject is DEFERRED (not synchronous) so a concurrent user steer is delivered first", async () => {
    // Regression guard for the user-steer-during-compaction hang: the inject must NOT fire inline
    // in the session_compact handler (that would race flushCompactionQueue's steer prompt and hang
    // it). It must fire only after the defer window, by which point a steer prompt would already be
    // streaming and sendUserMessage enqueues as a followUp instead of starting a competing turn.
    const slug = "test-deferred-inject";
    process.env.PI_FY_FEATURE = slug;

    const fake = createFakePi();
    writeExecuteState(slug);

    const sendUserMessageCalls: string[] = [];
    const piApi = {
      ...fake.api,
      sendUserMessage(msg: string) {
        sendUserMessageCalls.push(msg);
      },
    };

    workflowMonitorExtension(piApi as unknown as ExtensionAPI);

    await fireAllHandlers(
      fake.handlers,
      "session_start",
      { source: "user", hasUI: false },
      { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } },
    );

    const onCompact = getSingleHandler(fake.handlers, "session_compact");
    await onCompact(
      {
        compactionEntry: { id: "c1", type: "compaction" } as unknown as unknown,
        fromExtension: false,
        reason: "threshold",
        willRetry: false,
      } as unknown as ExtensionEvent,
      { hasUI: false } as unknown as ExtensionContext,
    );

    // Immediately after the handler resolves: inject MUST NOT have fired yet (deferred).
    expect(sendUserMessageCalls.length).toBe(0);

    // After the defer window: inject fires.
    vi.advanceTimersByTime(DEFERRED_COMPACT_FOLLOWUP_MS);
    expect(sendUserMessageCalls.length).toBe(1);
    expect(sendUserMessageCalls[0]).toMatch(/^<skill name="fy-implement"/);
  });
});

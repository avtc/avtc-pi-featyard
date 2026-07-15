// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { createFeatureState, loadFeatureState, saveFeatureState } from "../../src/state/feature-state.js";
import { mockExecSync, restoreExecSync } from "../helpers/mock-exec-sync.js";
import {
  createFakePi,
  fireAllHandlers,
  getSingleHandler,
  setupPiCtx,
  TUI_MODE,
} from "../helpers/workflow-monitor-test-helpers.js";

const execSyncMock = vi.fn();

describe("execution mode update on skill invocation", () => {
  beforeEach(() => {
    mockExecSync(execSyncMock);
    execSyncMock.mockReturnValue("feature/test-branch");
  });

  afterEach(() => {
    restoreExecSync();
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_EXECUTION_MODE;
    delete globalThis.__piCtx;
    vi.restoreAllMocks();
  });

  async function setupExtension(slug: string, executionMode: string | null): Promise<ReturnType<typeof createFakePi>> {
    const fake = createFakePi();

    // Save feature state to the temp dir that createFakePi set up
    const state = createFeatureState(slug, `docs/featyard/designs/${slug}-design.md`);
    (state as { executionMode?: string }).executionMode = executionMode ?? "subagent";
    saveFeatureState(state, null);
    process.env.PI_FY_FEATURE = slug;

    workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

    // Trigger session_start with hasUI:false to load active feature
    await fireAllHandlers(
      fake.handlers,
      "session_start",
      {},
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        ui: { setWidget: vi.fn() },
      },
    );

    return fake;
  }

  function makeCtx(): unknown {
    const ctx = {
      hasUI: true,
      ui: { setWidget: vi.fn(), select: vi.fn(), setEditorText: vi.fn() },
      sessionManager: { getBranch: () => [] },
    };
    setupPiCtx(ctx.ui as Parameters<typeof setupPiCtx>[0], TUI_MODE);
    return ctx;
  }

  test("input with /skill:fy-implement preserves existing subagent mode", async () => {
    const slug = "2026-05-09-mode-test-1";
    const fake = await setupExtension(slug, null);
    const onInput = getSingleHandler(fake.handlers, "input");

    await onInput(
      { type: "input", text: '/skill:fy-implement "docs/plans/test.md"' } as unknown as ExtensionEvent,
      makeCtx() as unknown as ExtensionContext,
    );

    const updated = loadFeatureState(slug, null);
    // Mode is set by execution mode dialog, not by skill invocation
    expect((updated as unknown as { executionMode: string }).executionMode).toBe("subagent");
  });

  test("input with /skill:fy-implement preserves existing subagent mode", async () => {
    const slug = "2026-05-09-mode-test-2";
    const fake = await setupExtension(slug, null);
    const state = loadFeatureState(slug, null);
    if (!state) throw new Error("Feature state not found");
    (state as { executionMode?: string }).executionMode = "subagent";
    saveFeatureState(state, null);

    const onInput = getSingleHandler(fake.handlers, "input");

    await onInput(
      { type: "input", text: "/skill:fy-implement" } as unknown as ExtensionEvent,
      makeCtx() as unknown as ExtensionContext,
    );

    const updated = loadFeatureState(slug, null);
    expect((updated as unknown as { executionMode: string }).executionMode).toBe("subagent");
  });

  test('input with <skill name="fy-implement"> preserves existing subagent mode', async () => {
    const slug = "2026-05-09-mode-test-3";
    const fake = await setupExtension(slug, null);
    const onInput = getSingleHandler(fake.handlers, "input");

    await onInput(
      { text: '<skill name="fy-implement" location="/path/to/SKILL.md">' } as unknown as ExtensionEvent,
      makeCtx() as unknown as ExtensionContext,
    );

    const updated = loadFeatureState(slug, null);
    // Mode is set by execution mode dialog, not by skill invocation
    expect((updated as unknown as { executionMode: string }).executionMode).toBe("subagent");
  });

  test("input with non-execution skill does not change executionMode", async () => {
    const slug = "2026-05-09-mode-test-4";
    const fake = await setupExtension(slug, null);
    const state = loadFeatureState(slug, null);
    if (!state) throw new Error("Feature state not found");
    (state as { executionMode?: string }).executionMode = "checkpoint";
    saveFeatureState(state, null);

    const onInput = getSingleHandler(fake.handlers, "input");

    await onInput(
      { type: "input", text: "/skill:fy-design" } as unknown as ExtensionEvent,
      makeCtx() as unknown as ExtensionContext,
    );

    const updated = loadFeatureState(slug, null);
    expect((updated as unknown as { executionMode: string }).executionMode).toBe("checkpoint");
  });

  test("input with /skill:fy-implement preserves subagent-fork mode", async () => {
    const slug = "2026-05-09-mode-test-5";
    const fake = await setupExtension(slug, "subagent-fork");

    const onInput = getSingleHandler(fake.handlers, "input");

    await onInput(
      { type: "input", text: "/skill:fy-implement" } as unknown as ExtensionEvent,
      makeCtx() as unknown as ExtensionContext,
    );

    const updated = loadFeatureState(slug, null);
    expect((updated as unknown as { executionMode: string }).executionMode).toBe("subagent-fork");
  });

  test("input with /skill:fy-implement preserves subagent-fork mode (no downgrade)", async () => {
    const slug = "2026-05-09-mode-test-6";
    const fake = await setupExtension(slug, "subagent-fork");

    const onInput = getSingleHandler(fake.handlers, "input");

    await onInput(
      { type: "input", text: '/skill:fy-implement "docs/plans/test.md"' } as unknown as ExtensionEvent,
      makeCtx() as unknown as ExtensionContext,
    );

    const updated = loadFeatureState(slug, null);
    expect((updated as unknown as { executionMode: string }).executionMode).toBe("subagent-fork");
  });
});

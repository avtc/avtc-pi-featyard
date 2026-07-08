// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for resolveModel hook wiring via subscribeToSubagent.
 *
 * Verifies that initSubagentIntegration correctly wires the model resolver
 * through the pi-subagent:ready event, and that the resolver reads from
 * model-overrides config to produce the right model string.
 *
 * The feature-flow resolver is stage-only (resolveStageModelOnly): it returns a
 * stage-model when the workflow stage matches, otherwise yields undefined.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initSubagentIntegration } from "../../src/integrations/subagent-integration.js";
import type { FeatureFlowConfig } from "../../src/settings/model-overrides.js";
import * as modelOverrides from "../../src/settings/model-overrides.js";
import { setHandlerRef } from "../../src/shared/workflow-refs.js";
import type { SubagentModelResolver } from "../../src/snippets/vendored/subscribe-to-subagent.js";
import type { FeatureSession } from "../../src/state/feature-session.js";
import { resetSubagentTestSettings, setSubagentTestSettings } from "../helpers/subagent-test-helpers.js";

/**
 * Create a fake pi with a real event handler map for events,
 * matching the pattern used by todo-integration tests.
 */
function createFakePi() {
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    pi: {
      on(_channel: string, _handler: (...args: unknown[]) => unknown) {
        return () => {};
      },
      events: {
        on(channel: string, handler: (...args: unknown[]) => unknown) {
          const list = eventHandlers.get(channel) ?? [];
          list.push(handler);
          eventHandlers.set(channel, list);
          return () => {
            const handlers = eventHandlers.get(channel);
            if (handlers) {
              const idx = handlers.indexOf(handler);
              if (idx >= 0) handlers.splice(idx, 1);
            }
          };
        },
        off: vi.fn(),
        emit: vi.fn(),
      },
    } as unknown as ExtensionAPI,
    eventHandlers,
    fireReady(api: unknown) {
      const handlers = eventHandlers.get("pi-subagent:ready");
      if (!handlers) throw new Error("No pi-subagent:ready handlers registered");
      for (const h of handlers) h(api);
    },
  };
}

describe("resolveModel wiring", () => {
  beforeEach(() => {
    setSubagentTestSettings(null);
    modelOverrides.resetFeatureFlowConfig();
  });

  afterEach(() => {
    resetSubagentTestSettings();
    modelOverrides.resetFeatureFlowConfig();
    setHandlerRef(null);
    delete process.env.PI_FF_STAGE;
    delete process.env.PI_FF_REVIEW_LOOP;
  });

  /** Install a handler ref so the resolver reads stage + loop count from feature-state
   *  (the durable source of truth) instead of the removed env vars. */
  function installHandlerRef(opts: { phase: string; reviewLoopCount: number }): void {
    const handler = {
      getWorkflowState: () => ({ currentPhase: opts.phase }),
      getActiveFeatureState: () => ({ review: { reviewLoopCount: opts.reviewLoopCount } }),
    } as unknown as FeatureSession;
    setHandlerRef(handler);
  }

  test("wires addModelResolver via subscribeToSubagent", () => {
    const { pi, fireReady } = createFakePi();
    initSubagentIntegration(pi);

    const addModelResolver = vi.fn();
    fireReady({
      addPromptTransformer: vi.fn(),
      addModelResolver,
      addSkillPaths: vi.fn(),
      addAgentsPaths: vi.fn(),
    });

    expect(addModelResolver).toHaveBeenCalledTimes(1);
    expect(typeof addModelResolver.mock.calls[0]?.[0]).toBe("function");
  });

  test("resolver returns undefined for explicit model (caller handles it)", () => {
    modelOverrides.setFeatureFlowConfig({
      "stage-models": {},
      "default-model": "test-provider/model-c",
      "kanban-port": null,
    } as unknown as Required<FeatureFlowConfig>);

    const { pi, fireReady } = createFakePi();
    initSubagentIntegration(pi);

    let capturedResolver: SubagentModelResolver | undefined;
    fireReady({
      addPromptTransformer: vi.fn(),
      addModelResolver: (fn: SubagentModelResolver) => {
        capturedResolver = fn;
      },
      addSkillPaths: vi.fn(),
      addAgentsPaths: vi.fn(),
    });

    // The resolver hook must NOT handle explicitModel itself: pi-subagent's Phase 0
    // short-circuits an explicit --model param before any Phase 2 hook runs, so the
    // hook is only reached with explicitModel === undefined. With no stage active
    // (empty stage-models, no PI_FF_STAGE), the hook yields undefined so
    // pi-subagent's Phase 3 default-model applies. The explicit value is the caller's
    // responsibility, never the hook's.
    const result = (capturedResolver ?? (() => null))({ agentName: "ff-researcher", explicitModel: "openai/gpt-5" });
    expect(result).toBeUndefined();
  });

  test("resolver returns undefined when no config override and no default", () => {
    modelOverrides.setFeatureFlowConfig({
      "stage-models": {},
      "default-model": null,
      "kanban-port": null,
    } as unknown as Required<FeatureFlowConfig>);

    const { pi, fireReady } = createFakePi();
    initSubagentIntegration(pi);

    let capturedResolver: SubagentModelResolver | undefined;
    fireReady({
      addPromptTransformer: vi.fn(),
      addModelResolver: (fn: SubagentModelResolver) => {
        capturedResolver = fn;
      },
      addSkillPaths: vi.fn(),
      addAgentsPaths: vi.fn(),
    });

    const result = (capturedResolver ?? (() => null))({ agentName: "worker", explicitModel: undefined });
    expect(result).toBeUndefined();
  });

  test("resolver uses stage-model when stage matches", () => {
    installHandlerRef({ phase: "review", reviewLoopCount: 0 });

    modelOverrides.setFeatureFlowConfig({
      "stage-models": { review: "test-provider/model-b" },
      "default-model": "test-provider/model-c",
      "kanban-port": null,
    } as unknown as Required<FeatureFlowConfig>);

    const { pi, fireReady } = createFakePi();
    initSubagentIntegration(pi);

    let capturedResolver: SubagentModelResolver | undefined;
    fireReady({
      addPromptTransformer: vi.fn(),
      addModelResolver: (fn: SubagentModelResolver) => {
        capturedResolver = fn;
      },
      addSkillPaths: vi.fn(),
      addAgentsPaths: vi.fn(),
    });

    const result = (capturedResolver ?? (() => null))({ agentName: "worker", explicitModel: undefined });
    expect(result).toBe("test-provider/model-b");
  });

  test("resolver rotates a stage-models ARRAY across successive review-loop values", () => {
    // : stage-models may be an array, rotated by the review-loop count. The
    // hook must thread that count (now read from feature-state) into resolveStageModelOnly
    // so successive loop values yield successive array elements, wrapping at the array
    // length. This is the only test exercising array rotation through the REAL resolver
    // closure (the `resolver uses stage-model` test above covers the single-string case only).
    installHandlerRef({ phase: "review", reviewLoopCount: 0 });

    modelOverrides.setFeatureFlowConfig({
      "stage-models": { review: ["M1/1", "M2/2", "M3/3"] },
      "default-model": null,
      "kanban-port": null,
    } as unknown as Required<FeatureFlowConfig>);

    const { pi, fireReady } = createFakePi();
    initSubagentIntegration(pi);

    let capturedResolver: SubagentModelResolver | undefined;
    fireReady({
      addPromptTransformer: vi.fn(),
      addModelResolver: (fn: SubagentModelResolver) => {
        capturedResolver = fn;
      },
      addSkillPaths: vi.fn(),
      addAgentsPaths: vi.fn(),
    });

    // Successive review-loop values cycle through the array, wrapping after the end.
    // The loop count is read from feature-state (getLoopCountForPhase), so update the
    // installed handler's record per iteration.
    const expected = ["M1/1", "M2/2", "M3/3", "M1/1", "M2/2"];
    for (let loop = 0; loop < expected.length; loop++) {
      installHandlerRef({ phase: "review", reviewLoopCount: loop });
      const result = (capturedResolver ?? (() => null))({ agentName: "worker", explicitModel: undefined });
      expect(result).toBe(expected[loop]);
    }
  });
});

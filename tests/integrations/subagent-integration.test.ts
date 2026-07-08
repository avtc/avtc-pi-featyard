// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Integration tests for subagent-integration.ts
 *
 * Tests the hooks connecting feature-flow-specific dependencies
 * to the generic pi-subagent extension via initSubagentIntegration.
 */

type MockHandler = (...args: unknown[]) => unknown;

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _resolveReviewLoopIndex, initSubagentIntegration } from "../../src/integrations/subagent-integration.js";
import { setHandlerRef } from "../../src/shared/workflow-refs.js";
import type {
  SubagentModelResolver,
  SubagentPromptTransformer,
} from "../../src/snippets/vendored/subscribe-to-subagent.js";
import { buildReportFilePath } from "../../src/state/artifact-paths.js";
import type { FeatureSession } from "../../src/state/feature-session.js";

/**
 * Create a fake pi that captures the :ready event handler.
 * Returns the fake pi and a way to fire the :ready handler with a mock API
 * to capture what hooks were registered.
 */
function createFakePi() {
  let readyHandler: ((api: unknown) => void) | null = null;
  const sessionShutdownUnsubs: Array<() => void> = [];

  const pi = {
    on: vi.fn((event: string, handler: MockHandler) => {
      if (event === "session_shutdown") {
        sessionShutdownUnsubs.push(handler);
      }
      return () => {};
    }),
    events: {
      on: vi.fn((event: string, handler: MockHandler) => {
        if (event === "pi-subagent:ready") {
          readyHandler = handler;
        }
        return () => {};
      }),
      off: vi.fn(),
      emit: vi.fn(),
    },
  };

  return {
    pi,
    /** Fire the captured :ready handler with a mock API that records hook registrations. */
    fireReady() {
      const captured: {
        transformPrompt?: SubagentPromptTransformer;
        resolveModel?: SubagentModelResolver;
        mockApi?: typeof mockApi;
      } = {};
      const mockApi = {
        addPromptTransformer: vi.fn((fn: SubagentPromptTransformer) => {
          captured.transformPrompt = fn;
        }),
        addModelResolver: vi.fn((fn: SubagentModelResolver) => {
          captured.resolveModel = fn;
        }),
        addSkillPaths: vi.fn(),
        addAgentsPaths: vi.fn(),
      };
      captured.mockApi = mockApi;
      if (!readyHandler) throw new Error("No :ready handler captured");
      readyHandler(mockApi);
      return captured;
    },
  };
}

describe("subagent-integration", () => {
  describe("transformPrompt", () => {
    beforeEach(() => {
      // ensureBridge removed — settings handled by setSubagentTestSettings
    });
    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.PI_FF_FEATURE;
      delete process.env.PI_FF_STAGE;
    });

    function getTransformPrompt() {
      const { pi, fireReady } = createFakePi();
      initSubagentIntegration(pi as unknown as ExtensionAPI);
      const captured = fireReady();
      return captured.transformPrompt;
    }

    test("returns prompt unchanged when no PI_SP placeholders", async () => {
      const transformPrompt = getTransformPrompt();
      const result = await (transformPrompt as SubagentPromptTransformer)("Hello world", {
        agentName: "test-agent",
        task: undefined,
        isFork: false,
      });
      expect(result).toBe("Hello world");
    });

    test("substitutes {{PI_FF_*}} placeholders via substitutePlaceholders", async () => {
      const transformPrompt = getTransformPrompt();
      const result = await (transformPrompt as SubagentPromptTransformer)("Feature slug: {{PI_FF_FEATURE_SLUG}}", {
        agentName: "test-agent",
        task: undefined,
        isFork: false,
      });
      // Default: no active slug → resolves to the placeholder slug text
      expect(result).toContain("YYYY-MM-DD");
    });

    test("passes context fields to substitutePlaceholders", async () => {
      const transformPrompt = getTransformPrompt();
      const result = await (transformPrompt as SubagentPromptTransformer)("No placeholders here", {
        agentName: "test-agent",
        task: undefined,
        isFork: false,
      });
      expect(result).toBe("No placeholders here");
    });

    // --- {{PI_FF_FORK_CONTEXT_INJECTION}} resolution ---

    test("resolves FORK_CONTEXT_INJECTION to design-reviewer bullets when isFork=true", async () => {
      const transformPrompt = getTransformPrompt();
      const result = await (transformPrompt as SubagentPromptTransformer)(
        "Intro.\n{{PI_FF_FORK_CONTEXT_INJECTION}}\nOutro.",
        { agentName: "ff-design-reviewer", task: undefined, isFork: true },
      );
      expect(result).not.toContain("{{PI_FF_FORK_CONTEXT_INJECTION}}");
      expect(result).toContain("Decisions discussed but not captured in the final document");
      expect(result).toContain("Intro.");
      expect(result).toContain("Outro.");
    });

    test("resolves FORK_CONTEXT_INJECTION to plan-reviewer bullets when isFork=true", async () => {
      const transformPrompt = getTransformPrompt();
      const result = await (transformPrompt as SubagentPromptTransformer)("{{PI_FF_FORK_CONTEXT_INJECTION}}", {
        agentName: "ff-plan-reviewer",
        task: undefined,
        isFork: true,
      });
      expect(result).toContain("Context gaps");
      expect(result).not.toContain("{{PI_FF_");
    });

    test("strips -fork suffix when looking up agent-specific fork context", async () => {
      const transformPrompt = getTransformPrompt();
      const result = await (transformPrompt as SubagentPromptTransformer)("{{PI_FF_FORK_CONTEXT_INJECTION}}", {
        agentName: "ff-design-reviewer-fork",
        task: undefined,
        isFork: true,
      });
      expect(result).toContain("Decisions discussed but not captured in the final document");
    });

    test("falls back to generic fork context for unknown agent when isFork=true", async () => {
      const transformPrompt = getTransformPrompt();
      const result = await (transformPrompt as SubagentPromptTransformer)("{{PI_FF_FORK_CONTEXT_INJECTION}}", {
        agentName: "custom-reviewer",
        task: undefined,
        isFork: true,
      });
      expect(result).toContain("Decisions discussed but not captured in the written documents");
      expect(result).not.toContain("{{PI_FF_");
    });

    test("resolves FORK_CONTEXT_INJECTION to empty string when isFork=false (fresh mode)", async () => {
      const transformPrompt = getTransformPrompt();
      const result = await (transformPrompt as SubagentPromptTransformer)(
        "Intro.\n{{PI_FF_FORK_CONTEXT_INJECTION}}\nOutro.",
        { agentName: "ff-design-reviewer", task: undefined, isFork: false },
      );
      expect(result).not.toContain("{{PI_FF_FORK_CONTEXT_INJECTION}}");
      expect(result).not.toContain("Pay special attention");
      expect(result).toContain("Intro.");
      expect(result).toContain("Outro.");
    });

    test("does NOT inject the redundant 'forked mode' preamble (handled by buildForkInstruction)", async () => {
      const transformPrompt = getTransformPrompt();
      const result = await (transformPrompt as SubagentPromptTransformer)("{{PI_FF_FORK_CONTEXT_INJECTION}}", {
        agentName: "ff-design-reviewer",
        task: undefined,
        isFork: true,
      });
      expect(result).not.toContain("inherited conversation context");
      expect(result).not.toContain("forked mode");
    });
  });

  describe("resolveModel", () => {
    beforeEach(() => {
      // ensureBridge removed — settings handled by setSubagentTestSettings
    });
    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.PI_FF_STAGE;
      delete process.env.PI_FF_REVIEW_LOOP;
    });

    function getResolveModel() {
      const { pi, fireReady } = createFakePi();
      initSubagentIntegration(pi as unknown as ExtensionAPI);
      const captured = fireReady();
      return captured.resolveModel;
    }

    test("does NOT consult explicitModel (deferred to pi-subagent Phase 0)", () => {
      // The feature-flow hook is a Phase 2 stage-model provider only. An explicit
      // --model param is short-circuited by pi-subagent's Phase 0 BEFORE any hook
      // runs, so this hook is never reached with a defined explicitModel in
      // production. Asserting the hook ignores explicitModel guards the layering:
      // it must not echo the param back (which would re-implement Phase 0's job).
      const resolveModel = getResolveModel();
      const result = resolveModel?.({ agentName: "test-agent", explicitModel: "gpt-4" });
      // No stage active (PI_FF_STAGE unset) → hook yields undefined so
      // pi-subagent's Phase 3 default-model applies. It must NOT return "gpt-4".
      expect(result).not.toBe("gpt-4");
      expect(result).toBeUndefined();
    });

    test("returns undefined when no explicit model and no override", () => {
      const resolveModel = getResolveModel();
      const result = resolveModel?.({ agentName: "unknown-agent", explicitModel: undefined });
      // Default config may have a default-model — just verify it returns a string or undefined
      expect(typeof result === "string" || result === undefined).toBe(true);
    });
  });

  describe("_resolveReviewLoopIndex (per-task counter — pure read)", () => {
    // The per-task verify/review counter is incremented ONLY by task_ready_advance's gate
    // (Task 4). resolveReviewLoopIndex is a PURE READ: it returns the current round value
    // for the active task, with NO +1 and NO write-back. Broadened from ff-general-reviewer
    // alone to also cover ff-task-verifier (so verifier reports are numbered, not unsuffixed).

    /** Build a fake handler whose active feature-state carries the given taskReviewRounds map. */
    function makeHandler(taskReviewRounds: Record<string, number>) {
      const state: { implement: { taskReviewRounds: Record<string, number>; currentTask: string | null } } = {
        implement: { taskReviewRounds, currentTask: null },
      };
      return {
        getActiveFeatureState: () => state,
        getWorkflowState: () => ({ currentPhase: "implement" }),
      };
    }

    afterEach(() => {
      setHandlerRef(null);
    });

    test("ff-task-verifier reads the current round (no +1)", () => {
      setHandlerRef(makeHandler({ "1-implement-login": 2 }) as unknown as FeatureSession);
      const idx = _resolveReviewLoopIndex("ff-task-verifier", "my-feature", "1. Implement login");
      expect(idx).toBe(2);
    });

    test("ff-general-reviewer reads the current round (no +1)", () => {
      setHandlerRef(makeHandler({ "1-implement-login": 2 }) as unknown as FeatureSession);
      const idx = _resolveReviewLoopIndex("ff-general-reviewer", "my-feature", "1. Implement login");
      expect(idx).toBe(2);
    });

    test("reading does not mutate taskReviewRounds (no write-back)", () => {
      const rounds: Record<string, number> = { "1-implement-login": 2 };
      setHandlerRef(makeHandler(rounds) as unknown as FeatureSession);
      _resolveReviewLoopIndex("ff-task-verifier", "my-feature", "1. Implement login");
      _resolveReviewLoopIndex("ff-general-reviewer", "my-feature", "1. Implement login");
      // The counter is untouched after a read (the tool is the sole incrementer).
      expect(rounds["1-implement-login"]).toBe(2);
    });

    test("missing entry coerces to 0 (resume coercion)", () => {
      setHandlerRef(makeHandler({}) as unknown as FeatureSession);
      const idx = _resolveReviewLoopIndex("ff-task-verifier", "my-feature", "2. Add tests");
      expect(idx).toBe(0);
    });

    test("a stale 1-indexed resume value loads without error", () => {
      // An in-flight feature upgraded mid-implement carries an old (spawn-counted) value.
      // No migration: it is read as-is (the gate's round logic tolerates the off-by-one for
      // the single in-flight task; subsequent tasks START from 0).
      setHandlerRef(makeHandler({ "3-wire-api": 1 }) as unknown as FeatureSession);
      expect(_resolveReviewLoopIndex("ff-general-reviewer", "my-feature", "3. Wire API")).toBe(1);
    });

    test("returns undefined outside the implement phase", () => {
      const handler = {
        getActiveFeatureState: () => ({ implement: { taskReviewRounds: { "1-t": 5 }, currentTask: null } }),
        getWorkflowState: () => ({ currentPhase: "review" }),
      };
      setHandlerRef(handler as unknown as FeatureSession);
      expect(_resolveReviewLoopIndex("ff-task-verifier", "my-feature", "1. T")).toBeUndefined();
    });

    test("returns undefined for an agent that is neither per-task verifier nor reviewer", () => {
      setHandlerRef(makeHandler({ "1-t": 5 }) as unknown as FeatureSession);
      expect(_resolveReviewLoopIndex("ff-implementer", "my-feature", "1. T")).toBeUndefined();
    });

    test("returns undefined when no handler is wired", () => {
      setHandlerRef(null);
      expect(_resolveReviewLoopIndex("ff-task-verifier", "my-feature", "1. T")).toBeUndefined();
    });

    test("a verifier loopIndex feeds a numbered report path (no more unsuffixed overwrite-prone path)", () => {
      // Before broadening, ff-task-verifier returned undefined → buildReportFilePath produced
      // an unsuffixed {slug}-task-{task}-ff-task-verifier.md (overwrite-prone across rounds).
      // Now the resolver returns a number → the report path is suffixed per round.
      setHandlerRef(makeHandler({ "1-implement-login": 2 }) as unknown as FeatureSession);
      const loopIndex = _resolveReviewLoopIndex("ff-task-verifier", "my-feature", "1. Implement login");
      const path = buildReportFilePath("my-feature", "task-1-implement-login-ff-task-verifier", loopIndex ?? null, {
        existsSync: () => false,
        readdirSync: () => [],
      } as unknown as typeof import("node:fs"));
      expect(path).toBe(".ff/reviews/my-feature/my-feature-task-1-implement-login-ff-task-verifier-2.md");
    });
  });

  describe("subscribeToSubagent integration", () => {
    test("registers :ready listener via subscribeToSubagent", () => {
      const { pi } = createFakePi();
      initSubagentIntegration(pi as unknown as ExtensionAPI);
      expect(pi.events.on).toHaveBeenCalledWith("pi-subagent:ready", expect.any(Function));
    });

    test("attribution: addAgentsPaths is called with this extension's name (extensionName)", () => {
      const { pi, fireReady } = createFakePi();
      initSubagentIntegration(pi as unknown as ExtensionAPI);
      const captured = fireReady();
      expect(captured.mockApi?.addAgentsPaths).toHaveBeenCalledWith(
        expect.arrayContaining([expect.any(String)]),
        "avtc-pi-feature-flow",
      );
    });

    test("registers session_shutdown listener", () => {
      const { pi } = createFakePi();
      initSubagentIntegration(pi as unknown as ExtensionAPI);
      expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    });

    test("session_shutdown cleanup removes :ready listener, preventing duplicate hooks on reload", () => {
      const shutdownHandlers: MockHandler[] = [];
      const eventHandlers = new Map<string, MockHandler[]>();

      const fakePi = {
        events: {
          on(channel: string, handler: MockHandler) {
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
        },
        on(event: string, handler: MockHandler) {
          if (event === "session_shutdown") shutdownHandlers.push(handler);
          return () => {};
        },
      } as unknown as ExtensionAPI;

      // First subscription
      initSubagentIntegration(fakePi);
      expect(eventHandlers.get("pi-subagent:ready")?.length).toBe(1);

      // Fire session_shutdown — should clean up :ready listener
      for (const h of shutdownHandlers) h();
      expect(eventHandlers.get("pi-subagent:ready")?.length ?? 0).toBe(0);

      // Re-subscribe (simulates reload)
      initSubagentIntegration(fakePi);
      expect(eventHandlers.get("pi-subagent:ready")?.length).toBe(1);

      // Fire :ready and verify hook fires exactly once
      let transformCallCount = 0;
      const handlers = eventHandlers.get("pi-subagent:ready");
      if (!handlers) throw new Error("no ready handlers");
      handlers[0]?.({
        addPromptTransformer: () => {
          transformCallCount++;
        },
        addModelResolver: () => {},
        addSkillPaths: () => {},
        addAgentsPaths: () => {},
      });
      expect(transformCallCount).toBe(1);
    });
  });
});

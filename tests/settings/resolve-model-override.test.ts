// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, test } from "vitest";
import {
  type FeatureFlowConfig,
  type ModelOverride,
  resetFeatureFlowConfig,
  resolveModelOverride,
  resolveStageModelOnly,
} from "../../src/settings/settings-ui.js";

/** Build a minimal FeatureFlowConfig (stage-models + default-model) for tests.
 *  Mirrors pi-subagent's makeSubagentConfig so the two halves of the split feature
 *  share a consistent test-config shape. */
const NO_STAGE_MODELS: Record<string, ModelOverride> | null = null;
const NO_DEFAULT_MODEL: string | null = null;

const cfg = (stageModels: Record<string, ModelOverride> | null, defaultModel: string | null): FeatureFlowConfig => ({
  "stage-models": stageModels ?? {},
  "default-model": defaultModel,
});

describe("resolveModelOverride", () => {
  beforeEach(() => {
    // Clear any cached config from other test files
    resetFeatureFlowConfig();
  });

  test("returns null when no overrides configured", async () => {
    const result = resolveModelOverride("review", 0, cfg(NO_STAGE_MODELS, NO_DEFAULT_MODEL));
    expect(result).toBeNull();
  });

  test("resolves single stage-model", async () => {
    const result = resolveModelOverride("review", 0, cfg({ review: "test-provider/model-b" }, NO_DEFAULT_MODEL));
    expect(result).toEqual("test-provider/model-b");
  });

  test("round-robin rotates through array based on loopIndex", async () => {
    const config = cfg(
      {
        review: ["test-provider/model-a", "test-provider/model-b", "test-provider/model-c"],
      },
      NO_DEFAULT_MODEL,
    );

    expect(resolveModelOverride("review", 0, config)).toEqual("test-provider/model-a");
    expect(resolveModelOverride("review", 1, config)).toEqual("test-provider/model-b");
    expect(resolveModelOverride("review", 2, config)).toEqual("test-provider/model-c");
    expect(resolveModelOverride("review", 3, config)).toEqual("test-provider/model-a"); // wraps
  });

  test("single-iteration stage always uses first model from array", async () => {
    const result = resolveModelOverride(
      "design",
      0,
      cfg({ design: ["test-provider/model-b", "test-provider/model-c"] }, NO_DEFAULT_MODEL),
    );
    expect(result).toEqual("test-provider/model-b");
  });

  test("returns null when stage has no override", async () => {
    const result = resolveModelOverride("implement", 0, cfg({ review: "test-provider/model-b" }, NO_DEFAULT_MODEL));
    expect(result).toBeNull();
  });

  test("returns null for empty config with undefined optional fields", async () => {
    // Deliberately passes `{}` (fields ABSENT, not null) to verify the
    // undefined-field path — do NOT convert to cfg() (which sets default-model=null).
    const result = resolveModelOverride("review", 0, {} as unknown as FeatureFlowConfig);
    expect(result).toBeNull();
  });

  test("returns null for empty array override instead of throwing", async () => {
    // Empty array should gracefully return null, not throw
    const result = resolveModelOverride("review", 0, cfg({ review: [] as string[] }, NO_DEFAULT_MODEL));
    expect(result).toBeNull();
  });

  test("handles multi-slash model strings (e.g. openrouter/anthropic/claude-sonnet-4-5)", async () => {
    const config = cfg(
      {
        review: "openrouter/anthropic/claude-sonnet-4-5",
      },
      NO_DEFAULT_MODEL,
    );
    // The full string is returned as-is — parsing happens at consumption time
    expect(resolveModelOverride("review", 0, config)).toEqual("openrouter/anthropic/claude-sonnet-4-5");
  });

  test("negative loopIndex wraps correctly instead of returning undefined", async () => {
    const config = cfg(
      {
        review: ["test-provider/model-a", "test-provider/model-b", "test-provider/model-c"],
      },
      NO_DEFAULT_MODEL,
    );
    // -1 % 3 === -1 in raw JS, but fix wraps: ((-1 % 3) + 3) % 3 === 2
    expect(resolveModelOverride("review", -1, config)).toEqual("test-provider/model-c");
    // -2 → ((-2 % 3) + 3) % 3 === 1
    expect(resolveModelOverride("review", -2, config)).toEqual("test-provider/model-b");
  });

  test("single-element array always returns the same element regardless of loopIndex", async () => {
    const config = cfg(
      {
        review: ["test-provider/model-b"],
      },
      NO_DEFAULT_MODEL,
    );
    expect(resolveModelOverride("review", 0, config)).toEqual("test-provider/model-b");
    expect(resolveModelOverride("review", 1, config)).toEqual("test-provider/model-b");
    expect(resolveModelOverride("review", 5, config)).toEqual("test-provider/model-b");
    expect(resolveModelOverride("review", 100, config)).toEqual("test-provider/model-b");
  });
});

describe("resolveModelOverride default-model fallback", () => {
  test("returns default-model when no stage override", () => {
    const result = resolveModelOverride("review", 0, cfg({}, "anthropic/claude-sonnet-4-5"));
    expect(result).toEqual("anthropic/claude-sonnet-4-5");
  });

  test("stage-models wins over default-model", () => {
    const result = resolveModelOverride("review", 0, cfg({ review: "openai/gpt-4o" }, "anthropic/claude-sonnet-4-5"));
    expect(result).toEqual("openai/gpt-4o");
  });

  test("empty-array stage-model blocks default-model fallthrough (NOT d/1)", () => {
    // Load-bearing semantic: an empty-array stage entry is TRUTHY, so the
    // `if (entry) return resolveOverride(entry, loopIndex)` branch fires and
    // returns null (resolveOverride([]) → null) — it must NOT fall through to
    // default-model. This is distinct from "no entry for the stage" (which DOES
    // fall through). Guards decision #9's sibling rule for the workflow caller.
    const result = resolveModelOverride("review", 0, cfg({ review: [] as string[] }, "d/1"));
    expect(result).toBeNull();
  });

  test("returns null when default-model is null", () => {
    const result = resolveModelOverride("review", 0, cfg(NO_STAGE_MODELS, NO_DEFAULT_MODEL));
    expect(result).toBeNull();
  });

  test("default-model applies even without a stage (non-workflow context)", () => {
    const result = resolveModelOverride(null, 0, cfg({}, "anthropic/claude-sonnet-4-5"));
    expect(result).toEqual("anthropic/claude-sonnet-4-5");
  });

  test("default-model kicks in when stage-models has no match for current stage", () => {
    const result = resolveModelOverride(
      "implement",
      0,
      cfg({ review: "openai/gpt-4o" }, "anthropic/claude-sonnet-4-5"),
    );
    expect(result).toEqual("anthropic/claude-sonnet-4-5");
  });
});

/**
 * resolveStageModelOnly is the function feature-flow registers as the pi-subagent
 * model-resolution hook (Phase 2). It is STAGE-ONLY — it returns a stage-model when
 * a stage is active, and yields `null` (→ undefined at the hook boundary) when no
 * stage is active, so feature-flow's `default-model` does NOT reach subagents and
 * pi-subagent's own Phase 3 `default-model` applies. This is distinct from
 * resolveModelOverride (above), which DOES fall back to default-model for the
 * workflow orchestrator.
 */
describe("resolveStageModelOnly (subagent hook — decision #9)", () => {
  beforeEach(() => resetFeatureFlowConfig());

  test("returns the stage-model when the active stage matches", () => {
    const result = resolveStageModelOnly(
      "review",
      0,
      cfg({ review: "test-provider/model-b" }, "anthropic/claude-sonnet-4-5"),
    );
    expect(result).toEqual("test-provider/model-b");
  });

  test("decision #9: returns null (NOT default-model) when no stage is active", () => {
    // No stage active → the hook must yield so pi-subagent's Phase 3 applies.
    // It must NOT return the feature-flow default-model (which is orchestrator-only).
    const result = resolveStageModelOnly(
      null,
      0,
      cfg({ review: "test-provider/model-b" }, "anthropic/claude-sonnet-4-5"),
    );
    expect(result).toBeNull();
  });

  test("returns null when the active stage has no stage-model entry", () => {
    const result = resolveStageModelOnly(
      "implement",
      0,
      cfg({ review: "test-provider/model-b" }, "anthropic/claude-sonnet-4-5"),
    );
    expect(result).toBeNull();
  });

  test("rotates an array stage-model by loopIndex", () => {
    const config = cfg({ review: ["a/1", "b/2", "c/3"] }, NO_DEFAULT_MODEL);
    expect(resolveStageModelOnly("review", 0, config)).toEqual("a/1");
    expect(resolveStageModelOnly("review", 1, config)).toEqual("b/2");
    expect(resolveStageModelOnly("review", 2, config)).toEqual("c/3");
    expect(resolveStageModelOnly("review", 3, config)).toEqual("a/1"); // wraps
  });

  test("empty-array stage-model returns null instead of throwing", () => {
    // Empty array is a graceful no-op (resolveOverride([]) → null), not an error.
    const config = cfg({ review: [] as string[] }, NO_DEFAULT_MODEL);
    expect(resolveStageModelOnly("review", 0, config)).toBeNull();
  });

  test("negative loopIndex wraps correctly", () => {
    // Mirrors resolveModelOverride's negative-index behavior (shared resolveOverride).
    const config = cfg({ review: ["a/1", "b/2", "c/3"] }, NO_DEFAULT_MODEL);
    expect(resolveStageModelOnly("review", -1, config)).toEqual("c/3"); // ((-1%3)+3)%3 = 2
    expect(resolveStageModelOnly("review", -2, config)).toEqual("b/2"); // ((-2%3)+3)%3 = 1
  });

  test("single-element array always returns that element regardless of loopIndex", () => {
    const config = cfg({ review: ["solo/1"] }, NO_DEFAULT_MODEL);
    expect(resolveStageModelOnly("review", 0, config)).toEqual("solo/1");
    expect(resolveStageModelOnly("review", 5, config)).toEqual("solo/1");
    expect(resolveStageModelOnly("review", -3, config)).toEqual("solo/1");
  });
});

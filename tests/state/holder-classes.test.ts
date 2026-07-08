// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { createSessionGuardrails } from "../../src/guardrails/session-guardrails.js";
import { createFeatureRecordStore } from "../../src/state/feature-record-store.js";
import type { FeatureState } from "../../src/state/feature-state.js";

// Minimal FeatureState for testing (only the identity fields matter to the holder).
function feature(slug: string): FeatureState {
  return {
    featureSlug: slug,
    featureId: 1,
    currentPhase: "design",
    git: null,
    design: { doc: null },
    plan: { doc: null },
    implement: { taskReviewRounds: {} },
    review: {},
    verify: { testsPassed: false },
    uat: {},
    finish: {},
    createdAt: new Date().toISOString(),
  } as unknown as FeatureState;
}

describe("FeatureRecordStore", () => {
  test("starts empty (get returns null)", () => {
    const store = createFeatureRecordStore();
    expect(store.get()).toBeNull();
  });

  test("set stores the record; get returns it", () => {
    const store = createFeatureRecordStore();
    const rec = feature("feat-1");
    store.set(rec);
    expect(store.get()).toBe(rec);
  });

  test("set with null clears the record", () => {
    const store = createFeatureRecordStore();
    store.set(feature("feat-1"));
    store.set(null);
    expect(store.get()).toBeNull();
  });

  test("clear() empties the store", () => {
    const store = createFeatureRecordStore();
    store.set(feature("feat-1"));
    store.clear();
    expect(store.get()).toBeNull();
  });

  test("set returns the same reference (single source of truth)", () => {
    const store = createFeatureRecordStore();
    const rec = feature("feat-1");
    store.set(rec);
    expect(store.get()).toBe(rec);
    // mutate the stored object — get() should reflect it (live ref, not a clone)
    rec.featureSlug = "feat-1-renamed";
    expect(store.get()?.featureSlug).toBe("feat-1-renamed");
  });
});

describe("SessionGuardrails", () => {
  test("starts with verification not-run", () => {
    const g = createSessionGuardrails();
    expect(g.getVerification()).toBe("not-run");
  });

  test("markPassed sets verification to passed", () => {
    const g = createSessionGuardrails();
    g.markPassed();
    expect(g.getVerification()).toBe("passed");
  });

  test("markFailed (or markPassed(false)) resets to not-run, not a failed state", () => {
    const g = createSessionGuardrails();
    g.markPassed();
    g.markPassed(false);
    expect(g.getVerification()).toBe("not-run");
  });

  test("resetOnSourceWrite resets verification to not-run", () => {
    const g = createSessionGuardrails();
    g.markPassed();
    g.resetOnSourceWrite();
    expect(g.getVerification()).toBe("not-run");
  });

  test("waive sets verification to waived (only when not already passed)", () => {
    const g = createSessionGuardrails();
    g.waive();
    expect(g.getVerification()).toBe("waived");
  });

  test("waive does NOT override an already-passed gate", () => {
    const g = createSessionGuardrails();
    g.markPassed();
    g.waive();
    expect(g.getVerification()).toBe("passed");
  });

  test("reset() returns to the neutral not-run state", () => {
    const g = createSessionGuardrails();
    g.markPassed();
    g.reset();
    expect(g.getVerification()).toBe("not-run");
  });

  test("getSnapshot returns a GuardrailsState view", () => {
    const g = createSessionGuardrails();
    g.markPassed();
    expect(g.getSnapshot()).toEqual({ verification: "passed" });
  });

  test("setSnapshot restores from a GuardrailsState", () => {
    const g = createSessionGuardrails();
    g.setSnapshot({ verification: "waived" });
    expect(g.getVerification()).toBe("waived");
  });
});

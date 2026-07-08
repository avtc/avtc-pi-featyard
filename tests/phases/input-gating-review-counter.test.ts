// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState, getActiveFeatureSlug } from "../../src/index.js";
import { clearFeatureStateCache, loadFeatureState } from "../../src/state/feature-state.js";
import {
  BRAINSTORM_ACTIVE_STATE,
  createPiWithToolCapture,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  NO_UI_CTX,
  PLAN_ACTIVE_STATE,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Integration tests for manual review-skill invocation (/skill:ff-design-review,
 * /skill:ff-plan-review) incrementing the review loop counter via input-gating.
 *
 * The phase_ready path and this manual path share the startReviewIteration
 * helper; injected followUp messages (event.source === "extension") are skipped
 * by input-gating, so the two paths never double-count.
 */
describe("input-gating: manual review skill invocation increments counter", () => {
  beforeEach(() => {
    enableSubagentMode();
  });

  afterEach(async () => {
    _resetFeatureState();
    delete process.env.PI_FF_FEATURE;
    delete process.env.PI_FF_REVIEW_LOOP;
    delete process.env.PI_FF_STAGE;
    clearFeatureStateCache();
  });

  test("skill:ff-design-review increments designReviewLoopCount", async () => {
    const { fake, api } = createPiWithToolCapture();
    const slug = writeFeatureStateFile("2026-06-23-manual-design-review", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    expect(getActiveFeatureSlug()).toBe(slug);

    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:ff-design-review" } as unknown as ExtensionEvent, NO_UI_CTX);

    clearFeatureStateCache();
    const state = loadFeatureState(slug, null);
    expect(state?.design.reviewLoopCount).toBe(1);
    // : the incremented count lives in feature-state (the durable source of
    // truth), read directly by the substitution pipeline loopIndex derivation +
    // subagent model overrides (no longer mirrored to an env var).
  });

  test("skill:ff-plan-review increments planReviewLoopCount", async () => {
    const { fake, api } = createPiWithToolCapture();
    const slug = writeFeatureStateFile("2026-06-23-manual-plan-review", {
      ...PLAN_ACTIVE_STATE,
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 1 },
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    expect(getActiveFeatureSlug()).toBe(slug);

    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:ff-plan-review" } as unknown as ExtensionEvent, NO_UI_CTX);

    clearFeatureStateCache();
    const state = loadFeatureState(slug, null);
    expect(state?.plan.reviewLoopCount).toBe(2);
    // : the incremented plan loop count is the durable source of truth
    // (consumers read it from feature-state, not an env var).
  });

  test("manual design-review does not touch planReviewLoopCount", async () => {
    const { fake, api } = createPiWithToolCapture();
    const slug = writeFeatureStateFile("2026-06-23-manual-design-isolated", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 3 },
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    expect(getActiveFeatureSlug()).toBe(slug);

    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:ff-design-review" } as unknown as ExtensionEvent, NO_UI_CTX);

    clearFeatureStateCache();
    const state = loadFeatureState(slug, null);
    expect(state?.design.reviewLoopCount).toBe(1);
    expect(state?.plan.reviewLoopCount).toBe(3); // unchanged
  });

  test("manual invocation with no active feature does not throw", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    expect(getActiveFeatureSlug()).toBeNull();

    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:ff-design-review" } as unknown as ExtensionEvent, NO_UI_CTX);
  });

  test("injected followUp (source=extension) does NOT increment counter (double-count guard)", async () => {
    // The phase_ready code path dispatches the review skill as a followUp via
    // sendUserMessage, which fires the input event with source === "extension".
    // input-gating must skip these so the manual + code paths never double-count.
    const { fake, api } = createPiWithToolCapture();
    const slug = writeFeatureStateFile("2026-06-23-extension-source-design-review", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 0 },
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    expect(getActiveFeatureSlug()).toBe(slug);

    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:ff-design-review", source: "extension" } as unknown as ExtensionEvent, NO_UI_CTX);

    clearFeatureStateCache();
    const state = loadFeatureState(slug, null);
    expect(state?.design.reviewLoopCount).toBe(0); // unchanged — guard skipped
  });

  test("cross-phase invocation: plan-review in design phase advances to plan and reflects plan loop count", async () => {
    // : pin cross-phase behavior. Invoking /skill:ff-plan-review while
    // currentPhase=design increments planReviewLoopCount (the invoked skill's
    // counter) and advances currentPhase to "plan" (via processSkillInput →
    // onInputText). After the input handler runs synchronously through
    // persistState, PI_FF_STAGE/LOOP reflect the plan phase and its
    // incremented loop count; designReviewLoopCount is untouched.
    const { fake, api } = createPiWithToolCapture();
    const slug = writeFeatureStateFile("2026-06-23-cross-phase-plan-review", {
      ...BRAINSTORM_ACTIVE_STATE,
      design: { doc: null, reviewActive: false, reviewLoopCount: 2 },
      plan: { doc: null, verifyLoopCount: 0, reviewActive: false, reviewLoopCount: 0 },
    });
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    expect(getActiveFeatureSlug()).toBe(slug);

    const onInput = getSingleHandler(fake.handlers, "input");
    onInput({ text: "/skill:ff-plan-review" } as unknown as ExtensionEvent, NO_UI_CTX);

    clearFeatureStateCache();
    const state = loadFeatureState(slug, null);
    // Invoked skill's counter incremented.
    expect(state?.plan.reviewLoopCount).toBe(1);
    // Current-phase counter untouched.
    expect(state?.design.reviewLoopCount).toBe(2);
    // /skill:ff-plan-review advances currentPhase to "plan" (via processSkillInput →
    // onInputText), so after the input handler runs synchronously through
    // persistState, PI_FF_STAGE reflects the plan phase and feature-state carries
    // its now-incremented loop count (read directly by consumers, not an env var).
    expect(process.env.PI_FF_STAGE).toBe("plan");
  });
});

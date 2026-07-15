// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { setSetting, setTestSettings } from "../helpers/settings-test-helpers.js";
import {
  createFakePi,
  fireAllHandlers,
  getExtendedToolHandlers,
  getSingleHandler,
  settleAndDrainPostTurnFollowUp,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

/** Set up the extension and return the /fy:next handler + helpers. */
function setup() {
  const fake = createFakePi();
  workflowMonitorExtension(fake.api as unknown as ExtensionAPI);

  const workflowNextRaw = fake.registeredCommands.get("fy:next");
  if (!workflowNextRaw) throw new Error("fy:next command not registered");
  const workflowNext = workflowNextRaw as (args: string, ctx: ExtensionContext) => Promise<void>;
  const inputHandler = getSingleHandler(fake.handlers, "input");
  const handlers = getExtendedToolHandlers(fake);

  return { fake, workflowNext, inputHandler, handlers };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const notifications: [string, string][] = [];
  const ctx: ExtensionContext & { notifications: [string, string][] } = {
    hasUI: true,
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" } as unknown as ExtensionContext["sessionManager"],
    ui: {
      setEditorText: () => {},
      notify: (message: string, _type?: "info" | "error" | "warning") => notifications.push([message, _type ?? ""]),
      select: async () => undefined,
      setWidget: () => {},
    } as unknown as ExtensionContext["ui"],
    actions: {},
    ...overrides,
  } as unknown as ExtensionContext & { notifications: [string, string][] };
  return { ctx, notifications };
}

describe("fy:next (rewritten)", () => {
  beforeEach(async () => {
    delete process.env.PI_FY_FEATURE;
    delete process.env.PI_FY_STAGE;
    // Fresh test-settings holder (schema defaults) for isolation between tests.
    setTestSettings(null);
  });

  test("warns when no active workflow", async () => {
    const { workflowNext } = setup();
    const { ctx, notifications } = makeCtx();

    await workflowNext("", ctx);

    expect(notifications.length).toBe(1);
    expect(notifications[0][0]).toMatch(/No active workflow/);
    expect(notifications[0][1]).toBe("warning");
  });

  test("does not create a new session (old behavior removed)", async () => {
    const { workflowNext } = setup();
    let newSessionCalls = 0;
    const { ctx } = makeCtx({
      newSession: async () => {
        newSessionCalls += 1;
        return { cancelled: false };
      },
    });

    await workflowNext("", ctx);

    // Should NOT call newSession — the old behavior is gone
    expect(newSessionCalls).toBe(0);
  });

  test("ignores arguments — operates on current phase only", async () => {
    const { workflowNext } = setup();
    const { ctx, notifications } = makeCtx();

    // Old behavior: "nonsense" would show usage error
    // New behavior: ignores args, just operates on current state
    await workflowNext("nonsense args here", ctx);
    expect(notifications.length).toBe(1);
    expect(notifications[0][0]).toMatch(/No active workflow/);
  });

  test("completes review phase and advances to uat when uatMode=after-review", async () => {
    setSetting("uatMode", "after-review");

    const { fake, workflowNext } = setup();
    const { ctx, notifications } = makeCtx();

    const slug = "2026-05-10-test-feature";
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "done",
          review: "in-progress",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "review",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          uat: null,
          finish: null,
        },
      },
    });

    // Reconstruct state from the file
    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);

    // Now trigger /fy:next
    await workflowNext("", ctx);

    // Should have completed review
    const completionNotif = notifications.find((n) => n[0].includes("completed") || n[0].includes("review"));
    expect(completionNotif).toBeDefined();

    // Should have sent a UAT notification
    const uatNotif = notifications.find((n) => n[0].includes("UAT"));
    expect(uatNotif).toBeDefined();
  });

  test("completes review phase and advances to finish when uatMode=off", async () => {
    setSetting("uatMode", "off");

    const { fake, workflowNext } = setup();
    const { ctx } = makeCtx();

    const slug = "2026-05-10-test-feature";
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "done",
          review: "in-progress",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "review",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          uat: null,
          finish: null,
        },
      },
    });

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);

    await workflowNext("", ctx);

    // fy-finish is staged for agent_end delivery — drain before asserting.
    await fireAllHandlers(fake.handlers, "agent_end", {}, ctx);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    // Should have sent finishing skill
    const finishMsg = fake.sentMessages.find((m) => m.message.includes("fy-finish"));
    expect(finishMsg).toBeDefined();
  });

  test("advances from design even when no design doc is recorded (pointer model)", async () => {
    const { fake, workflowNext } = setup();
    const { ctx } = makeCtx();

    const slug = "2026-05-10-test-feature";
    writeFeatureStateFile(slug, {
      workflow: {
        currentPhase: "design",
        // No design doc recorded
        designDoc: null,
        planDoc: null,
      },
    });

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);

    await workflowNext("", ctx);

    // In the pointer model fy:next always routes the current phase forward (the
    // design-doc precondition was removed); it advances to plan.
    const planMsg = fake.sentMessages.find((m) => m.message.includes("fy-plan"));
    expect(planMsg).toBeDefined();
  });

  test("advances already-complete phase to next", async () => {
    setSetting("uatMode", "after-review");

    const { fake, workflowNext } = setup();
    const { ctx, notifications } = makeCtx();

    const slug = "2026-05-10-test-feature";
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "done",
          review: "done",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "review",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          uat: null,
          finish: null,
        },
      },
    });

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);

    await workflowNext("", ctx);

    // Review is already complete, should advance to uat (after-review mode)
    const uatNotif = notifications.find((n) => n[0].includes("UAT"));
    expect(uatNotif).toBeDefined();
  });

  test("skips review and proceeds to finish when maxFeatureReviewRounds=off + uatMode=after-finish", async () => {
    setSetting("uatMode", "after-finish");
    setSetting("maxFeatureReviewRounds", 0);

    const { fake, workflowNext } = setup();
    const { ctx } = makeCtx();

    const slug = "2026-05-10-skip-review-after-finish";
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "in-progress",
          review: "pending",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "verify",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          uat: null,
          finish: null,
        },
      },
    });

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);

    await workflowNext("", ctx);

    // fy-finish is staged for agent_end delivery — drain before asserting.
    await fireAllHandlers(fake.handlers, "agent_end", {}, ctx);
    await settleAndDrainPostTurnFollowUp(fake.handlers);
    // Should have sent finishing skill (not review)
    const finishMsg = fake.sentMessages.find((m) => m.message.includes("fy-finish"));
    expect(finishMsg).toBeDefined();

    // Should NOT have sent any review skill
    const reviewMsg = fake.sentMessages.find((m) => m.message.includes('name="fy-review"'));
    expect(reviewMsg).toBeUndefined();

    // Should have advanced to finish (after-finish UAT driven by the derived check in phase_ready)
    const { loadFeatureState } = await import("../../src/state/feature-state.js");
    const state = loadFeatureState(slug, null);
    expect(state).not.toBeNull();
    const workflow = state?.workflow as { currentPhase: string; phases?: { uat?: string } };
    expect(workflow.currentPhase).toBe("finish");
    expect(workflow.phases?.uat).toBe("pending"); // not yet activated — cast for legacy test
  });

  test("fy:next review→UAT handoff merges the worth-notes pointer when notes exist", async () => {
    setSetting("uatMode", "after-review");
    const { fake, workflowNext } = setup();
    const { ctx, notifications } = makeCtx();
    const slug = "2026-05-10-next-worth-notes-present";
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "done",
          review: "done",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "review",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          uat: null,
          finish: null,
        },
      },
    });
    // Write a non-empty worth-notes file at the resolved slug path (relative to the temp cwd).
    const notesPath = path.join(process.cwd(), ".featyard", "reviews", slug, `${slug}-worth-notes.md`);
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.writeFileSync(notesPath, "## worth noting\n- an oddity\n");

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);
    await workflowNext("", ctx);

    // Advanced to uat; the handoff notify carries the worth-notes pointer (merged, not standalone).
    const uatNotif = notifications.find((n) => n[0].includes("moved to UAT"));
    expect(uatNotif).toBeDefined();
    expect(uatNotif?.[0]).toContain("📝 worth-notes:");
  });

  test("fy:next review→UAT handoff omits the worth-notes pointer when notes are absent", async () => {
    setSetting("uatMode", "after-review");
    const { fake, workflowNext } = setup();
    const { ctx, notifications } = makeCtx();
    const slug = "2026-05-10-next-worth-notes-absent";
    writeFeatureStateFile(slug, {
      workflow: {
        phases: {
          design: "done",
          plan: "done",
          implement: "done",
          verify: "done",
          review: "done",
          uat: "pending",
          finish: "pending",
        },
        currentPhase: "review",
        artifacts: {
          design: `docs/featyard/designs/${slug}-design.md`,
          plan: `.featyard/task-plans/${slug}-task-plan.md`,
          implement: null,
          verify: null,
          review: null,
          uat: null,
          finish: null,
        },
      },
    });
    // No worth-notes file written.

    await fireAllHandlers(fake.handlers, "session_start", { reason: "reload" }, ctx);
    await workflowNext("", ctx);

    const uatNotif = notifications.find((n) => n[0].includes("moved to UAT"));
    expect(uatNotif).toBeDefined();
    expect(uatNotif?.[0]).not.toContain("📝 worth-notes:");
  });
});

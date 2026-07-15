// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import type { Phase, PhaseProgressionState } from "../../src/phases/phase-progression.js";
import { mockExecSync, restoreExecSync } from "../helpers/mock-exec-sync.js";
import {
  createFakePi,
  enableSubagentMode,
  fireAllHandlers,
  getSingleHandler,
  writeFeatureStateFile,
} from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Publish gate: `git push` / `gh pr create`.
 * Rule: blocked until the finish phase; in finish, confirmed via showSelectWithNote
 * (Allow/Block, default Block). Commits are NOT gated here (pre-commit discipline owns them).
 */

// Spy on showSelectWithNote the same way avtc-pi-parallel-work-guardrail does (vi.spyOn on the
// live module export — works for symlinked file: deps where vi.mock factories don't intercept).
let showSelectWithNoteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  mockExecSync(vi.fn());
  const selectWithNoteModule = await import("avtc-pi-ui-components");
  showSelectWithNoteSpy = vi.spyOn(selectWithNoteModule, "showSelectWithNote").mockResolvedValue(null);
});
afterEach(() => {
  showSelectWithNoteSpy?.mockRestore();
  restoreExecSync();
});

function createWorkflowState(currentPhase: Phase | null): PhaseProgressionState {
  return { currentPhase, designDoc: "docs/featyard/designs/d.md", planDoc: ".featyard/task-plans/p.md" };
}

function createCtx(hasUI: boolean) {
  return {
    hasUI,
    sessionManager: { getBranch: () => [] },
    ui: { setWidget: () => {}, select: vi.fn(), setEditorText: () => {}, notify: () => {} },
    mode: "json",
  } as unknown as ExtensionContext;
}

/** Set up the extension with a feature at `phase` (or none when phase is null) and activate it. */
async function setup(phase: Phase | null, slug: string) {
  const fake = createFakePi();
  if (phase) writeFeatureStateFile(slug, { workflow: createWorkflowState(phase) });
  workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
  const onToolCall = getSingleHandler(fake.handlers, "tool_call");
  const ctx = createCtx(true);
  await fireAllHandlers(fake.handlers, "session_start", { source: "user", reason: "reload" }, ctx);
  return { onToolCall, ctx };
}

const PUBLISH_COMMANDS = ["git push origin main", "gh pr create --title x"];

describe("publish gate (git push / gh pr create)", () => {
  describe("hard-blocks before the finish phase (no dialog)", () => {
    for (const phase of ["design", "plan", "implement", "verify", "review", "uat"] as Phase[]) {
      for (const cmd of PUBLISH_COMMANDS) {
        test(`${cmd} in ${phase} → blocked, no dialog`, async () => {
          const { onToolCall, ctx } = await setup(phase, `pub-${phase}-${cmd.slice(0, 3)}`);
          const res = await onToolCall(
            { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: cmd } },
            ctx,
          );
          expect(res).toMatchObject({ block: true });
          expect(showSelectWithNoteSpy).not.toHaveBeenCalled();
        });
      }
    }
  });

  describe("in the finish phase, confirms via dialog", () => {
    test("Allow → allowed (no block)", async () => {
      showSelectWithNoteSpy.mockResolvedValue({ value: "allow", note: "" });
      const { onToolCall, ctx } = await setup("finish", "pub-finish-allow");
      const res = await onToolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } },
        ctx,
      );
      expect((res as { block?: boolean } | undefined)?.block).not.toBe(true);
      expect(showSelectWithNoteSpy).toHaveBeenCalledTimes(1);
    });

    test("Block → blocked", async () => {
      showSelectWithNoteSpy.mockResolvedValue({ value: "block", note: "" });
      const { onToolCall, ctx } = await setup("finish", "pub-finish-block");
      const res = await onToolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } },
        ctx,
      );
      expect(res).toMatchObject({ block: true });
    });

    test("no response (null) → blocked (default Block / fail-closed)", async () => {
      showSelectWithNoteSpy.mockResolvedValue(null);
      const { onToolCall, ctx } = await setup("finish", "pub-finish-null");
      const res = await onToolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } },
        ctx,
      );
      expect(res).toMatchObject({ block: true });
    });

    test("default option passed to dialog is Block (fail-closed)", async () => {
      showSelectWithNoteSpy.mockResolvedValue({ value: "block", note: "" });
      const { onToolCall, ctx } = await setup("finish", "pub-finish-default");
      await onToolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "gh pr create" } },
        ctx,
      );
      const defaultOpt = showSelectWithNoteSpy.mock.calls[0]?.[3]; // 4th arg = defaultOption
      expect(defaultOpt?.value).toBe("block");
    });
  });

  describe("not gated when no active feature", () => {
    test("git push with no active feature → allowed (no gate)", async () => {
      const { onToolCall, ctx } = await setup(null, "pub-no-feature");
      const res = await onToolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } },
        ctx,
      );
      expect((res as { block?: boolean } | undefined)?.block).not.toBe(true);
      expect(showSelectWithNoteSpy).not.toHaveBeenCalled();
    });
  });

  describe("commit and non-publish commands are not gated by the publish gate", () => {
    test("git commit in implement → not publish-gated (pre-commit discipline owns commits)", async () => {
      const { onToolCall, ctx } = await setup("implement", "pub-commit");
      await onToolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git commit -m 'x'" } },
        ctx,
      );
      expect(showSelectWithNoteSpy).not.toHaveBeenCalled();
    });

    test("non-matching bash command in finish → allowed", async () => {
      const { onToolCall, ctx } = await setup("finish", "pub-nonmatch");
      const res = await onToolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "ls -la" } },
        ctx,
      );
      expect((res as { block?: boolean } | undefined)?.block).not.toBe(true);
      expect(showSelectWithNoteSpy).not.toHaveBeenCalled();
    });
  });

  describe("subagent session is NOT skipped — dialog is forwarded via the bridge", () => {
    test("subagent (env set) in finish → dialog still invoked (bridge forwards to root)", async () => {
      enableSubagentMode();
      showSelectWithNoteSpy.mockResolvedValue({ value: "allow", note: "" });
      const { onToolCall, ctx } = await setup("finish", "pub-subagent-finish");
      const res = await onToolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } },
        ctx,
      );
      // The gate must NOT be skipped for subagents — showSelectWithNote handles forwarding.
      expect(showSelectWithNoteSpy).toHaveBeenCalledTimes(1);
      expect((res as { block?: boolean } | undefined)?.block).not.toBe(true);
    });

    test("subagent (env set) before finish → hard-blocked (same as interactive)", async () => {
      enableSubagentMode();
      const { onToolCall, ctx } = await setup("verify", "pub-subagent-pre-finish");
      const res = await onToolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } },
        ctx,
      );
      expect(res).toMatchObject({ block: true });
      expect(showSelectWithNoteSpy).not.toHaveBeenCalled();
    });
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test } from "vitest";
import {
  isPhaseActive,
  isPhaseDone,
  isPhasePending,
  type Phase,
  PhaseProgression,
  type PhaseProgressionState,
  type PhaseProgressionView,
  parseSkillName,
  SKILL_TO_PHASE,
  WORKFLOW_PHASES,
} from "../../src/phases/phase-progression.js";

/** The machine owns only a pointer (no completedAt); status is derived with a null completedAt. */
function view(s: PhaseProgressionState): PhaseProgressionView {
  return { currentPhase: s.currentPhase, completedAt: null };
}

describe("PhaseProgression", () => {
  let tracker: PhaseProgression;

  beforeEach(() => {
    tracker = new PhaseProgression();
  });

  test("starts idle with all phases pending", () => {
    const s = tracker.getState();
    expect(s.currentPhase).toBeNull();
    for (const p of WORKFLOW_PHASES) expect(isPhasePending(view(s), p)).toBe(true);
  });

  test("setCurrentPhase forward derives earlier phases as done (new pointer model)", () => {
    // In the new pointer model, jumping forward implicitly completes every jumped-over phase
    // (status is derived from the pointer). This is the inverse of the old status-map model.
    tracker.setCurrentPhase("implement");
    const s = tracker.getState();
    expect(s.currentPhase).toBe("implement");
    expect(isPhaseDone(view(s), "design")).toBe(true);
    expect(isPhaseDone(view(s), "plan")).toBe(true);
    expect(isPhaseActive(view(s), "implement")).toBe(true);
  });

  test("setCurrentPhase to a phase marks it active and earlier as done", () => {
    // skipPhase("plan") equivalent: moving the pointer past plan (to implement) derives plan done.
    tracker.setCurrentPhase("implement");
    expect(isPhaseDone(view(tracker.getState()), "plan")).toBe(true);
  });

  test("setCurrentPhase same phase is a no-op (returns false)", () => {
    tracker.setCurrentPhase("plan");
    const changed = tracker.setCurrentPhase("plan");
    expect(changed).toBe(false);
    expect(tracker.getState().currentPhase).toBe("plan");
  });

  test("setCurrentPhase returns true when the pointer changes", () => {
    expect(tracker.setCurrentPhase("design")).toBe(true);
    expect(tracker.setCurrentPhase("plan")).toBe(true);
  });

  test("setCurrentPhase backward derives target-onward phases as pending", () => {
    // Set up: design done, plan done, implement active — then go back to design.
    tracker.setCurrentPhase("design");
    tracker.recordDoc("design", "docs/ff/designs/foo-design.md");
    tracker.setCurrentPhase("plan");
    tracker.recordDoc("plan", ".ff/task-plans/foo-task-plan.md");
    tracker.setCurrentPhase("implement");

    // Go back to design (backward navigation)
    const result = tracker.setCurrentPhase("design");

    const s = tracker.getState();
    expect(result).toBe(true);
    expect(s.currentPhase).toBe("design");
    // design is the target — now active
    expect(isPhaseActive(view(s), "design")).toBe(true);
    // phases after the target are pending again (derived)
    expect(isPhasePending(view(s), "plan")).toBe(true);
    expect(isPhasePending(view(s), "implement")).toBe(true);
  });

  test("setCurrentPhase backward preserves completed phases before target", () => {
    // design done, plan done, implement active — then go back to plan
    tracker.setCurrentPhase("design");
    tracker.recordDoc("design", "docs/ff/designs/foo-design.md");
    tracker.setCurrentPhase("plan");
    tracker.recordDoc("plan", ".ff/task-plans/foo-task-plan.md");
    tracker.setCurrentPhase("implement");

    // Go back to plan — design (before plan) is still derived as done
    tracker.setCurrentPhase("plan");

    const s = tracker.getState();
    expect(s.currentPhase).toBe("plan");
    // design is BEFORE plan — still derived done
    expect(isPhaseDone(view(s), "design")).toBe(true);
    // plan is the target — now active
    expect(isPhaseActive(view(s), "plan")).toBe(true);
    // implement is AFTER plan — derived pending again
    expect(isPhasePending(view(s), "implement")).toBe(true);
    // recorded docs are retained (the machine keeps them across pointer moves)
    expect(s.designDoc).toBe("docs/ff/designs/foo-design.md");
    expect(s.planDoc).toBe(".ff/task-plans/foo-task-plan.md");
  });

  test("setCurrentPhase backward to design derives all later phases pending", () => {
    tracker.setCurrentPhase("implement");
    expect(isPhaseActive(view(tracker.getState()), "implement")).toBe(true);

    tracker.setCurrentPhase("design");

    const s = tracker.getState();
    expect(s.currentPhase).toBe("design");
    expect(isPhaseActive(view(s), "design")).toBe(true);
    for (const p of WORKFLOW_PHASES) {
      if (p !== "design") expect(isPhasePending(view(s), p)).toBe(true);
    }
  });

  test("records docs per phase", () => {
    tracker.recordDoc("design", "docs/ff/designs/2026-02-10-x-design.md");
    expect(tracker.getState().designDoc).toBe("docs/ff/designs/2026-02-10-x-design.md");
    expect(tracker.getState().planDoc).toBeNull();
  });

  test("reset restores tracker to empty state regardless of prior state", () => {
    tracker.setCurrentPhase("implement");
    tracker.recordDoc("plan", ".ff/task-plans/2026-02-20-foo-task-plan.md");

    tracker.reset();

    const s = tracker.getState();
    expect(s.currentPhase).toBeNull();
    for (const p of WORKFLOW_PHASES) expect(isPhasePending(view(s), p)).toBe(true);
    expect(s.designDoc).toBeNull();
    expect(s.planDoc).toBeNull();
  });
});

function custom(data: unknown): SessionEntry {
  return {
    type: "custom",
    id: "x",
    parentId: null,
    timestamp: new Date(Date.now()).toISOString(),
    customType: "phase_progression_state",
    data,
  };
}

describe("PhaseProgression detection helpers", () => {
  test("SKILL_TO_PHASE exposes expected skill mappings", () => {
    expect(SKILL_TO_PHASE).toEqual({
      "ff-design": "design",
      "ff-plan": "plan",
      "ff-implement": "implement",
      // subagent-driven-development removed — unified into ff-implement
      "ff-verify": "verify",
      "ff-review": "review",
      "ff-design-review": "design",
      "ff-plan-review": "plan",
      "ff-finish": "finish",
    });
  });

  test('parseSkillName extracts /skill and <skill name="...">', () => {
    expect(parseSkillName("/skill:ff-plan blah")).toBe("ff-plan");
    expect(parseSkillName('  <skill name="ff-design" location="/x">')).toBe("ff-design");
    expect(parseSkillName("nope /skill:ff-plan")).toBeNull();
  });

  test("detects /skill:ff-design and advances to design", () => {
    const tracker = new PhaseProgression();
    const changed = tracker.onInputText("/skill:ff-design");
    expect(changed).toBe(true);
    expect(tracker.getState().currentPhase).toBe("design");
  });

  test("detects /skill token with trailing text at start of a later line", () => {
    const tracker = new PhaseProgression();
    const changed = tracker.onInputText("status update\n/skill:ff-plan draft initial breakdown");
    expect(changed).toBe(true);
    expect(tracker.getState().currentPhase).toBe("plan");
  });

  test("does not activate workflow from verify/review/finish skills when no workflow is active", () => {
    const tracker = new PhaseProgression();

    const verifyChanged = tracker.onInputText("/skill:ff-verify run checks");
    expect(verifyChanged).toBe(false);
    expect(tracker.getState().currentPhase).toBeNull();

    const reviewChanged = tracker.onInputText("/skill:ff-review");
    expect(reviewChanged).toBe(false);
    expect(tracker.getState().currentPhase).toBeNull();

    const finishChanged = tracker.onInputText("/skill:ff-finish");
    expect(finishChanged).toBe(false);
    expect(tracker.getState().currentPhase).toBeNull();
  });

  test("verify/review/finish skills still work when a workflow is already active", () => {
    const tracker = new PhaseProgression();
    tracker.setCurrentPhase("implement");

    const changed = tracker.onInputText("/skill:ff-verify run checks");
    expect(changed).toBe(true);
    expect(tracker.getState().currentPhase).toBe("verify");
  });

  test("execute skill still activates a fresh workflow (plan-doc entry point)", () => {
    const tracker = new PhaseProgression();
    const changed = tracker.onInputText("/skill:ff-implement");
    expect(changed).toBe(true);
    expect(tracker.getState().currentPhase).toBe("implement");
  });

  test("continues scanning when first recognized /skill line is a no-op and later line advances", () => {
    const tracker = new PhaseProgression();
    tracker.setCurrentPhase("plan");

    const changed = tracker.onInputText("/skill:ff-design\n/skill:ff-verify run checks");

    expect(changed).toBe(true);
    expect(tracker.getState().currentPhase).toBe("verify");
  });

  test("ignores unknown /skill line and advances on later valid /skill line", () => {
    const tracker = new PhaseProgression();

    const changed = tracker.onInputText("/skill:not-a-real-skill\n/skill:ff-plan");

    expect(changed).toBe(true);
    expect(tracker.getState().currentPhase).toBe("plan");
  });

  test("does not detect /skill token when not at line start", () => {
    const tracker = new PhaseProgression();
    const changed = tracker.onInputText("please run /skill:ff-plan draft initial breakdown");
    expect(changed).toBe(false);
    expect(tracker.getState().currentPhase).toBeNull();
  });

  test("records design artifact when design doc written", () => {
    const tracker = new PhaseProgression();
    tracker.onFileWritten("docs/ff/designs/2026-02-10-foo-design.md");
    const s = tracker.getState();
    // onFileWritten records docs only — does NOT advance phase
    expect(s.designDoc).toBe("docs/ff/designs/2026-02-10-foo-design.md");
    expect(s.currentPhase).toBeNull(); // no phase transition
  });

  test("records design artifact with Windows backslash paths", () => {
    const tracker = new PhaseProgression();
    tracker.onFileWritten("docs\\ff\\designs\\2026-02-10-foo-design.md");
    const s = tracker.getState();
    expect(s.designDoc).toBe("docs\\ff\\designs\\2026-02-10-foo-design.md");
    expect(s.currentPhase).toBeNull();
  });

  test("records plan artifact with Windows backslash paths", () => {
    const tracker = new PhaseProgression();
    tracker.onFileWritten(".ff\\task-plans\\2026-02-11-foo-task-plan.md");
    const s = tracker.getState();
    expect(s.planDoc).toBe(".ff\\task-plans\\2026-02-11-foo-task-plan.md");
    expect(s.currentPhase).toBeNull();
  });

  test("records plan artifact when task-plan doc written", () => {
    const tracker = new PhaseProgression();
    tracker.onFileWritten(".ff/task-plans/2026-02-11-foo-task-plan.md");
    const s = tracker.getState();
    expect(s.planDoc).toBe(".ff/task-plans/2026-02-11-foo-task-plan.md");
    expect(s.currentPhase).toBeNull(); // no phase transition
  });

  test("does NOT record a design doc written to the task-plans dir (strict dir/suffix pairing)", () => {
    // Design docs belong in docs/ff/designs/; a -design.md under .ff/task-plans/ is misplaced
    // and must not be recorded as a design artifact.
    const tracker = new PhaseProgression();
    tracker.onFileWritten(".ff/task-plans/2026-02-10-foo-design.md");
    const s = tracker.getState();
    expect(s.designDoc).toBeNull();
    expect(s.planDoc).toBeNull();
  });

  test("does NOT record a task-plan written to the designs dir (strict dir/suffix pairing)", () => {
    // Task-plans belong in .ff/task-plans/; a -task-plan.md under docs/ff/designs/ is misplaced
    // and must not be recorded as a plan artifact.
    const tracker = new PhaseProgression();
    tracker.onFileWritten("docs/ff/designs/2026-02-11-foo-task-plan.md");
    const s = tracker.getState();
    expect(s.designDoc).toBeNull();
    expect(s.planDoc).toBeNull();
  });

  test("does NOT record an arbitrary source file as an artifact", () => {
    const tracker = new PhaseProgression();
    tracker.onFileWritten("extensions/workflow-monitor/widget.ts");
    const s = tracker.getState();
    expect(s.designDoc).toBeNull();
    expect(s.planDoc).toBeNull();
  });

  test("reconstructFromBranch returns last saved state", () => {
    const tracker = new PhaseProgression();
    tracker.setCurrentPhase("plan");
    const s1 = tracker.getState();

    tracker.setCurrentPhase("implement");
    const s2 = tracker.getState();

    const reconstructed = PhaseProgression.reconstructFromBranch([
      custom(s1),
      {
        type: "message",
        id: "msg",
        parentId: null,
        timestamp: "",
        message: { role: "user", content: "" },
      } as SessionEntry,
      custom(s2),
    ] as SessionEntry[]);

    expect(reconstructed?.currentPhase).toBe("implement");
  });
});

describe("derived status helpers", () => {
  test("isPhaseDone returns true for phases before the pointer", () => {
    const v: PhaseProgressionView = { currentPhase: "implement", completedAt: null };
    expect(isPhaseDone(v, "design")).toBe(true);
    expect(isPhaseDone(v, "plan")).toBe(true);
    expect(isPhaseDone(v, "implement")).toBe(false);
  });

  test("isPhaseActive returns true only for the pointer phase", () => {
    const v: PhaseProgressionView = { currentPhase: "plan", completedAt: null };
    expect(isPhaseActive(v, "design")).toBe(false);
    expect(isPhaseActive(v, "plan")).toBe(true);
    expect(isPhaseActive(v, "implement")).toBe(false);
  });

  test("isPhasePending returns true for phases after the pointer", () => {
    const v: PhaseProgressionView = { currentPhase: "plan", completedAt: null };
    expect(isPhasePending(v, "design")).toBe(false);
    expect(isPhasePending(v, "plan")).toBe(false);
    expect(isPhasePending(v, "implement")).toBe(true);
  });

  test("completed features derive every phase as done", () => {
    const v: PhaseProgressionView = { currentPhase: "finish", completedAt: "2026-01-01T00:00:00.000Z" };
    for (const p of WORKFLOW_PHASES) expect(isPhaseDone(v, p as Phase)).toBe(true);
  });
});

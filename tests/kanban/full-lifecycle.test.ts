// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KanbanDatabase } from "../../src/kanban/data/kanban-database.js";
import type { Feature } from "../../src/kanban/data/kanban-types.js";
import { KanbanTools } from "../../src/kanban/kanban-operations.js";
import { isPhaseDone, isPhasePending } from "../../src/phases/phase-progression.js";
import {
  createFeatureStateFromKanban,
  type FeatureState,
  loadFeatureState,
  markFeatureDone,
  saveFeatureState,
} from "../../src/state/feature-state.js";

const TEMP_DIRS: string[] = [];
const dbs: KanbanDatabase[] = [];
let originalCwd: string = process.cwd();

/** Build the derived-status view the helpers expect. */
const view = (s: FeatureState) => ({ currentPhase: s.workflow.currentPhase, completedAt: s.completedAt });

function cleanup() {
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  if (originalCwd) {
    process.chdir(originalCwd);
  }
}

async function createTestDb(): Promise<KanbanDatabase> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-db-"));
  TEMP_DIRS.push(dir);
  const db = await KanbanDatabase.createInMemory();
  dbs.push(db);
  return db;
}

/**
 * Simulate the full feature lifecycle:
 * 1. Add to kanban backlog
 * 2. Move through lanes (design → ready → in-progress)
 * 3. Execute workflow phases (design → plan → implement → verify → review)
 * 4. Handle UAT based on mode
 * 5. Finish → done
 *
 * Phase status is DERIVED from workflow.currentPhase + completedAt (never stored).
 */
describe("full feature lifecycle with kanban", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    cleanup();
    delete process.env.PI_FF_FEATURE;
    delete process.env.PI_FF_STAGE;
  });

  test("feature goes from backlog to done with after-review UAT", async () => {
    const db = await createTestDb();
    const tools = new KanbanTools(db);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"));
    TEMP_DIRS.push(workDir);
    process.chdir(workDir);
    fs.mkdirSync(path.join(workDir, ".pi"), { recursive: true });

    const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
    const slug = "2026-05-16-lifecycle-after-review";

    // 1. Add feature to kanban backlog
    const featureId = tools.kanbanAdd({ projectId, slug, title: "Lifecycle Test Feature" });
    let feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("backlog");

    // 2. Move to design lane (simulates design phase start)
    db.moveFeature({ featureId, toLane: "design", changedBy: "system", note: "start design" });
    feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("design");

    // 3. Create feature state for kanban-picked feature at design lane (pointer null = all pending)
    const state = createFeatureStateFromKanban(slug, { lane: "design", branch: null, worktreePath: null });
    expect(isPhasePending(view(state), "design")).toBe(true);
    saveFeatureState(state, path.join(workDir, ".pi"));

    // 4. Simulate design phase completing → move pointer to plan (design derived done)
    let loaded = loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState;
    loaded.workflow.currentPhase = "plan";
    saveFeatureState(loaded, path.join(workDir, ".pi"));

    // Feature stays in design during design (auto-agent keeps it there)
    feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("design");

    // 5. Plan completes → move pointer to implement (plan derived done)
    loaded = loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState;
    loaded.workflow.currentPhase = "implement";
    saveFeatureState(loaded, path.join(workDir, ".pi"));

    // Move kanban card to ready
    db.moveFeature({ featureId, toLane: "ready", changedBy: "system", note: "plan complete" });

    // 6. kanban_take picks from ready → in-progress
    const taken = tools.kanbanTake({ sessionId: "session-1", lanes: ["ready"], projectId });
    expect(taken).toBeTruthy();
    expect((taken as NonNullable<typeof taken>).id).toBe(featureId);
    feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("in-progress");
    expect(feature.locked_at).toBeTruthy();

    // 7. Execute → verify → review phases complete → pointer advances to uat
    loaded = loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState;
    loaded.workflow.currentPhase = "uat";
    saveFeatureState(loaded, path.join(workDir, ".pi"));

    // Auto-agent keeps feature in in-progress during execute/verify/review
    feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("in-progress");

    // Auto-agent moves feature to uat lane when UAT becomes active
    db.moveFeature({ featureId, toLane: "uat", changedBy: "agent:session-1", note: "UAT handoff" });
    feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("uat");

    // 9. UAT accepted → finish → done
    const accepted = loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState;
    accepted.workflow.currentPhase = "finish";
    saveFeatureState(accepted, path.join(workDir, ".pi"));

    // Auto-agent moves feature to done lane on completion
    const doneState = markFeatureDone(loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState);
    saveFeatureState(doneState, path.join(workDir, ".pi"));
    db.moveFeature({ featureId, toLane: "done", changedBy: "agent:session-1", note: "feature complete" });
    feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("done");

    // 10. Verify final state
    const finalState = loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState;
    expect(finalState.completedAt).not.toBeNull();
    expect(isPhaseDone(view(finalState), "uat")).toBe(true);
    expect(isPhaseDone(view(finalState), "finish")).toBe(true);

    // Release lock
    tools.kanbanRelease({ featureId });
    feature = db.getFeature(featureId) as Feature;
    expect(feature.locked_at).toBeNull();
  });

  test("feature goes from backlog to done with off UAT (auto-skip)", async () => {
    const db = await createTestDb();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"));
    TEMP_DIRS.push(workDir);
    process.chdir(workDir);
    fs.mkdirSync(path.join(workDir, ".pi"), { recursive: true });

    const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
    const slug = "2026-05-16-lifecycle-off-uat";

    // Add and advance through kanban
    const featureId = db.createFeature({
      projectId,
      slug,
      title: "Off UAT Feature",
      lane: "in-progress",
    });

    // Create feature state at in-progress; advance pointer to finish (design..review derived done)
    const state = createFeatureStateFromKanban(slug, { lane: "in-progress", branch: null, worktreePath: null });
    state.workflow.currentPhase = "finish";
    saveFeatureState(state, path.join(workDir, ".pi"));

    // With UAT off, feature goes directly from review → finish. Finish completes → done.
    const doneState = markFeatureDone(loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState);
    saveFeatureState(doneState, path.join(workDir, ".pi"));

    // Auto-agent moves to done on completion
    db.moveFeature({ featureId, toLane: "done", changedBy: "agent", note: "feature complete" });
    const feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("done");

    // UAT was never entered in off mode: the feature completed directly through finish.
    // (In the derived model uat cannot be distinguished as 'pending' once the pointer is at/past
    //  finish or completedAt is set — the completion check above is the meaningful assertion.)
    const finalState = loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState;
    expect(finalState.completedAt).not.toBeNull();
  });

  test("feature goes from backlog to done with after-finish UAT", async () => {
    const db = await createTestDb();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"));
    TEMP_DIRS.push(workDir);
    process.chdir(workDir);
    fs.mkdirSync(path.join(workDir, ".pi"), { recursive: true });

    const projectId = db.createProject({ name: "test-project", repoPath: "/test" });
    const slug = "2026-05-16-lifecycle-after-finish";

    // Add to kanban and advance
    const featureId = db.createFeature({
      projectId,
      slug,
      title: "After-Finish UAT Feature",
      lane: "in-progress",
    });

    // All phases through finish complete; pointer at uat (after-finish mode).
    const state = createFeatureStateFromKanban(slug, { lane: "in-progress", branch: null, worktreePath: null });
    state.workflow.currentPhase = "uat";
    saveFeatureState(state, path.join(workDir, ".pi"));

    // With after-finish mode: finish is complete, but UAT not yet resolved.
    // Feature should NOT be marked done yet (UAT not yet resolved)
    let feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("in-progress");

    // Auto-agent moves to UAT lane on UAT handoff
    db.moveFeature({ featureId, toLane: "uat", changedBy: "agent", note: "UAT handoff" });
    feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("uat");

    // UAT accepted → done (pointer stays at uat; completedAt marks feature done)
    const doneState = markFeatureDone(loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState);
    saveFeatureState(doneState, path.join(workDir, ".pi"));

    // Auto-agent moves to done on completion
    db.moveFeature({ featureId, toLane: "done", changedBy: "agent", note: "feature complete" });
    feature = db.getFeature(featureId) as Feature;
    expect(feature.lane).toBe("done");

    const finalState = loadFeatureState(slug, path.join(workDir, ".pi")) as FeatureState;
    expect(finalState.completedAt).not.toBeNull();
    expect(isPhaseDone(view(finalState), "uat")).toBe(true);
  });
});

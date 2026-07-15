// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Phase } from "../../src/phases/phase-progression.js";
import { isPhaseDone, isPhasePending } from "../../src/phases/phase-progression.js";
import {
  clearFeatureStateCache,
  createFeatureState,
  createFeatureStateForSubFeature,
  createFeatureStateFromPlan,
  deleteStateFile,
  featureSlugFromDesignDoc,
  featureSlugFromPlanDoc,
  loadFeatureState,
  markFeatureDone,
  saveFeatureState,
  scanActiveFeatures,
  stateDir,
  stateFilePath,
} from "../../src/state/feature-state.js";

/** Build the derived-status view from a FeatureState. */
function view(state: { workflow: { currentPhase: string | null }; completedAt: string | null }) {
  return { currentPhase: state.workflow.currentPhase as unknown as Phase, completedAt: state.completedAt };
}

const ORIGINAL_CWD = process.cwd();
const TEMP_DIRS: string[] = [];

function withTempCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-state-test-"));
  TEMP_DIRS.push(dir);
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  clearFeatureStateCache();
  if (process.cwd() !== ORIGINAL_CWD) {
    process.chdir(ORIGINAL_CWD);
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// --- featureSlugFromDesignDoc ---

describe("featureSlugFromDesignDoc", () => {
  test("extracts slug from design doc path", () => {
    expect(featureSlugFromDesignDoc("docs/featyard/designs/2026-05-08-permission-modal-design.md")).toBe(
      "2026-05-08-permission-modal",
    );
  });

  test("extracts slug from another design doc", () => {
    expect(featureSlugFromDesignDoc("docs/featyard/designs/2026-02-08-login-throttle-design.md")).toBe(
      "2026-02-08-login-throttle",
    );
  });

  test("returns null for non-design doc", () => {
    expect(featureSlugFromDesignDoc("src/foo.ts")).toBeNull();
  });

  test("returns null for implementation doc", () => {
    expect(featureSlugFromDesignDoc(".featyard/task-plans/2026-05-08-permission-modal-task-plan.md")).toBeNull();
  });

  test("returns null for random markdown file", () => {
    expect(featureSlugFromDesignDoc("docs/plans/readme.md")).toBeNull();
  });
});

// --- featureSlugFromPlanDoc ---

describe("featureSlugFromPlanDoc", () => {
  test("extracts slug from implementation plan doc", () => {
    expect(featureSlugFromPlanDoc(".featyard/task-plans/2026-05-08-permission-modal-task-plan.md")).toBe(
      "2026-05-08-permission-modal",
    );
  });

  test("returns null for design doc", () => {
    expect(featureSlugFromPlanDoc("docs/featyard/designs/2026-05-08-permission-modal-design.md")).toBeNull();
  });

  test("returns null for non-plan doc", () => {
    expect(featureSlugFromPlanDoc("src/foo.ts")).toBeNull();
  });
});

// --- stateFilePath ---

describe("stateFilePath", () => {
  test("returns correct path for a slug", () => {
    expect(stateFilePath("2026-05-08-permission-modal", null)).toBe(
      path.join(process.cwd(), ".featyard", "feature-state", "2026-05-08-permission-modal.json"),
    );
  });
});

// --- stateDir ---

describe("stateDir", () => {
  test("returns.featyard/feature-state directory", () => {
    expect(stateDir()).toBe(path.join(process.cwd(), ".featyard", "feature-state"));
  });
});

// --- createFeatureState ---

describe("createFeatureState", () => {
  test("creates state with active status and correct fields", () => {
    const state = createFeatureState(
      "2026-05-08-test-feature",
      "docs/featyard/designs/2026-05-08-test-feature-design.md",
    );

    expect(state.completedAt).toBeNull();
    expect(state.featureSlug).toBe("2026-05-08-test-feature");
    expect(state.design.doc).toBe("docs/featyard/designs/2026-05-08-test-feature-design.md");
    expect(state.git.branch).toBeNull();
    expect(state.git.baseBranch).toBeNull();
    expect(state.completedAt).toBeNull();
    expect(state.createdAt).toBeTruthy();
    expect(state.updatedAt).toBeTruthy();
    // design is the active pointer phase (in-progress); nothing is derived-done yet
    expect(isPhaseDone(view(state), "design")).toBe(false);
    expect(state.workflow.currentPhase).toBe("design");
    expect(state.design.doc).toBe("docs/featyard/designs/2026-05-08-test-feature-design.md");
  });
});

// --- markFeatureDone ---

describe("markFeatureDone", () => {
  test("sets status to done and sets completedAt", () => {
    const state = createFeatureState(
      "2026-05-08-test-feature",
      "docs/featyard/designs/2026-05-08-test-feature-design.md",
    );
    const done = markFeatureDone(state);

    expect(done.completedAt).not.toBeNull();
    expect(done.completedAt).toBeTruthy();
    expect(done.featureSlug).toBe("2026-05-08-test-feature");
  });

  test("does not mutate the original state", () => {
    const state = createFeatureState(
      "2026-05-08-test-feature",
      "docs/featyard/designs/2026-05-08-test-feature-design.md",
    );
    const originalCompletedAt = state.completedAt;
    markFeatureDone(state);

    expect(state.completedAt).toBe(originalCompletedAt);
  });
});

// --- saveFeatureState / loadFeatureState ---

describe("saveFeatureState / loadFeatureState", () => {
  test("saves and loads feature state round-trip", () => {
    withTempCwd();
    const slug = "2026-05-08-test-feature";
    const state = createFeatureState(slug, "docs/featyard/designs/2026-05-08-test-feature-design.md");

    saveFeatureState(state, null);

    const loaded = loadFeatureState(slug, null);
    expect(loaded).not.toBeNull();
    expect(loaded?.featureSlug).toBe(slug);
    expect(loaded?.completedAt).toBeNull();
    expect(loaded?.design.doc).toBe("docs/featyard/designs/2026-05-08-test-feature-design.md");
    expect(loaded?.workflow.currentPhase).toBe("design");
    expect(isPhaseDone(view(loaded as unknown as NonNullable<typeof loaded>), "design")).toBe(false);
  });

  test("loadFeatureState returns null when file does not exist", () => {
    withTempCwd();
    expect(loadFeatureState("nonexistent-slug", null)).toBeNull();
  });

  test("saveFeatureState creates.featyard/feature-state directory if needed", () => {
    withTempCwd();
    const slug = "2026-05-08-test-feature";
    const state = createFeatureState(slug, "docs/featyard/designs/2026-05-08-test-feature-design.md");

    saveFeatureState(state, null);

    expect(fs.existsSync(path.join(process.cwd(), ".featyard", "feature-state"))).toBe(true);
  });

  test("saveFeatureState accepts custom dir", () => {
    const tempDir = withTempCwd();
    const customDir = path.join(tempDir, "custom-pi");
    const slug = "2026-05-08-test-feature";
    const state = createFeatureState(slug, "docs/featyard/designs/2026-05-08-test-feature-design.md");

    saveFeatureState(state, customDir);

    expect(fs.existsSync(path.join(customDir, `${slug}.json`))).toBe(true);
  });

  test("loadFeatureState accepts custom dir", () => {
    const tempDir = withTempCwd();
    const customDir = path.join(tempDir, "custom-pi");
    const slug = "2026-05-08-test-feature";
    const state = createFeatureState(slug, "docs/featyard/designs/2026-05-08-test-feature-design.md");

    saveFeatureState(state, customDir);
    const loaded = loadFeatureState(slug, customDir);

    expect(loaded).not.toBeNull();
    expect(loaded?.featureSlug).toBe(slug);
  });
});

// --- scanActiveFeatures ---

describe("scanActiveFeatures", () => {
  test("returns only active features, sorted by updatedAt desc", () => {
    // withTempCwd changes cwd into a temp dir so state files never leak; scanActiveFeatures
    // reads from stateDir() = <cwd>/.featyard/feature-state (created on save).
    withTempCwd();

    // Create two active features with different timestamps
    const state1 = createFeatureState(
      "2026-01-01-first-feature",
      "docs/featyard/designs/2026-01-01-first-feature-design.md",
    );
    const state2 = createFeatureState(
      "2026-02-01-second-feature",
      "docs/featyard/designs/2026-02-01-second-feature-design.md",
    );

    // Make state1 older
    state1.updatedAt = "2026-01-01T00:00:00.000Z";
    state2.updatedAt = "2026-02-01T00:00:00.000Z";

    saveFeatureState(state1, null);
    saveFeatureState(state2, null);

    // Also create a done feature (should not appear)
    const state3 = createFeatureState(
      "2026-03-01-done-feature",
      "docs/featyard/designs/2026-03-01-done-feature-design.md",
    );
    const done3 = markFeatureDone(state3);
    saveFeatureState(done3, null);

    const active = scanActiveFeatures(null);
    expect(active.length).toBe(2);
    expect(active[0]?.featureSlug).toBe("2026-02-01-second-feature");
    expect(active[1]?.featureSlug).toBe("2026-01-01-first-feature");
  });

  test("returns empty array when no state files exist", () => {
    withTempCwd();
    expect(scanActiveFeatures(null)).toEqual([]);
  });

  test("skips a stray valid-JSON.json file that is not a feature state (no featureSlug)", () => {
    // A non-feature JSON file in the state dir (e.g. a config/manifest dump) must not be parsed
    // as an active feature. The structural guard (featureSlug present) rejects it.
    withTempCwd();
    const real = createFeatureState(
      "2026-04-01-real-feature",
      "docs/featyard/designs/2026-04-01-real-feature-design.md",
    );
    saveFeatureState(real, null);
    // A stray valid-JSON file with no featureSlug + no completedAt — would otherwise be included.
    const strayPath = path.join(stateDir(), "not-a-feature.json");
    fs.writeFileSync(strayPath, JSON.stringify({ hello: "world", updatedAt: "2026-04-02T00:00:00.000Z" }));

    const active = scanActiveFeatures(null);

    expect(active).toHaveLength(1);
    expect(active[0]?.featureSlug).toBe("2026-04-01-real-feature");
  });
});

// --- deleteStateFile ---

describe("deleteStateFile", () => {
  test("deletes the state file for a slug", () => {
    withTempCwd();
    const slug = "2026-05-08-test-feature";
    const state = createFeatureState(slug, "docs/featyard/designs/2026-05-08-test-feature-design.md");
    saveFeatureState(state, null);

    expect(loadFeatureState(slug, null)).not.toBeNull();

    deleteStateFile(slug, null);

    expect(loadFeatureState(slug, null)).toBeNull();
  });

  test("does not throw when file does not exist", () => {
    withTempCwd();
    expect(() => deleteStateFile("nonexistent", null)).not.toThrow();
  });
});

describe("worktreePath and sessionFiles fields", () => {
  test("createFeatureState includes worktreePath: null and sessionFiles: []", () => {
    withTempCwd();
    const state = createFeatureState("test-slug", "docs/featyard/designs/test-slug-design.md");
    expect(state.git.worktreePath).toBeNull();
    expect(state.sessionFiles).toEqual([]);
  });

  test("createFeatureStateFromPlan includes worktreePath: null and sessionFiles: []", () => {
    withTempCwd();
    const state = createFeatureStateFromPlan("test-slug", ".featyard/task-plans/test-slug-task-plan.md");
    expect(state.git.worktreePath).toBeNull();
    expect(state.sessionFiles).toEqual([]);
  });
});

describe("baseBranch field backward compat", () => {
  test("createFeatureState includes baseBranch: null", () => {
    withTempCwd();
    const state = createFeatureState("test-slug", "docs/featyard/designs/test-slug-design.md");
    expect(state.git.baseBranch).toBeNull();
  });

  test("createFeatureStateFromPlan includes baseBranch: null", () => {
    withTempCwd();
    const state = createFeatureStateFromPlan("test-slug", ".featyard/task-plans/test-slug-task-plan.md");
    expect(state.git.baseBranch).toBeNull();
  });
});

describe("baseCommitSha field", () => {
  test("is null in createFeatureState", () => {
    withTempCwd();
    const state = createFeatureState("2026-06-06-test", "docs/featyard/designs/2026-06-06-test-design.md");
    expect(state.git.baseCommitSha).toBeNull();
  });

  test("is null in createFeatureStateFromPlan", () => {
    withTempCwd();
    const state = createFeatureStateFromPlan("2026-06-06-test", ".featyard/task-plans/2026-06-06-test-task-plan.md");
    expect(state.git.baseCommitSha).toBeNull();
  });
});

describe("createFeatureStateForSubFeature", () => {
  test("creates state with design pending (not complete)", () => {
    const state = createFeatureStateForSubFeature(
      "2026-05-22-sub-feature",
      "docs/featyard/designs/2026-05-22-sub-feature-design.md",
    );

    expect(state.completedAt).toBeNull();
    expect(state.featureSlug).toBe("2026-05-22-sub-feature");
    expect(isPhasePending(view(state), "design")).toBe(true);
    expect(state.workflow.currentPhase).toBeNull();
    // Design doc is stored as design doc but design is NOT complete
    expect(state.design.doc).toBe("docs/featyard/designs/2026-05-22-sub-feature-design.md");
  });

  test("sets all other phases to pending", () => {
    const state = createFeatureStateForSubFeature("test-slug", "docs/test-design.md");

    expect(isPhasePending(view(state), "plan")).toBe(true);
    expect(isPhasePending(view(state), "implement")).toBe(true);
    expect(isPhasePending(view(state), "verify")).toBe(true);
    expect(isPhasePending(view(state), "review")).toBe(true);
    expect(isPhasePending(view(state), "uat")).toBe(true);
    expect(isPhasePending(view(state), "finish")).toBe(true);
  });

  test("sets featureId to null", () => {
    const state = createFeatureStateForSubFeature("test-slug", "docs/test-design.md");
    expect(state.featureId).toBeNull();
  });

  test("does not set design artifact when designDoc is empty", () => {
    const state = createFeatureStateForSubFeature("test-slug", "");
    expect(state.design.doc).toBeNull();
  });

  test("save/load round-trip preserves all fields", () => {
    const cwd = withTempCwd();

    const original = createFeatureStateForSubFeature("2026-05-22-roundtrip-sub", "");
    original.featureId = 42;
    original.plan.doc = ".featyard/task-plans/2026-05-22-roundtrip-sub-task-plan.md";
    saveFeatureState(original, null);

    const loaded = loadFeatureState("2026-05-22-roundtrip-sub", null);
    expect(loaded).not.toBeNull();
    expect(loaded?.featureSlug).toBe("2026-05-22-roundtrip-sub");
    expect(loaded?.completedAt).toBeNull();
    expect(loaded?.featureId).toBe(42);
    expect(loaded?.workflow.currentPhase).toBeNull();
    expect(isPhasePending(view(loaded as unknown as NonNullable<typeof loaded>), "design")).toBe(true);
    expect(isPhasePending(view(loaded as unknown as NonNullable<typeof loaded>), "plan")).toBe(true);
    expect(loaded?.design.doc).toBeNull();
    expect(loaded?.plan.doc).toBe(".featyard/task-plans/2026-05-22-roundtrip-sub-task-plan.md");
    // tdd/verification are session-only (GuardrailsState), no longer persisted to file.
    expect(loaded?.review.reviewLoopCount).toBe(0);

    process.chdir(ORIGINAL_CWD);
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  test("null results are cached for missing state files", () => {
    const cwd = withTempCwd();

    // First call — file doesn't exist, returns null
    const result1 = loadFeatureState("nonexistent-slug", null);
    expect(result1).toBeNull();

    // Verify null is cached by checking that a second call doesn't hit disk
    // (If null wasn't cached, fs.existsSync would be called again)
    const result2 = loadFeatureState("nonexistent-slug", null);
    expect(result2).toBeNull();

    // After clearing cache, still returns null
    clearFeatureStateCache();
    const result3 = loadFeatureState("nonexistent-slug", null);
    expect(result3).toBeNull();

    process.chdir(ORIGINAL_CWD);
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  test("cached null is invalidated after saveFeatureState", () => {
    const cwd = withTempCwd();

    // Prime cache with null
    const result1 = loadFeatureState("new-feature-slug", null);
    expect(result1).toBeNull();

    // Save state — should invalidate the null cache entry
    const state = createFeatureState("new-feature-slug", "");
    saveFeatureState(state, null);

    // Now load should return the saved state, not null
    const result2 = loadFeatureState("new-feature-slug", null);
    expect(result2).not.toBeNull();
    expect(result2?.featureSlug).toBe("new-feature-slug");

    process.chdir(ORIGINAL_CWD);
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });
});

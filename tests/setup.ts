// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Setup file for --no-isolate mode.
 *
 * Saves and restores globalThis and process.env state between test files
 * to prevent cross-file state leakage when test files share a worker process.
 */

// All known globalThis bridge objects used by the extensions
const BRIDGE_KEYS = [
  "__piWorkflowMonitor", // PiWorkflowMonitorBridge (8 props)
  "__piKanban", // PiKanbanBridge (10 props)
  "__piSettings", // PiSettingsBridge (4 props)
  "__piCtx", // PiCtx instance
  "__piCompactFollowUp", // CompactFollowUp stored message (transient)
  "__avtcPiFeatyardWired", // Idempotent wiring sentinel (extension entry guard)
] as const;

// Suppress flag removed (bug fix) — no longer in cleanup

// All known process.env keys used by the extensions
const ENV_KEYS = [
  "PI_FY_AUTO_AGENT",
  "PI_FY_EXECUTION_MODE",
  "PI_FY_FEATURE",
  "PI_FY_REVIEW_LOOP",
  "PI_FY_SETTINGS",
  "PI_FY_STAGE",
  // Subagent env vars — may be set when running inside a subagent worker
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_FORK_MODE",
  "PI_SUBAGENT_PARENT_PID",
  "PI_SUBAGENT_UI_BRIDGE_AUTH_TOKEN",
  "PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET",
  // featyard .featyard junction external-storage home override (set below to a temp dir
  // so tests never create junctions under the real ~/.pi/featyard/artifacts/)
  "PI_FY_HOME",
] as const;

const savedGlobals: Record<string, unknown> = {};
const savedEnv: Record<string, string | undefined> = {};
let savedCwd: string = "";

function saveState() {
  const gt = globalThis as unknown as Record<string, unknown>;
  for (const key of BRIDGE_KEYS) {
    savedGlobals[key] = key in gt ? gt[key] : undefined;
  }
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  savedCwd = process.cwd();
}

function restoreState() {
  const gt = globalThis as unknown as Record<string, unknown>;
  for (const key of BRIDGE_KEYS) {
    if (savedGlobals[key] === undefined) {
      delete gt[key];
    } else {
      gt[key] = savedGlobals[key];
    }
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  if (savedCwd) {
    process.chdir(savedCwd);
  }
}

// Save state before each test file, restore after
import { execSync as _realExecSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { _resetCompactGuard } from "../src/compaction/compact-trigger.js";
import { defaultGitRunner, setGitRunner } from "../src/git/git-queries.js";
import { _setExecSync, _setRmSync } from "../src/git/worktrees/worktree-lifecycle.js";
import { resetExtensionOverride } from "../src/guardrails/file-classifier.js";
import { _resetFeatureState } from "../src/index.js";
import { resetTodoIntegration } from "../src/integrations/todo-integration.js";
import { resetInstances } from "../src/kanban/kanban-bridge.js";
import { resetRateLimits } from "../src/kanban/kanban-server.js";
import { resetRefs } from "../src/shared/workflow-refs.js";
import { _resetPhaseReadyPassed } from "../src/tools/phase-ready.js";
import { resetSettingsState, setTestSettings } from "./helpers/settings-test-helpers.js";

// One temp "home" per worker: all .featyard junction external storage during tests lands here
// instead of the real ~/.pi/featyard/artifacts/. Created at module load (before saveState) so the
// whole test run isolates junction creation.
const TEST_FF_HOME = mkdtempSync(path.join(os.tmpdir(), "fy-home-"));
process.env.PI_FY_HOME = TEST_FF_HOME;

// NOTE: tests must NEVER mutate the real repo-root `.featyard`. Every extension-loading test chdir's
// into its own temp dir FIRST (see workflow-monitor/test-helpers.ts: createFakePi /
// createPiWithToolCapture / withTempCwd), so production init's `ensureFeatyardJunction(process.cwd())`
// operates on that temp — never the real repo. Do NOT heal/repair the real `.featyard` from here: that
// would repoint it (a real-repo mutation) even if restored afterward.

// Wire the canonical mock-DI settings holder globally (schema defaults) so every test reads
// settings through the holder — never the real handle (which only exists after extension
// activation). Tests override via setTestSettings({...}) / setSetting(K,V); resetSettingsState
// (afterAll) re-wires a fresh default holder between files.
setTestSettings(null);

beforeAll(() => {
  saveState();
  // Clear subagent env vars that may be set when running inside a subagent worker.
  // Tests expect a clean environment — these vars are only meaningful for actual
  // subagent child processes, not for test runners.
  delete process.env.PI_SUBAGENT_CHILD_AGENT;
  delete process.env.PI_SUBAGENT_PARENT_PID;
  delete process.env.PI_SUBAGENT_UI_BRIDGE_AUTH_TOKEN;
  delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
});

beforeEach(() => {
  // Clear the idempotent wiring sentinel before every test. Many tests re-invoke the
  // extension entry per test (and some twice within one test) expecting a fresh wiring;
  // without this reset the guard would make those re-invocations no-op. Each test must
  // start in the unwired state the existing suite assumes.
  delete (globalThis as Record<string, unknown>).__avtcPiFeatyardWired;
});

afterAll(() => {
  restoreState();
  // Reset injectable module state — every module-level mutable singleton that a
  // test file can mutate must be reset here, or it leaks into the next file in the
  // same worker (isolate:false shares modules across files).
  _resetFeatureState();
  resetRefs();
  resetInstances();
  resetTodoIntegration();
  resetExtensionOverride();
  resetRateLimits();
  _resetCompactGuard();
  _resetPhaseReadyPassed();
  // Restore injectable git/worktree seams (tests override via setGitRunner / mockExecSync).
  setGitRunner(defaultGitRunner);
  _setExecSync(_realExecSync);
  _setRmSync(null);
  // Reset the shared settings cache to defaults so a test file that mutated a
  // setting (e.g. planReviewMode) without its own afterEach cleanup cannot leak
  // the value into a later file in the same worker (isolate:false shares modules).
  resetSettingsState();
  // Clean up the test-only .featyard external-storage home
  try {
    rmSync(TEST_FF_HOME, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

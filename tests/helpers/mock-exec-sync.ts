// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Helper to mock git invocation for all modules that use an injectable seam.
 *
 * Call mockExecSync(vi.fn()) in beforeEach and restoreExecSync() in afterEach.
 *
 * Two seams are stubbed: worktree's execSync-shaped `_setExecSync` (command string +
 * options), and git-queries' runner-shaped `setGitRunner` ((args, cwd) => string).
 * The git-queries runner is bridged onto the same execSync-shaped mock by rebuilding
 * the command string ("git " + args.join(" ")), so a single mock dispatches both.
 */
import { execSync as _realExecSync } from "node:child_process";
import { defaultGitRunner, setGitRunner } from "../../src/git/git-queries.js";
import { _setExecSync as _setWorktreeExecSync } from "../../src/git/worktrees/worktree-lifecycle.js";

export function mockExecSync(mockFn: ReturnType<typeof import("vitest").vi.fn>): void {
  setGitRunner((args, cwd) => {
    const out = (mockFn as (cmd: string, opts: { cwd: string }) => string | null)(`git ${args.join(" ")}`, { cwd });
    return out == null ? "" : String(out);
  });
  _setWorktreeExecSync(mockFn as unknown as typeof _realExecSync);
}

export function restoreExecSync(): void {
  setGitRunner(defaultGitRunner);
  _setWorktreeExecSync(_realExecSync);
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Fast git repo initialization for tests.
 *
 * Creates a minimal `.git/` directory structure (HEAD, config, objects/, refs/)
 * without spawning `git init`. The resulting directory is recognized by git
 * commands like `git rev-parse --show-toplevel`.
 *
 * ~3ms per call vs ~50ms for `git init`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Creates a temp directory with a minimal `.git/` structure.
 * Returns the directory path (which is also the git toplevel).
 */
export function createGitRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initGitDir(dir);
  return dir;
}

/**
 * Writes a minimal `.git/` structure into an existing directory.
 * The directory must already exist.
 */
export function initGitDir(dir: string): void {
  const git = path.join(dir, ".git");
  fs.mkdirSync(path.join(git, "objects"), { recursive: true });
  fs.mkdirSync(path.join(git, "refs", "heads"), { recursive: true });
  fs.mkdirSync(path.join(git, "refs", "tags"), { recursive: true });
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(
    path.join(git, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n",
  );
}

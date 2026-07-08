// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../../log.js";
import type { KanbanDatabase } from "./kanban-database.js";

/**
 * Resolve the main repo path from the given cwd.
 * Handles worktrees by using git to find the main repo.
 * Encapsulates the dynamic import of node:child_process + node:util + worktree.js.
 */
export async function resolveRepoPath(cwd: string): Promise<string> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  const { resolveMainRepoPath } = await import("../../git/worktrees/worktree-lifecycle.js");
  const execFn: import("../../git/worktrees/worktree-lifecycle.js").ExecFn = async (cmd) => {
    const { stdout } = await execAsync(cmd, { cwd });
    return { exitCode: 0, stdout };
  };
  return resolveMainRepoPath(execFn);
}

/**
 * Detect the kanban project ID for the given working directory.
 * Resolves the main repo path (handles worktrees) and looks up the project.
 */
export async function detectProject(database: KanbanDatabase, cwd: string): Promise<number | null> {
  try {
    const repoPath = await resolveRepoPath(cwd);
    log.info(`[kanban] detectProject: cwd=${cwd}, resolved repoPath=${repoPath}`);
    const project = database.findProjectByRepoPath(repoPath);
    if (project) {
      log.info(`[kanban] detectProject: found project ${project.id} "${project.name}" for repoPath=${repoPath}`);
    } else {
      log.info(`[kanban] detectProject: no project found for repoPath=${repoPath}`);
    }
    return project?.id ?? null;
  } catch (err) {
    log.warn(`[kanban] detectProject failed (cwd=${cwd}): ${err}`);
    return null; // not a git repo or git not available
  }
}

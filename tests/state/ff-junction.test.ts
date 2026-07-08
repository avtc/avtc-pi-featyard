// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureFfJunction,
  mungeSessionKey,
  resolveArchiveBase,
  resolveProjectRootFs,
} from "../../src/state/artifact-junction.js";

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ffj-${prefix}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (TEMP_DIRS.length) {
    const dir = TEMP_DIRS.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

describe("mungeSessionKey", () => {
  test("replaces : \\ / with - and wraps with", () => {
    expect(mungeSessionKey("E:\\sync\\unique\\work\\git\\pi\\avtc-pi-feature-flow")).toBe(
      "--E--sync-unique-work-git-pi-avtc-pi-feature-flow--",
    );
  });

  test("matches the existing manual.ff target key (regression)", () => {
    // This is the exact key used when the .ff junction was set up manually for this repo.
    const key = mungeSessionKey(path.resolve("E:\\sync\\unique\\work\\git\\pi\\avtc-pi-feature-flow"));
    expect(key).toBe("--E--sync-unique-work-git-pi-avtc-pi-feature-flow--");
  });

  test("posix path", () => {
    expect(mungeSessionKey("/home/user/projects/app")).toBe("---home-user-projects-app--");
  });

  test("macOS path", () => {
    expect(mungeSessionKey("/Users/dev/code/widget")).toBe("---Users-dev-code-widget--");
  });
});

describe("resolveProjectRootFs", () => {
  test("returns the dir when.git is a directory (main worktree)", () => {
    const root = makeTempDir("main");
    mkdirSync(path.join(root, ".git"));
    expect(resolveProjectRootFs(root)).toBe(root);
  });

  test("walks up to find.git in a parent dir", () => {
    const root = makeTempDir("main");
    mkdirSync(path.join(root, ".git"));
    const nested = path.join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectRootFs(nested)).toBe(root);
  });

  test("parses a linked-worktree.git file back to the main repo root", () => {
    const main = makeTempDir("main");
    mkdirSync(path.join(main, ".git"));
    mkdirSync(path.join(main, ".git", "worktrees", "wt-1"), { recursive: true });
    const worktree = makeTempDir("worktree");
    // Linked worktree .git is a FILE: "gitdir: <abs>/main/.git/worktrees/<name>"
    const gitdirLine = path.join(main, ".git", "worktrees", "wt-1").replace(/\\/g, "/");
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitdirLine}\n`);

    expect(resolveProjectRootFs(worktree)).toBe(main.replace(/\\/g, "/"));
  });

  test("returns null when no.git is found walking up to fs root", () => {
    const isolated = makeTempDir("nogit");
    // mkdtemp dir has no .git and (in tmpdir) no ancestor .git
    // Guard against the unlikely case an ancestor has .git:
    const result = resolveProjectRootFs(isolated);
    // Either null (no ancestor .git) OR an ancestor root if tmpdir lives inside a git repo.
    // We only assert it does not falsely return the isolated dir itself as a git root
    // UNLESS there's genuinely a .git there (there isn't).
    if (result !== null) {
      // An ancestor had a .git — acceptable on some CI setups; just ensure it's not `isolated`.
      expect(result).not.toBe(isolated);
    }
  });
});

describe("resolveArchiveBase", () => {
  test("derives the archive base as a sibling artifacts-archive/<key> of externalDir", () => {
    // resolveArchiveBase computes <dirname(externalDir)>/artifacts-archive/<key> from a junction
    // result. Construct a synthetic EnsureFfJunctionResult (no real junction needed — the function
    // is a pure path derivation over externalDir + key).
    const jr = {
      externalDir: path.join(os.tmpdir(), "some-project--ff-external"),
      key: "some-project--key",
    } as unknown as Parameters<typeof resolveArchiveBase>[0];

    expect(resolveArchiveBase(jr)).toBe(path.join(os.tmpdir(), "artifacts-archive", "some-project--key"));
  });

  test("agrees with a real ensureFfJunction result (the production path)", () => {
    const root = makeTempDir("archive-base");
    const jr = ensureFfJunction(root, "current-branch", process.env.PI_FF_HOME ?? os.homedir(), "rename");

    // The archive base is the sibling artifacts-archive/<key> of the junction's externalDir.
    expect(resolveArchiveBase(jr)).toBe(path.join(path.dirname(jr.externalDir), "artifacts-archive", jr.key));
  });
});

describe("ensureFfJunction", () => {
  test("creates.ff junction + external subdirs for a git repo (worktrees off)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");

    const result = ensureFfJunction(cwd, "current-branch", home, "rename");

    expect(result.created).toBe(true);
    expect(result.rootSource).toBe("git");
    // .ff link exists
    expect(existsSync(path.join(cwd, ".ff"))).toBe(true);
    // external dir + subdirs exist
    expect(existsSync(result.externalDir)).toBe(true);
    expect(existsSync(path.join(result.externalDir, "task-plans"))).toBe(true);
    expect(existsSync(path.join(result.externalDir, "research"))).toBe(true);
    expect(existsSync(path.join(result.externalDir, "reviews"))).toBe(true);
    expect(existsSync(path.join(result.externalDir, "feature-state"))).toBe(true);
    // external dir lives under <home>/.pi/feature-flow/artifacts/<key>
    expect(result.externalDir.startsWith(path.join(home, ".pi", "feature-flow", "artifacts"))).toBe(true);
  });

  test("falls back to cwd key when not a git repo + worktrees off", () => {
    const cwd = makeTempDir("plain");
    const home = makeTempDir("home");

    const result = ensureFfJunction(cwd, "current-branch", home, "rename");

    expect(result.rootSource).toBe("cwd");
    expect(result.created).toBe(true);
    // Key derives from cwd (no .git), so .ff still created
    expect(existsSync(path.join(cwd, ".ff"))).toBe(true);
  });

  test("throws when worktree branchPolicy set but no.git found", () => {
    const cwd = makeTempDir("plain");
    const home = makeTempDir("home");

    expect(() => ensureFfJunction(cwd, "worktree", home, "rename")).toThrowError(
      /worktree.*requires a git repository/i,
    );
  });

  test("is idempotent — re-run reports created=false and leaves junction intact", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");

    const first = ensureFfJunction(cwd, "current-branch", home, "rename");
    expect(first.created).toBe(true);

    const second = ensureFfJunction(cwd, "current-branch", home, "rename");
    expect(second.created).toBe(false);
    expect(second.externalDir).toBe(first.externalDir);
    expect(existsSync(path.join(cwd, ".ff"))).toBe(true);
  });

  test("re-points a.ff link whose target differs to the correct external dir (does not clobber the foreign dir)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");
    const other = makeTempDir("other");
    const foreignMarker = path.join(other, "do-not-delete.md");
    writeFileSync(foreignMarker, "MUST SURVIVE");

    // Pre-create .ff pointing elsewhere (a real existing dir belonging to another project)
    const { symlinkSync } = require("node:fs");
    symlinkSync(other, path.join(cwd, ".ff"), process.platform === "win32" ? "junction" : "dir");

    const result = ensureFfJunction(cwd, "current-branch", home, "rename");

    // .ff re-pointed to the correct external dir; no throw; the foreign dir is untouched.
    expect(result.created).toBe(true);
    expect(path.resolve(readlinkSync(path.join(cwd, ".ff")))).toBe(path.resolve(result.externalDir));
    expect(existsSync(foreignMarker)).toBe(true);
  });

  test("heals a plain real-directory.ff: RENAMES it to a backup by default (preserves contents)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");
    // Simulate a stray real-directory .ff (e.g. someone copied the repo without the junction).
    mkdirSync(path.join(cwd, ".ff", "reviews"), { recursive: true });
    writeFileSync(path.join(cwd, ".ff", "reviews", "stray.md"), "must survive");

    const result = ensureFfJunction(cwd, "current-branch", home, "rename");

    // Default mode ("rename"): the stray dir is moved aside, a junction is created, and the
    // original content survives on disk at .ff.pre-junction-<ts> for manual recovery.
    expect(result.created).toBe(true);
    expect(path.resolve(readlinkSync(path.join(cwd, ".ff")))).toBe(path.resolve(result.externalDir));
    const entries = readdirSync(cwd);
    const backup = entries.find((e) => e.startsWith(".ff.pre-junction-"));
    if (!backup) throw new Error("expected a .ff.pre-junction- backup dir to exist");
    expect(existsSync(path.join(cwd, backup, "reviews", "stray.md"))).toBe(true);
  });

  test("heals a plain real-directory.ff: DELETES it when onRealDir is 'delete' (worktree checkout)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");
    // Simulate a git-checked-out .ff: a REAL directory with files (content also in git/external).
    mkdirSync(path.join(cwd, ".ff", "reviews"), { recursive: true });
    writeFileSync(path.join(cwd, ".ff", "reviews", "stray.md"), "checked-out duplicate");

    const result = ensureFfJunction(cwd, "current-branch", home, "delete");

    // Delete mode: real dir removed (no backup), junction created.
    expect(result.created).toBe(true);
    expect(path.resolve(readlinkSync(path.join(cwd, ".ff")))).toBe(path.resolve(result.externalDir));
    expect(existsSync(result.externalDir)).toBe(true);
    const entries = readdirSync(cwd);
    expect(entries.some((e) => e.startsWith(".ff.pre-junction-"))).toBe(false);
  });

  test("heals a stale.ff junction whose target no longer exists (re-points to current external dir)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");

    // Pre-create .ff pointing at a path that does NOT exist (stale junction, e.g. after a path-scheme migration).
    const { symlinkSync } = require("node:fs");
    const staleTarget = path.join(makeTempDir("gone-parent"), "missing");
    symlinkSync(staleTarget, path.join(cwd, ".ff"), process.platform === "win32" ? "junction" : "dir");

    const result = ensureFfJunction(cwd, "current-branch", home, "rename");

    // Junction re-pointed to the live external dir; no throw.
    expect(result.created).toBe(true);
    expect(path.resolve(readlinkSync(path.join(cwd, ".ff")))).toBe(path.resolve(result.externalDir));
    expect(existsSync(result.externalDir)).toBe(true);
  });

  test("aggregates a linked worktree to the SAME external key as the main repo", () => {
    const main = makeTempDir("main");
    mkdirSync(path.join(main, ".git"));
    mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    const worktree = makeTempDir("wt");
    const gitdirLine = path.join(main, ".git", "worktrees", "wt").replace(/\\/g, "/");
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitdirLine}\n`);
    const home = makeTempDir("home");

    const mainResult = ensureFfJunction(main, "worktree", home, "rename");
    const wtResult = ensureFfJunction(worktree, "worktree", home, "rename");

    // Both resolve to the same external dir + key — artifacts aggregate across worktrees.
    expect(wtResult.key).toBe(mainResult.key);
    expect(wtResult.externalDir).toBe(mainResult.externalDir);
  });

  test("junction resolves to the external dir (real link, not just existsSync)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");

    const result = ensureFfJunction(cwd, "current-branch", home, "rename");

    const target = readlinkSync(path.join(cwd, ".ff"));
    // readlinkSync returns the target path (native separators); normalize for compare
    expect(path.resolve(target)).toBe(path.resolve(result.externalDir));
  });

  describe("local ignore (.git/info/exclude)", () => {
    // The junction is ignored via the clone-local `.git/info/exclude`, never the shared
    // `.gitignore`, so contributing to other authors' repos leaves their tracked files pristine.
    // These tests use a fake empty `.git` dir, which makes `git rev-parse --git-common-dir` fail
    // (exit 128) and so exercises the fs fallback that also covers the "git binary absent" case.

    test("writes.ff to .git/info/exclude for a git repo (creates info/exclude if absent)", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      const home = makeTempDir("home");

      ensureFfJunction(cwd, "current-branch", home, "rename");

      const exclude = path.join(cwd, ".git", "info", "exclude");
      expect(existsSync(exclude)).toBe(true);
      const lines = readFileSync(exclude, "utf-8").split(/\r?\n/);
      // Written as `.ff` (no trailing slash) so the junction/symlink is reliably ignored.
      expect(lines).toContain(".ff");
      // Must NOT emit the legacy trailing-slash form.
      expect(lines).not.toContain(".ff/");
      // Must NOT touch the shared, tracked `.gitignore`.
      expect(existsSync(path.join(cwd, ".gitignore"))).toBe(false);
    });

    test("does NOT duplicate.ff on re-run (idempotent)", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      const home = makeTempDir("home");

      ensureFfJunction(cwd, "current-branch", home, "rename");
      ensureFfJunction(cwd, "current-branch", home, "rename");

      const content = readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
      const count = content.split(/\r?\n/).filter((l) => l.trim() === ".ff").length;
      expect(count).toBe(1);
    });

    test("preserves existing info/exclude content when appending", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      // Pre-create an info/exclude with some content.
      mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
      writeFileSync(path.join(cwd, ".git", "info", "exclude"), "*.log\n.DS_Store\n");
      const home = makeTempDir("home");

      ensureFfJunction(cwd, "current-branch", home, "rename");

      const content = readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
      expect(content).toContain("*.log");
      expect(content).toContain(".DS_Store");
      expect(content).toContain(".ff");
    });

    test("does not re-append when legacy.ff/ (trailing slash) already present", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
      writeFileSync(path.join(cwd, ".git", "info", "exclude"), "*.log\n.ff/\n");
      const home = makeTempDir("home");

      ensureFfJunction(cwd, "current-branch", home, "rename");

      const content = readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
      // Content unchanged — the legacy `.ff/` line counts as already-ignored (no duplicate `.ff`).
      expect(content).toBe("*.log\n.ff/\n");
      const dotff = content.split(/\r?\n/).filter((l) => l.trim() === ".ff").length;
      expect(dotff).toBe(0);
    });

    test("does not re-append when.ff (no slash) already present", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
      writeFileSync(path.join(cwd, ".git", "info", "exclude"), "*.log\n.ff\n");
      const home = makeTempDir("home");

      ensureFfJunction(cwd, "current-branch", home, "rename");

      const content = readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
      // Content unchanged — `.ff` was already there.
      expect(content).toBe("*.log\n.ff\n");
    });

    test("does NOT create/modify info/exclude or .gitignore when not a git repo", () => {
      const cwd = makeTempDir("plain");
      const home = makeTempDir("home");

      ensureFfJunction(cwd, "current-branch", home, "rename");

      // No .git → not a git repo → nothing ignored
      expect(existsSync(path.join(cwd, ".git", "info", "exclude"))).toBe(false);
      expect(existsSync(path.join(cwd, ".gitignore"))).toBe(false);
    });

    test("appends.ff to the EXISTING info/exclude in a real git repo (git rev-parse path)", () => {
      // Unlike the fake-empty-.git tests above, this uses a REAL `git init`, so
      // `git rev-parse --git-common-dir` succeeds and exercises the primary branch of
      // resolveCommonGitDir (path.resolve + existsSync) — the fs-fallback-only path otherwise
      // has zero coverage. git init also ships a default info/exclude (commented), covering the
      // existing-file branch.
      const cwd = makeTempDir("realgit");
      execSync("git init -q", { cwd });
      const home = makeTempDir("home");

      ensureFfJunction(cwd, "current-branch", home, "rename");

      const exclude = path.join(cwd, ".git", "info", "exclude");
      expect(existsSync(exclude)).toBe(true);
      const content = readFileSync(exclude, "utf-8");
      expect(content).toContain(".ff");
      // The shared, tracked .gitignore stays untouched.
      expect(existsSync(path.join(cwd, ".gitignore"))).toBe(false);
    });
  });
});

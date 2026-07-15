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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureFeatyardJunction,
  mungeSessionKey,
  resolveArchiveBase,
  resolveProjectRootFs,
} from "../../src/state/artifact-junction.js";

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `featyardj-${prefix}-`));
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
    expect(mungeSessionKey("E:\\sync\\unique\\work\\git\\pi\\avtc-pi-featyard")).toBe(
      "--E--sync-unique-work-git-pi-avtc-pi-featyard--",
    );
  });

  test("matches the existing manual.featyard target key (regression)", () => {
    // This is the exact key used when the .featyard junction was set up manually for this repo.
    const key = mungeSessionKey(path.resolve("E:\\sync\\unique\\work\\git\\pi\\avtc-pi-featyard"));
    expect(key).toBe("--E--sync-unique-work-git-pi-avtc-pi-featyard--");
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
    // result. Construct a synthetic EnsureFeatyardJunctionResult (no real junction needed — the function
    // is a pure path derivation over externalDir + key).
    const jr = {
      externalDir: path.join(os.tmpdir(), "some-project--fy-external"),
      key: "some-project--key",
    } as unknown as Parameters<typeof resolveArchiveBase>[0];

    expect(resolveArchiveBase(jr)).toBe(path.join(os.tmpdir(), "artifacts-archive", "some-project--key"));
  });

  test("agrees with a real ensureFeatyardJunction result (the production path)", () => {
    const root = makeTempDir("archive-base");
    const jr = ensureFeatyardJunction(root, "current-branch", process.env.PI_FY_HOME ?? os.homedir(), "rename");

    // The archive base is the sibling artifacts-archive/<key> of the junction's externalDir.
    expect(resolveArchiveBase(jr)).toBe(path.join(path.dirname(jr.externalDir), "artifacts-archive", jr.key));
  });
});

describe("ensureFeatyardJunction", () => {
  test("creates.featyard junction + external dir for a git repo (worktrees off)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");

    const result = ensureFeatyardJunction(cwd, "current-branch", home, "rename");

    expect(result.created).toBe(true);
    expect(result.rootSource).toBe("git");
    // .featyard link exists
    expect(existsSync(path.join(cwd, ".featyard"))).toBe(true);
    // external dir exists (but standard subdirs are NOT pre-created — created lazily by writers)
    expect(existsSync(result.externalDir)).toBe(true);
    expect(existsSync(path.join(result.externalDir, "task-plans"))).toBe(false);
    expect(existsSync(path.join(result.externalDir, "research"))).toBe(false);
    expect(existsSync(path.join(result.externalDir, "reviews"))).toBe(false);
    expect(existsSync(path.join(result.externalDir, "feature-state"))).toBe(false);
    // external dir lives under <home>/.pi/featyard/artifacts/<key>
    expect(result.externalDir.startsWith(path.join(home, ".pi", "featyard", "artifacts"))).toBe(true);
  });

  test("falls back to cwd key when not a git repo + worktrees off", () => {
    const cwd = makeTempDir("plain");
    const home = makeTempDir("home");

    const result = ensureFeatyardJunction(cwd, "current-branch", home, "rename");

    expect(result.rootSource).toBe("cwd");
    expect(result.created).toBe(true);
    // Key derives from cwd (no .git), so .featyard still created
    expect(existsSync(path.join(cwd, ".featyard"))).toBe(true);
  });

  test("throws when worktree branchPolicy set but no.git found", () => {
    const cwd = makeTempDir("plain");
    const home = makeTempDir("home");

    expect(() => ensureFeatyardJunction(cwd, "worktree", home, "rename")).toThrowError(
      /worktree.*requires a git repository/i,
    );
  });

  test("is idempotent — re-run reports created=false and leaves junction intact", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");

    const first = ensureFeatyardJunction(cwd, "current-branch", home, "rename");
    expect(first.created).toBe(true);

    const second = ensureFeatyardJunction(cwd, "current-branch", home, "rename");
    expect(second.created).toBe(false);
    expect(second.externalDir).toBe(first.externalDir);
    expect(existsSync(path.join(cwd, ".featyard"))).toBe(true);
  });

  test("re-points a.featyard link whose target differs to the correct external dir (does not clobber the foreign dir)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");
    const other = makeTempDir("other");
    const foreignMarker = path.join(other, "do-not-delete.md");
    writeFileSync(foreignMarker, "MUST SURVIVE");

    // Pre-create .featyard pointing elsewhere (a real existing dir belonging to another project)
    const { symlinkSync } = require("node:fs");
    symlinkSync(other, path.join(cwd, ".featyard"), process.platform === "win32" ? "junction" : "dir");

    const result = ensureFeatyardJunction(cwd, "current-branch", home, "rename");

    // .featyard re-pointed to the correct external dir; no throw; the foreign dir is untouched.
    expect(result.created).toBe(true);
    expect(path.resolve(readlinkSync(path.join(cwd, ".featyard")))).toBe(path.resolve(result.externalDir));
    expect(existsSync(foreignMarker)).toBe(true);
  });

  test("heals a plain real-directory.fy: RENAMES it to a backup by default (preserves contents)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");
    // Simulate a stray real-directory .featyard (e.g. someone copied the repo without the junction).
    mkdirSync(path.join(cwd, ".featyard", "reviews"), { recursive: true });
    writeFileSync(path.join(cwd, ".featyard", "reviews", "stray.md"), "must survive");

    const result = ensureFeatyardJunction(cwd, "current-branch", home, "rename");

    // Default mode ("rename"): the stray dir is moved aside, a junction is created, and the
    // original content survives on disk at .featyard.pre-junction-<ts> for manual recovery.
    expect(result.created).toBe(true);
    expect(path.resolve(readlinkSync(path.join(cwd, ".featyard")))).toBe(path.resolve(result.externalDir));
    const entries = readdirSync(cwd);
    const backup = entries.find((e) => e.startsWith(".featyard.pre-junction-"));
    if (!backup) throw new Error("expected a .featyard.pre-junction- backup dir to exist");
    expect(existsSync(path.join(cwd, backup, "reviews", "stray.md"))).toBe(true);
  });

  test("heals a plain real-directory.fy: DELETES it when onRealDir is 'delete' (worktree checkout)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");
    // Simulate a git-checked-out .fy: a REAL directory with files (content also in git/external).
    mkdirSync(path.join(cwd, ".featyard", "reviews"), { recursive: true });
    writeFileSync(path.join(cwd, ".featyard", "reviews", "stray.md"), "checked-out duplicate");

    const result = ensureFeatyardJunction(cwd, "current-branch", home, "delete");

    // Delete mode: real dir removed (no backup), junction created.
    expect(result.created).toBe(true);
    expect(path.resolve(readlinkSync(path.join(cwd, ".featyard")))).toBe(path.resolve(result.externalDir));
    expect(existsSync(result.externalDir)).toBe(true);
    const entries = readdirSync(cwd);
    expect(entries.some((e) => e.startsWith(".featyard.pre-junction-"))).toBe(false);
  });

  test("heals a stale.featyard junction whose target no longer exists (re-points to current external dir)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");

    // Pre-create .featyard pointing at a path that does NOT exist (stale junction, e.g. after a path-scheme migration).
    const { symlinkSync } = require("node:fs");
    const staleTarget = path.join(makeTempDir("gone-parent"), "missing");
    symlinkSync(staleTarget, path.join(cwd, ".featyard"), process.platform === "win32" ? "junction" : "dir");

    const result = ensureFeatyardJunction(cwd, "current-branch", home, "rename");

    // Junction re-pointed to the live external dir; no throw.
    expect(result.created).toBe(true);
    expect(path.resolve(readlinkSync(path.join(cwd, ".featyard")))).toBe(path.resolve(result.externalDir));
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

    const mainResult = ensureFeatyardJunction(main, "worktree", home, "rename");
    const wtResult = ensureFeatyardJunction(worktree, "worktree", home, "rename");

    // Both resolve to the same external dir + key — artifacts aggregate across worktrees.
    expect(wtResult.key).toBe(mainResult.key);
    expect(wtResult.externalDir).toBe(mainResult.externalDir);
  });

  test("junction resolves to the external dir (real link, not just existsSync)", () => {
    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");

    const result = ensureFeatyardJunction(cwd, "current-branch", home, "rename");

    const target = readlinkSync(path.join(cwd, ".featyard"));
    // readlinkSync returns the target path (native separators); normalize for compare
    expect(path.resolve(target)).toBe(path.resolve(result.externalDir));
  });

  describe("local ignore (.git/info/exclude)", () => {
    // The junction is ignored via the clone-local `.git/info/exclude`, never the shared
    // `.gitignore`, so contributing to other authors' repos leaves their tracked files pristine.
    // These tests use a fake empty `.git` dir, which makes `git rev-parse --git-common-dir` fail
    // (exit 128) and so exercises the fs fallback that also covers the "git binary absent" case.

    test("writes.featyard to .git/info/exclude for a git repo (creates info/exclude if absent)", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      const home = makeTempDir("home");

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      const exclude = path.join(cwd, ".git", "info", "exclude");
      expect(existsSync(exclude)).toBe(true);
      const lines = readFileSync(exclude, "utf-8").split(/\r?\n/);
      // Written as `.featyard` (no trailing slash) so the junction/symlink is reliably ignored.
      expect(lines).toContain(".featyard");
      // Must NOT emit the legacy trailing-slash form.
      expect(lines).not.toContain(".featyard/");
      // Must NOT touch the shared, tracked `.gitignore`.
      expect(existsSync(path.join(cwd, ".gitignore"))).toBe(false);
    });

    test("does NOT duplicate.featyard on re-run (idempotent)", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      const home = makeTempDir("home");

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");
      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      const content = readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
      const count = content.split(/\r?\n/).filter((l) => l.trim() === ".featyard").length;
      expect(count).toBe(1);
    });

    test("preserves existing info/exclude content when appending", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      // Pre-create an info/exclude with some content.
      mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
      writeFileSync(path.join(cwd, ".git", "info", "exclude"), "*.log\n.DS_Store\n");
      const home = makeTempDir("home");

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      const content = readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
      expect(content).toContain("*.log");
      expect(content).toContain(".DS_Store");
      expect(content).toContain(".featyard");
    });

    test("does not re-append when legacy.featyard/ (trailing slash) already present", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
      writeFileSync(path.join(cwd, ".git", "info", "exclude"), "*.log\n.featyard/\n");
      const home = makeTempDir("home");

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      const content = readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
      // Content unchanged — the legacy `.featyard/` line counts as already-ignored (no duplicate `.featyard`).
      expect(content).toBe("*.log\n.featyard/\n");
      const dotfeatyard = content.split(/\r?\n/).filter((l) => l.trim() === ".featyard").length;
      expect(dotfeatyard).toBe(0);
    });

    test("does not re-append when.featyard (no slash) already present", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
      writeFileSync(path.join(cwd, ".git", "info", "exclude"), "*.log\n.featyard\n");
      const home = makeTempDir("home");

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      const content = readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
      // Content unchanged — `.featyard` was already there.
      expect(content).toBe("*.log\n.featyard\n");
    });

    test("does NOT create/modify info/exclude or .gitignore when not a git repo", () => {
      const cwd = makeTempDir("plain");
      const home = makeTempDir("home");

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      // No .git → not a git repo → nothing ignored
      expect(existsSync(path.join(cwd, ".git", "info", "exclude"))).toBe(false);
      expect(existsSync(path.join(cwd, ".gitignore"))).toBe(false);
    });

    test("appends.featyard to the EXISTING info/exclude in a real git repo (git rev-parse path)", () => {
      // Unlike the fake-empty-.git tests above, this uses a REAL `git init`, so
      // `git rev-parse --git-common-dir` succeeds and exercises the primary branch of
      // resolveCommonGitDir (path.resolve + existsSync) — the fs-fallback-only path otherwise
      // has zero coverage. git init also ships a default info/exclude (commented), covering the
      // existing-file branch.
      const cwd = makeTempDir("realgit");
      execSync("git init -q", { cwd });
      const home = makeTempDir("home");

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      const exclude = path.join(cwd, ".git", "info", "exclude");
      expect(existsSync(exclude)).toBe(true);
      const content = readFileSync(exclude, "utf-8");
      expect(content).toContain(".featyard");
      // The shared, tracked .gitignore stays untouched.
      expect(existsSync(path.join(cwd, ".gitignore"))).toBe(false);
    });

    test("strips the legacy feature-flow .ff block from info/exclude while keeping .featyard", () => {
      const cwd = makeTempDir("realgit");
      execSync("git init -q", { cwd });
      const home = makeTempDir("home");
      const exclude = path.join(cwd, ".git", "info", "exclude");
      mkdirSync(path.dirname(exclude), { recursive: true });
      // Seed BOTH the legacy feature-flow block AND a user line, but NO .featyard yet.
      writeFileSync(
        exclude,
        "/some-user-pattern\n\n# feature-flow artifact junction (external storage)\n.ff\n",
        "utf-8",
      );

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      const content = readFileSync(exclude, "utf-8");
      // Legacy block removed, .featyard added, user line preserved.
      expect(content).not.toContain("feature-flow");
      expect(content).not.toMatch(/^\.ff\/?$/m);
      expect(content).toContain(".featyard");
      expect(content).toContain("/some-user-pattern");
    });
  });

  describe("feature-flow -> featyard migration", () => {
    test("renames the legacy ~/.pi/feature-flow base to ~/.pi/featyard (preserving artifacts)", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      const home = makeTempDir("home");
      const key = mungeSessionKey(path.resolve(cwd));

      // Seed the LEGACY base with an artifact for this project's key.
      const legacyFile = path.join(home, ".pi", "feature-flow", "artifacts", key, "reviews", "old.md");
      mkdirSync(path.dirname(legacyFile), { recursive: true });
      writeFileSync(legacyFile, "survives migration");

      const result = ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      // Base migrated: featyard exists, feature-flow is gone.
      expect(existsSync(path.join(home, ".pi", "featyard"))).toBe(true);
      expect(existsSync(path.join(home, ".pi", "feature-flow"))).toBe(false);
      // The seeded artifact survives under the new base + is reachable via .featyard.
      expect(existsSync(path.join(result.externalDir, "reviews", "old.md"))).toBe(true);
      expect(readFileSync(path.join(result.externalDir, "reviews", "old.md"), "utf-8")).toBe("survives migration");
    });

    test("is idempotent: a second run with an existing ~/.pi/featyard is a no-op", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      const home = makeTempDir("home");
      mkdirSync(path.join(home, ".pi", "featyard"), { recursive: true });
      writeFileSync(path.join(home, ".pi", "featyard", "sentinel"), "keep");

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      // Pre-existing featyard base is left untouched (no feature-flow to migrate).
      expect(readFileSync(path.join(home, ".pi", "featyard", "sentinel"), "utf-8")).toBe("keep");
    });

    test("removes a legacy .ff junction (stale link) and supersedes it with .featyard", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      const home = makeTempDir("home");
      // Seed a stale legacy .ff junction pointing at an old/absent target.
      symlinkSync(path.join(home, ".pi", "feature-flow", "artifacts", "stale"), path.join(cwd, ".ff"), "junction");

      ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      expect(existsSync(path.join(cwd, ".ff"))).toBe(false);
      expect(existsSync(path.join(cwd, ".featyard"))).toBe(true);
    });

    test("merges a legacy real .ff directory into external storage then removes it (no data loss)", () => {
      const cwd = makeTempDir("proj");
      mkdirSync(path.join(cwd, ".git"));
      const home = makeTempDir("home");
      // Seed a REAL .ff dir with artifacts (the in-repo fallback case).
      const reviewFile = path.join(cwd, ".ff", "reviews", "stray.md");
      mkdirSync(path.dirname(reviewFile), { recursive: true });
      writeFileSync(reviewFile, "merged content");

      const result = ensureFeatyardJunction(cwd, "current-branch", home, "rename");

      // .ff gone; its content now lives under external storage, reachable via .featyard.
      expect(existsSync(path.join(cwd, ".ff"))).toBe(false);
      expect(existsSync(path.join(cwd, ".featyard"))).toBe(true);
      expect(existsSync(path.join(result.externalDir, "reviews", "stray.md"))).toBe(true);
      expect(readFileSync(path.join(result.externalDir, "reviews", "stray.md"), "utf-8")).toBe("merged content");
    });
  });
});

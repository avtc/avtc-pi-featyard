// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * : the only remaining fatal throw in ensureFeatyardJunction is the rmSync catch (when an existing
 * .featyard entry cannot be removed for re-pointing). All other healing tests use real rmSync, which
 * always succeeds on Windows (read-only dirs do NOT block rmSync). This dedicated file mocks
 * rmSync to throw and asserts the error.
 *
 * vi.mock (hoisted) does NOT propagate to fy-junction's static `rmSync` binding here because
 * setup.ts pre-loads fy-junction into the file's module registry with the REAL node:fs. So we use
 * the documented dynamic-import pattern: vi.resetModules to drop the cached fy-junction, then
 * vi.doMock("node:fs") (non-hoisted) to replace rmSync BEFORE re-importing fy-junction, so the
 * module re-evaluates against the mocked rmSync. Temp dirs live under os.tmpdir and are tiny.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";

async function loadWithThrowingRmSync() {
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = (await importOriginal()) as typeof import("node:fs");
    return {
      ...actual,
      rmSync: vi.fn(() => {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }),
    };
  });
  const { ensureFeatyardJunction } = await import("../../src/state/artifact-junction.js");
  const { rmSync } = await import("node:fs");
  return { ensureFeatyardJunction, rmSync };
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `featyardj-rmf-${prefix}-`));
}

describe("ensureFeatyardJunction rmSync-failure throw", () => {
  test("throws the re-point error when an existing real-directory.featyard cannot be removed", async () => {
    const { ensureFeatyardJunction, rmSync } = await loadWithThrowingRmSync();

    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");
    mkdirSync(path.join(cwd, ".featyard")); // real dir → with onRealDir:"delete", healing calls rmSync(recursive) → throws

    expect(() => ensureFeatyardJunction(cwd, "current-branch", home, "delete")).toThrowError(
      /could not be removed for re-pointing/,
    );

    expect(vi.mocked(rmSync)).toHaveBeenCalled();
  });

  test("throws even for a wrong-target link whose removal fails", async () => {
    const { ensureFeatyardJunction } = await loadWithThrowingRmSync();

    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");
    const other = makeTempDir("other");
    // link → healing calls rmSync (non-recursive) → throws
    symlinkSync(other, path.join(cwd, ".featyard"), process.platform === "win32" ? "junction" : "dir");

    expect(() => ensureFeatyardJunction(cwd, "current-branch", home, "rename")).toThrowError(
      /could not be removed for re-pointing/,
    );
  });

  test("does NOT call rmSync when.featyard is already correctly linked (idempotent no-op)", async () => {
    const { ensureFeatyardJunction, rmSync } = await loadWithThrowingRmSync();

    const cwd = makeTempDir("proj");
    mkdirSync(path.join(cwd, ".git"));
    const home = makeTempDir("home");

    // First call creates the correct junction (nothing pre-exists → rmSync not called).
    const first = ensureFeatyardJunction(cwd, "current-branch", home, "rename");
    expect(first.created).toBe(true);

    // Second call: already correct → no-op, rmSync never called.
    vi.mocked(rmSync).mockClear();
    const second = ensureFeatyardJunction(cwd, "current-branch", home, "rename");
    expect(second.created).toBe(false);
    expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
  });
});

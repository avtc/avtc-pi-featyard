// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildArchiveSweepOptions } from "../../src/index.js";
import { _setGetSettings, getSettings } from "../../src/settings/settings-ui.js";
import { resolveDesignsDirs } from "../../src/state/artifact-junction.js";
import { defaultSettings, resetSettingsState } from "../helpers/settings-test-helpers.js";

/**
 * Wiring regression (review loop 3): the background-archive sweep must read its threshold
 * from the `autoArchiveArtifactsOlderThanDays` SETTING (not a hardcoded constant). The on-start
 * sweep dispatch is gated off in the test sandbox and the 24h timer never fires in tests, so the
 * `sweepOpts`→`maxAgeDays` connection is otherwise unexercised. `buildArchiveSweepOptions` is
 * the exported seam the sweep closure delegates to — proving it reads the setting proves the wiring
 * (a regression hardcoding/mistyping the threshold fails here).
 */
describe("background archive sweep — setting → threshold wiring", () => {
  test("buildArchiveSweepOptions reads autoArchiveArtifactsOlderThanDays from settings", () => {
    resetSettingsState();
    // Default is 30.
    expect(getSettings().autoArchiveArtifactsOlderThanDays).toBe(30);
    expect(buildArchiveSweepOptions("/tmp/ext", "/tmp/archive").maxAgeDays).toBe(30);

    // Edit the setting (mirrors the settings-UI modal path) by injecting an override.
    _setGetSettings(() => defaultSettings({ autoArchiveArtifactsOlderThanDays: 90 }));

    // The sweep options now carry the edited threshold — proving activation connects them.
    const opts = buildArchiveSweepOptions("/tmp/ext", "/tmp/archive");
    expect(opts.maxAgeDays).toBe(90);
    // The non-threshold fields pass through unchanged.
    expect(opts.externalDir).toBe("/tmp/ext");
    expect(opts.archiveBase).toBe("/tmp/archive");
  });

  test("buildArchiveSweepOptions reflects a mid-session setting change at call time (re-reads each call)", () => {
    resetSettingsState();
    expect(buildArchiveSweepOptions("a", "b").maxAgeDays).toBe(30);

    _setGetSettings(() => defaultSettings({ autoArchiveArtifactsOlderThanDays: 14 }));

    // Each call re-reads (the sweep fires every 24h and must see the latest setting).
    expect(buildArchiveSweepOptions("a", "b").maxAgeDays).toBe(14);
  });
});

describe("background design-doc archive sweep — gating + roots", () => {
  test("autoArchiveDesignsOlderThanDays defaults to null (design sweep OFF by default)", () => {
    resetSettingsState();
    // The background sweep gates on `!= null`; the default must be null so the sweep never fires
    // unless the user explicitly opts in. (A regression defaulting this to a number would silently
    // relocate design docs — including in-repo committed ones — out from under the user.)
    expect(getSettings().autoArchiveDesignsOlderThanDays).toBeNull();
  });

  test("an edited non-null threshold is visible to reads (the sweep closure reads it per-fire)", () => {
    resetSettingsState();
    _setGetSettings(() => defaultSettings({ autoArchiveDesignsOlderThanDays: 90 }));
    expect(getSettings().autoArchiveDesignsOlderThanDays).toBe(90);
  });

  test("resolveDesignsDirs returns BOTH roots the background sweep scans", () => {
    // The shared helper drives both the manual command and the background sweep — it must return
    // the out-of-repo (.featyard/designs via externalDir) AND in-repo (docs/featyard/designs) roots so docs from
    // either mode age out together. Uses path.join so the assertion is platform-agnostic.
    const dirs = resolveDesignsDirs(path.join("/", "tmp", "ext"), path.join("/", "repo"));
    expect(dirs).toEqual([
      path.join("/", "tmp", "ext", "designs"),
      path.join("/", "repo", "docs", "featyard", "designs"),
    ]);
  });
});

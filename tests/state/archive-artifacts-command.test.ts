// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { ensureFeatyardJunction, resolveArchiveBase } from "../../src/state/artifact-junction.js";
import {
  cleanupAfterTest,
  createFakePi,
  makeFeatureState,
  setupPiCtx,
  TUI_MODE,
} from "../helpers/workflow-monitor-test-helpers.js";

const DAY = 24 * 60 * 60;

/** Write a file and backdate its mtime (seconds since epoch). */
function writeFile(p: string, content: string, mtimeSec: number): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  utimesSync(p, mtimeSec, mtimeSec);
}

/** A ctx with notify + confirm spies. confirmResult controls what the confirm gate returns. */
function makeCtx(opts: { hasUI?: boolean; confirmResult?: boolean } = {}) {
  const notifications: [string, string][] = [];
  let confirmResult = opts.confirmResult ?? true;
  const confirmCalls: { title: string; message: string }[] = [];
  const ui = {
    setEditorText: () => {},
    notify: (message: string, level: string) => notifications.push([message, level]),
    select: async () => undefined,
    setWidget: () => {},
    confirm: async (title: string, message: string) => {
      confirmCalls.push({ title, message });
      return confirmResult;
    },
  };
  const ctx: ExtensionContext & { notifications: [string, string][]; confirmCalls: typeof confirmCalls } = {
    hasUI: opts.hasUI ?? true,
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    ui,
    actions: {},
    notifications,
    confirmCalls,
  } as unknown as ExtensionContext & { notifications: [string, string][]; confirmCalls: typeof confirmCalls };
  // stash helpers on the object for assertions
  Object.assign(ctx, {
    notifications,
    confirmCalls,
    setConfirmResult: (v: boolean) => {
      confirmResult = v;
    },
  });
  return ctx;
}

/** Resolve the live externalDir + archiveBase for the current test sandbox. */
function resolveArchivePaths() {
  const jr = ensureFeatyardJunction(process.cwd(), "current-branch", process.env.PI_FY_HOME ?? os.homedir(), "rename");
  const externalDir = jr.externalDir;
  const archiveBase = resolveArchiveBase(jr);
  return { externalDir, archiveBase };
}

/** Seed a stale slug artifact (reviews/<slug>/ backdated 40 days). Returns the file path. */
function seedStaleSlug(externalDir: string, slug: string, ageDays: number): string {
  const p = path.join(externalDir, "reviews", slug, `${slug}-review.md`);
  writeFile(p, "stale review", Math.floor(Date.now() / 1000) - ageDays * DAY);
  return p;
}

/** Seed a stale bare-date (date-fallback) artifact: reviews/<date>/ backdated 40 days. */
function seedStaleDateFallback(externalDir: string, date: string, ageDays: number): string {
  const p = path.join(externalDir, "reviews", date, `${date}-review.md`);
  writeFile(p, "stale date-fallback", Math.floor(Date.now() / 1000) - ageDays * DAY);
  return p;
}

describe("fy:archive-artifacts <days> command", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    // Reset the active feature set by the days=0 test so it doesn't leak to later tests,
    // and clean up the bridge timer + globals the activation started.
    const handler = (
      globalThis as { __piWorkflowMonitor?: { handler?: { setActiveFeatureState: (s: unknown) => void } } }
    ).__piWorkflowMonitor?.handler;
    handler?.setActiveFeatureState(null);
    cleanupAfterTest();
    process.chdir(originalCwd);
  });

  /** Activate the extension and return the /fy:archive-artifacts handler. */
  async function setup() {
    const fake = createFakePi();
    // Await the activation so a rejection surfaces as a clean test failure (not an unhandled
    // rejection), and so the command/handler are fully wired before extraction.
    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    setupPiCtx(
      {
        setEditorText: () => {},
        notify: () => {},
        select: async () => undefined,
        setWidget: () => {},
        confirm: async () => true,
      },
      TUI_MODE,
    );
    const def = fake.registeredCommands.get("fy:archive-artifacts");
    if (typeof def !== "function") throw new Error("fy:archive-artifacts command not registered");
    const handler = def as (args: string, ctx: ExtensionContext) => Promise<void>;
    return { fake, handler };
  }

  test("missing param → error notify (usage), no confirm", async () => {
    const { handler } = await setup();
    const ctx = makeCtx();
    await handler("", ctx);
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0][1]).toBe("error");
    expect(ctx.notifications[0][0]).toMatch(/Usage: \/fy:archive-artifacts <days>/i);
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  test("non-numeric param → error notify (usage)", async () => {
    const { handler } = await setup();
    const ctx = makeCtx();
    await handler("abc", ctx);
    expect(ctx.notifications[0][1]).toBe("error");
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  test("negative param → error notify (usage), no confirm (days < 0 branch)", async () => {
    const { handler } = await setup();
    const ctx = makeCtx();
    // parseInt("-7") is a valid int (not NaN); only the `days < 0` guard rejects it.
    await handler("-7", ctx);
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0][1]).toBe("error");
    expect(ctx.notifications[0][0]).toMatch(/Usage: \/fy:archive-artifacts <days>/i);
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  test("empty result → 'Nothing to archive' notify, NO confirm gate", async () => {
    const { handler } = await setup();
    const ctx = makeCtx();
    // No artifacts seeded → enumerate yields nothing stale within 7 days.
    await handler("7", ctx);
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0][0]).toMatch(/nothing to archive/i);
    expect(ctx.notifications[0][1]).toBe("info");
    expect(ctx.confirmCalls).toHaveLength(0); // empty short-circuits BEFORE the gate
  });

  test("non-empty + confirm accepted → archives the stale artifacts", async () => {
    const { handler } = await setup();
    const { externalDir, archiveBase } = resolveArchivePaths();
    const slug = "2025-01-01-stale-feature";
    const src = seedStaleSlug(externalDir, slug, 40);

    const ctx = makeCtx({ confirmResult: true });
    await handler("7", ctx);

    // Confirm gate fired with a disruption warning.
    expect(ctx.confirmCalls).toHaveLength(1);
    // The confirm MESSAGE pluralizes by member + group counts. This seed = 1 member across 1
    // group, so the SINGULAR form must appear (pin the `?: "": "s"` message branches).
    expect(ctx.confirmCalls[0].message).toMatch(/relocates 1 artifact across 1 group/i);
    expect(ctx.confirmCalls[0].message).not.toMatch(/1 artifacts/i);
    expect(ctx.confirmCalls[0].message).not.toMatch(/1 groups/i);
    // Source moved into the archive; no longer at the live path.
    expect(existsSync(src)).toBe(false);
    // The move renames reviews/<slug>/ (dir) → archiveBase/reviews/<slug>/ (tree-mirror), so the
    // file lands at archiveBase/reviews/<slug>/<slug>-review.md (no inner slug dir at the top).
    expect(existsSync(path.join(archiveBase, "reviews", slug, `${slug}-review.md`))).toBe(true);
    // Success notify with a count.
    const ok = ctx.notifications.find((n) => n[1] === "info" || n[1] === "success");
    expect(ok).toBeTruthy();
    expect(ok ? ok[0] : "").toMatch(/archiv/i);
  });

  test("confirm message pluralizes 'artifacts'/'groups' when multiple members across multiple groups", async () => {
    // 2 slugs (2 members, 2 groups) → PLURAL form (pin the `?: "": "s"` message branches).
    const { handler } = await setup();
    const { externalDir } = resolveArchivePaths();
    seedStaleSlug(externalDir, "2025-01-01-stale-one", 40);
    seedStaleSlug(externalDir, "2025-01-01-stale-two", 40);

    const ctx = makeCtx({ confirmResult: false }); // decline — just checking the message
    await handler("7", ctx);

    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.confirmCalls[0].message).toMatch(/relocates 2 artifacts across 2 groups/i);
  });

  test("confirm title singularizes 'day' when days === 1 (no trailing 's')", async () => {
    // Pins the `days === 1 ? "": "s"` singularization in the confirm title (workflow-commands.ts).
    const { handler } = await setup();
    const { externalDir } = resolveArchivePaths();
    seedStaleSlug(externalDir, "2025-01-01-stale-feature", 40);

    const ctx = makeCtx({ confirmResult: true });
    await handler("1", ctx);

    expect(ctx.confirmCalls).toHaveLength(1);
    const title = ctx.confirmCalls[0].title;
    expect(title).toMatch(/older than 1 day\?/i);
    expect(title).not.toMatch(/1 days/i);
  });

  test("confirm declined → no changes (source stays in place, cancel notify)", async () => {
    const { handler } = await setup();
    const { externalDir } = resolveArchivePaths();
    const slug = "2025-01-01-declined-feature";
    const src = seedStaleSlug(externalDir, slug, 40);

    const ctx = makeCtx({ confirmResult: false });
    await handler("7", ctx);

    expect(ctx.confirmCalls).toHaveLength(1);
    expect(existsSync(src)).toBe(true); // untouched
    // The cancel notify fired (and named no changes).
    const cancel = ctx.notifications.find((n) => /cancel/i.test(n[0]));
    expect(cancel).toBeTruthy();
    expect(cancel ? cancel[0] : "").toMatch(/no changes/i);
  });

  test("days=0 does NOT archive the active feature (excludeSlug protection)", async () => {
    const { handler } = await setup();
    const { externalDir } = resolveArchivePaths();
    const slug = "2025-01-01-active-feature";
    // Make this feature the ACTIVE one so the command excludes it (excludeSlug).
    const wmHandler = (
      globalThis as {
        __piWorkflowMonitor?: {
          handler?: { setActiveFeatureState: (s: unknown) => void; getActiveFeatureSlug: () => string | null };
        };
      }
    ).__piWorkflowMonitor?.handler;
    wmHandler?.setActiveFeatureState(makeFeatureState(slug, {}));
    expect(wmHandler?.getActiveFeatureSlug()).toBe(slug);
    // Seed a stale artifact for the active slug (would be stale at days=0 except it's active).
    seedStaleSlug(externalDir, slug, 40);

    const ctx = makeCtx();
    await handler("0", ctx);

    // Active feature excluded → empty result → "Nothing to archive" (no confirm).
    expect(ctx.confirmCalls).toHaveLength(0);
    const nothing = ctx.notifications.find((n) => /nothing to archive/i.test(n[0]));
    expect(nothing).toBeTruthy();
  });

  test("!ctx.hasUI → aborts with a notify (no confirm)", async () => {
    const { handler } = await setup();
    const { externalDir } = resolveArchivePaths();
    const slug = "2025-01-01-headless-feature";
    seedStaleSlug(externalDir, slug, 40);

    const ctx = makeCtx({ hasUI: false });
    await handler("7", ctx);

    // Headless: cannot confirm → notify + abort, nothing archived.
    expect(ctx.confirmCalls).toHaveLength(0);
    const abort = ctx.notifications.find((n) => /interactive|confirm/i.test(n[0]));
    expect(abort).toBeTruthy();
  });

  test("in-flight (active) slugs are listed in the confirm message when present", async () => {
    const { handler } = await setup();
    const { externalDir } = resolveArchivePaths();
    // An abandoned slug: stale artifacts (40 days) AND a non-completed state file (also backdated
    // 40 days so the group's newest mtime is old → stale). scanActiveFeatures still lists it as
    // in-flight (completedAt == null), so the confirm warning names it.
    const staleSlug = "2025-01-01-inflight-stale";
    seedStaleSlug(externalDir, staleSlug, 40);
    const stateDirPath = path.join(externalDir, "feature-state");
    mkdirSync(stateDirPath, { recursive: true });
    writeFile(
      path.join(stateDirPath, `${staleSlug}.json`),
      JSON.stringify({
        featureSlug: staleSlug,
        updatedAt: "2025-01-01T00:00:00.000Z",
        workflow: { currentPhase: "implement" },
      }),
      Math.floor(Date.now() / 1000) - 40 * DAY,
    );

    const ctx = makeCtx({ confirmResult: true });
    await handler("7", ctx);

    expect(ctx.confirmCalls).toHaveLength(1);
    // The in-flight slug is named in the warning message.
    expect(ctx.confirmCalls[0].message).toContain(staleSlug);
  });

  test("group-breakdown notify: one slug + zero date-fallbacks (singular slug, plural date-fallbacks)", async () => {
    const { handler } = await setup();
    const { externalDir } = resolveArchivePaths();
    // Exactly ONE stale slug (no date-fallbacks).
    const slug = "2025-01-01-lone";
    seedStaleSlug(externalDir, slug, 40);

    const ctx = makeCtx({ confirmResult: true });
    await handler("7", ctx);

    const ok = ctx.notifications.find(([, level]) => level === "info");
    expect(ok).toBeTruthy();
    // 1 slug group (singular) + 0 date-fallback groups (plural). Pins the group-breakdown report.
    expect(ok ? ok[0] : "").toMatch(/Archived 1 slug \+ 0 date-fallbacks\./);
  });

  test("group-breakdown notify: zero slugs + one date-fallback (plural slugs, singular date-fallback)", async () => {
    const { handler } = await setup();
    const { externalDir } = resolveArchivePaths();
    // Exactly ONE stale date-fallback (no slug groups).
    seedStaleDateFallback(externalDir, "2025-01-15", 40);

    const ctx = makeCtx({ confirmResult: true });
    await handler("7", ctx);

    const ok = ctx.notifications.find(([, level]) => level === "info");
    expect(ok).toBeTruthy();
    // 0 slug groups (plural) + 1 date-fallback group (singular). Pins the date-fallback singular
    // branch (`date-fallback${count === 1 ? "": "s"}`) — mirrors the slug-branch pinning.
    expect(ok ? ok[0] : "").toMatch(/Archived 0 slugs \+ 1 date-fallback\./);
    expect(ok ? ok[0] : "").not.toMatch(/1 date-fallbacks/i);
  });

  test("reports partial failure: success notify appends an error count when a move fails (errors branch)", async () => {
    const { handler } = await setup();
    const { externalDir, archiveBase } = resolveArchivePaths();
    const blocked = "2025-01-01-move-fails";
    // A stale artifact that will be enumerated + confirmed.
    seedStaleSlug(externalDir, blocked, 40);
    // Sabotage this slug's archive dest: under the tree-mirror archive, reviews/<blocked>/ routes
    // to archiveBase/reviews/<blocked>/. Make archiveBase/reviews a FILE so the
    // mkdirSync(dest parent) step fails (ENOTDIR) → moveArtifact returns {ok:false} → errors[].
    mkdirSync(archiveBase, { recursive: true });
    writeFileSync(path.join(archiveBase, "reviews"), "blocker");

    const ctx = makeCtx({ confirmResult: true });
    await handler("7", ctx);

    // Confirm gate still fired (there WAS something to archive).
    expect(ctx.confirmCalls).toHaveLength(1);
    // The success notify carries the partial-failure suffix. Exactly 1 member was seeded and its
    // move failed, so the singular form ("1 error", no "s") must appear — pinning the
    // `errors.length === 1 ? "": "s"` singularization branch.
    const ok = ctx.notifications.find(([, level]) => level === "info");
    expect(ok).toBeTruthy();
    expect(ok ? ok[0] : "").toMatch(/\(1 error /i);
    expect(ok ? ok[0] : "").not.toMatch(/1 errors/i);
    expect(ok ? ok[0] : "").toMatch(/see log/i);
    // The failed group is NOT reported as archived (group-success tracking: all-or-nothing unit).
    expect(ok ? ok[0] : "").toMatch(/Archived 0 slugs \+ 0 date-fallbacks/);
    // The blocked source remains (move failed).
    expect(existsSync(path.join(externalDir, "reviews", blocked))).toBe(true);
  });
});

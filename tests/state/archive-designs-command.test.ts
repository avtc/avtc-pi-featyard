// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import workflowMonitorExtension from "../../src/index.js";
import { ensureFfJunction, resolveArchiveBase } from "../../src/state/artifact-junction.js";
import { cleanupAfterTest, createFakePi, setupPiCtx, TUI_MODE } from "../helpers/workflow-monitor-test-helpers.js";

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
  const confirmResult = opts.confirmResult ?? true;
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
  const ctx = {
    hasUI: opts.hasUI ?? true,
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    ui,
    actions: {},
  } as unknown as ExtensionContext & { notifications: [string, string][]; confirmCalls: typeof confirmCalls };
  Object.assign(ctx, { notifications, confirmCalls });
  return ctx;
}

/** Resolve the live externalDir + archiveBase + the two design-doc roots for the current sandbox. */
function resolveDesignsPaths() {
  const jr = ensureFfJunction(process.cwd(), "current-branch", process.env.PI_FF_HOME ?? os.homedir(), "rename");
  const externalDir = jr.externalDir;
  const archiveBase = resolveArchiveBase(jr);
  // .ff/designs (out-of-repo via junction) + docs/ff/designs (in-repo).
  const localDesignsDir = path.join(externalDir, "designs");
  const committedDesignsDir = path.join(process.cwd(), "docs", "ff", "designs");
  return { externalDir, archiveBase, localDesignsDir, committedDesignsDir };
}

/** Seed a stale design doc in a dir, backdated `ageDays`. Returns the file path. */
function seedStaleDesign(dir: string, slug: string, ageDays: number): string {
  const p = path.join(dir, `${slug}-design.md`);
  writeFile(p, `# ${slug}`, Math.floor(Date.now() / 1000) - ageDays * DAY);
  return p;
}

describe("ff:archive-designs <days> command", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    cleanupAfterTest();
    process.chdir(originalCwd);
  });

  /** Activate the extension and return the /ff:archive-designs handler. */
  async function setup() {
    const fake = createFakePi();
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
    const def = fake.registeredCommands.get("ff:archive-designs");
    if (typeof def !== "function") throw new Error("ff:archive-designs command not registered");
    const handler = def as (args: string, ctx: ExtensionContext) => Promise<void>;
    return { fake, handler };
  }

  test("missing param → error notify (usage), no confirm", async () => {
    const { handler } = await setup();
    const ctx = makeCtx();
    await handler("", ctx);
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0][1]).toBe("error");
    expect(ctx.notifications[0][0]).toMatch(/Usage: \/ff:archive-designs <days>/i);
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  test("non-numeric param → error notify (usage)", async () => {
    const { handler } = await setup();
    const ctx = makeCtx();
    await handler("abc", ctx);
    expect(ctx.notifications[0][1]).toBe("error");
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  test("negative param → error notify (usage), no confirm", async () => {
    const { handler } = await setup();
    const ctx = makeCtx();
    await handler("-7", ctx);
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0][1]).toBe("error");
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  test("empty result → 'Nothing to archive' notify, NO confirm gate", async () => {
    const { handler } = await setup();
    const ctx = makeCtx();
    await handler("7", ctx);
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0][0]).toMatch(/nothing to archive/i);
    expect(ctx.notifications[0][1]).toBe("info");
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  test("non-empty + confirm accepted → archives stale docs from BOTH roots", async () => {
    const { handler } = await setup();
    const { archiveBase, localDesignsDir, committedDesignsDir } = resolveDesignsPaths();
    const localSrc = seedStaleDesign(localDesignsDir, "2025-01-01-local", 40);
    const committedSrc = seedStaleDesign(committedDesignsDir, "2025-01-01-committed", 40);

    const ctx = makeCtx({ confirmResult: true });
    await handler("7", ctx);

    // Confirm fired with the two-source message (singular for one doc each invocation — here 2 docs).
    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.confirmCalls[0].message).toMatch(/relocates 2 design docs from \.ff\/designs and docs\/ff\/designs/i);
    expect(ctx.confirmCalls[0].message).toMatch(/reversible by moving them back/i);
    // Sources moved into the archive; no longer at the live paths.
    expect(existsSync(localSrc)).toBe(false);
    expect(existsSync(committedSrc)).toBe(false);
    expect(existsSync(path.join(archiveBase, "designs", "2025-01-01-local-design.md"))).toBe(true);
    expect(existsSync(path.join(archiveBase, "designs", "2025-01-01-committed-design.md"))).toBe(true);
    // Report notify.
    const report = ctx.notifications.find((n) => n[0].match(/archived 2 design docs/i));
    expect(report).toBeDefined();
    expect(report?.[1]).toBe("info");
  });

  test("confirm cancelled → no changes made", async () => {
    const { handler } = await setup();
    const { localDesignsDir } = resolveDesignsPaths();
    const src = seedStaleDesign(localDesignsDir, "2025-01-01-cancel", 40);

    const ctx = makeCtx({ confirmResult: false });
    await handler("7", ctx);

    expect(existsSync(src)).toBe(true); // untouched
    const cancelled = ctx.notifications.find((n) => n[0].match(/archive cancelled/i));
    expect(cancelled).toBeDefined();
  });

  test("fresh design doc is NOT archived (mtime threshold respected)", async () => {
    const { handler } = await setup();
    const { localDesignsDir } = resolveDesignsPaths();
    // 1 day old → threshold 7 days → fresh, kept.
    const src = seedStaleDesign(localDesignsDir, "2025-01-01-fresh", 1);

    const ctx = makeCtx({ confirmResult: true });
    await handler("7", ctx);

    expect(existsSync(src)).toBe(true); // untouched
    expect(ctx.notifications.some((n) => n[0].match(/nothing to archive/i))).toBe(true);
  });
});

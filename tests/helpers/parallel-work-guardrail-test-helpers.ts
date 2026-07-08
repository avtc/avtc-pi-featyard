// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import { _setGetSettings } from "../../src/settings/settings-ui.js";
import { defaultSettings } from "./settings-test-helpers.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

// ── Fake PI ────────────────────────────────────────────────────────────────────

export function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    api: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
      events: {
        on() {
          return () => {};
        },
        off() {},
        emit() {},
      },
      registerTool() {},
      registerCommand() {},
    } as unknown as ExtensionAPI,
  };
}

/** Get the first handler registered for an event. */
export function getFirstHandler(handlers: Map<string, Handler[]>, event: string): Handler {
  const list = handlers.get(event) ?? [];
  expect(list.length).toBeGreaterThan(0);
  const first = list[0];
  if (!first) throw new Error(`no handler registered for ${event}`);
  return first;
}

// ── Settings ───────────────────────────────────────────────────────────────────

export function resetSettings() {
  _setGetSettings(() => defaultSettings(null));
}

export function setSettings(settings: Record<string, unknown>) {
  _setGetSettings(() => defaultSettings(settings as Partial<Parameters<typeof defaultSettings>[0]>));
}

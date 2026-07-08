// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Safely set the editor text if it's currently empty.
 * If editor has content, shows an info notification instead.
 */
export function safeSetEditorText(text: string, notifyMsg: string | null): void {
  const guard = globalThis.__piCtx;
  const ui = guard?.ui;
  if (!ui?.setEditorText) return;
  const existing = ui.getEditorText?.();
  if (!existing?.trim()) {
    ui.setEditorText(text);
  } else if (notifyMsg) {
    ui.notify(notifyMsg, "info");
  }
}

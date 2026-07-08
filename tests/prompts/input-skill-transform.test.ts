// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import workflowMonitorExtension, { _resetFeatureState } from "../../src/index.js";
import {
  cleanupAfterTest,
  createPiWithToolCapture,
  fireAllHandlers,
  getSingleHandler,
  NO_UI_CTX,
} from "../helpers/workflow-monitor-test-helpers.js";

/**
 * Tests that the input handler takes over expansion of our own `/skill:` commands
 * by returning `{ action: "transform" }` with an already-expanded `<skill>` block.
 *
 * Rationale: pi's _expandSkillCommand would otherwise wrap our skills with a generic
 * "References are relative to <skillDir>" line — misleading for our skills, which
 * reference project-root paths (docs/, .ff/), never skill-relative ones. By
 * transforming to the already-expanded block, pi's _expandSkillCommand and
 * expandPromptTemplate become no-ops (text no longer starts with "/").
 *
 * Uses NO_UI_CTX (hasUI:false) so the input handler reaches proceed() directly.
 */
describe("input handler: transforms our skills to avoid pi's misleading relative-reference line", () => {
  afterEach(async () => {
    _resetFeatureState();
    cleanupAfterTest();
  });

  test("transforms /skill:ff-design-review into <skill> block without 'References are relative to'", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const onInput = getSingleHandler(fake.handlers, "input");
    const result = await onInput(
      { text: "/skill:ff-design-review", source: "interactive" } as unknown as ExtensionEvent,
      NO_UI_CTX,
    );

    expect(result).toEqual({
      action: "transform",
      text: expect.stringMatching(/^<skill name="ff-design-review" location="[^"]+">/),
    });
    const text = (result as { text: string }).text;
    expect(text).toContain("</skill>");
    // The whole point: pi's generic relative-reference line must NOT appear.
    expect(text).not.toContain("References are relative to");
    // Placeholders are substituted during expansion. Assert a placeholder
    // actually RESOLVED to a concrete value (not merely disappeared). With no
    // feature state in the interactive input path, DESIGN_DOC_PATH falls back to
    // its template form, proving real substitution happened here.
    expect(text).not.toContain("{{PI_FF_DESIGN_DOC_PATH}}");
    expect(text).toContain("YYYY-MM-DD-<topic>");
  });

  test("transform applies to all our skills, not just phase-mapped ones", async () => {
    // ff-verify / ff-review / ff-finish all resolve from our skills/ dir.
    for (const skill of ["ff-verify", "ff-review", "ff-finish"]) {
      const { fake, api } = createPiWithToolCapture();
      delete (globalThis as Record<string, unknown>).__avtcPiFeatureFlowWired;
      await workflowMonitorExtension(api as unknown as ExtensionAPI);
      await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

      const onInput = getSingleHandler(fake.handlers, "input");
      const result = await onInput(
        { text: `/skill:${skill}`, source: "interactive" } as unknown as ExtensionEvent,
        NO_UI_CTX,
      );

      expect(result).toBeDefined();
      expect((result as { action?: string })?.action).toBe("transform");
      const text = (result as { text: string }).text;
      expect(text.startsWith(`<skill name="${skill}" `)).toBe(true);
      expect(text).not.toContain("References are relative to");
    }
  });

  test("appends args after the <skill> block", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const onInput = getSingleHandler(fake.handlers, "input");
    const result = await onInput(
      { text: "/skill:ff-design-review some-context-arg", source: "interactive" } as unknown as ExtensionEvent,
      NO_UI_CTX,
    );

    const text = (result as { text: string }).text;
    expect(text).toContain("</skill>\n\nsome-context-arg");
  });

  test("does not transform plain (non-skill) input — lets pi process normally", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const onInput = getSingleHandler(fake.handlers, "input");
    const result = await onInput(
      { text: "hello world", source: "interactive" } as unknown as ExtensionEvent,
      NO_UI_CTX,
    );

    // undefined === "continue" action → pi processes the input as-is
    expect(result).toBeUndefined();
  });

  test("does not transform unknown skills — lets pi resolve them", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const onInput = getSingleHandler(fake.handlers, "input");
    const result = await onInput(
      { text: "/skill:nonexistent-skill-xyz", source: "interactive" } as unknown as ExtensionEvent,
      NO_UI_CTX,
    );

    // expandSkillCommand returns the original text for unknown skills → not a transform
    expect(result).toBeUndefined();
  });

  test("extension-source input is skipped entirely (recursion guard)", async () => {
    const { fake, api } = createPiWithToolCapture();
    await workflowMonitorExtension(api as unknown as ExtensionAPI);
    await fireAllHandlers(fake.handlers, "session_start", { reason: "new" }, NO_UI_CTX);

    const onInput = getSingleHandler(fake.handlers, "input");
    // source: "extension" is what sendUserMessage uses — must not re-enter/transform.
    const result = await onInput(
      { text: "/skill:ff-design-review", source: "extension" } as unknown as ExtensionEvent,
      NO_UI_CTX,
    );

    expect(result).toBeUndefined();
  });
});

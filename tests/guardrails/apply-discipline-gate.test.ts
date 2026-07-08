// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { applyDisciplineGate, type DisciplineGateOpts } from "../../src/guardrails/guardrail-violations.js";

describe("applyDisciplineGate", () => {
  const baseOpts = (
    overrides: Partial<DisciplineGateOpts>,
  ): DisciplineGateOpts & { pendingMap: Map<string, string> } => {
    const pendingMap = new Map<string, string>();
    return {
      discipline: "strict",
      blockReason: "blocked: test violation",
      warning: "warning: test violation",
      pendingMap,
      toolCallId: "call-123",
      ...overrides,
    };
  };

  describe("strict mode", () => {
    it("always hard-blocks (identical regardless of session kind)", () => {
      const opts = baseOpts({ discipline: "strict" });
      const result = applyDisciplineGate(opts);
      expect(result).toEqual({ block: true, reason: "blocked: test violation" });
    });

    it("does not store in pendingMap when blocking", () => {
      const opts = baseOpts({ discipline: "strict" });
      applyDisciplineGate(opts);
      expect(opts.pendingMap.size).toBe(0);
    });
  });

  describe("advisory mode", () => {
    it("stores warning in pendingMap and returns null", () => {
      const opts = baseOpts({ discipline: "advisory" });
      const result = applyDisciplineGate(opts);
      expect(result).toBeNull();
      expect(opts.pendingMap.get("call-123")).toBe("warning: test violation");
    });

    it("uses toolCallId as pendingMap key", () => {
      const opts = baseOpts({ discipline: "advisory", toolCallId: "call-xyz" });
      applyDisciplineGate(opts);
      expect(opts.pendingMap.has("call-xyz")).toBe(true);
    });
  });

  describe("off mode", () => {
    it("returns null and does not store in pendingMap", () => {
      const opts = baseOpts({ discipline: "off" });
      const result = applyDisciplineGate(opts);
      expect(result).toBeNull();
      expect(opts.pendingMap.size).toBe(0);
    });
  });
});

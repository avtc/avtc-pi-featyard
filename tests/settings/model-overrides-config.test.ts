// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  invalidateConfigCacheIfChanged,
  loadFeatyardConfig,
  resetFeatyardConfig,
} from "../../src/settings/settings-ui.js";
import { resetSettingsState } from "../helpers/settings-test-helpers.js";

describe("FeatyardConfig loading", () => {
  let tmpDir: string;
  let globalDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-config-test-"));
    globalDir = path.join(tmpDir, "global");
    fs.mkdirSync(path.join(globalDir, "agent"), { recursive: true });
    // Clear cached config so each test loads fresh
    resetFeatyardConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGlobalSettingsJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(globalDir, "agent", "settings.json"), JSON.stringify(data, null, 2));
  }

  test("returns empty config when no featyard key in settings.json", async () => {
    writeGlobalSettingsJson({ defaultProvider: "test-provider" });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config).toEqual({
      "stage-models": {},
      "default-model": null,
      "kanban-port": null,
      "source-extensions": null,
    });
  });

  test("loads stage-models from settings.json", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": {
          review: ["test-provider/model-a", "test-provider/model-b"],
        },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toEqual(["test-provider/model-a", "test-provider/model-b"]);
  });

  test("handles missing settings.json gracefully", async () => {
    // Don't write any file
    const config = loadFeatyardConfig(globalDir, null);
    expect(config).toEqual({
      "stage-models": {},
      "default-model": null,
      "kanban-port": null,
      "source-extensions": null,
    });
  });

  test("handles malformed featyard key gracefully", async () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": "not-an-object" });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config).toEqual({
      "stage-models": {},
      "default-model": null,
      "kanban-port": null,
      "source-extensions": null,
    });
  });

  test("caches config in globalThis after first load", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "test-provider/model-b" },
      },
    });
    const config1 = loadFeatyardConfig(globalDir, null);
    // Delete the file — should still return cached result
    fs.unlinkSync(path.join(globalDir, "agent", "settings.json"));
    const config2 = loadFeatyardConfig(globalDir, null);
    expect(config1).toEqual(config2);
  });
});

describe("FeatyardConfig project-level loading", () => {
  let tmpDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-config-test-"));
    globalDir = path.join(tmpDir, "global");
    projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(globalDir, "agent"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    resetFeatyardConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGlobalSettingsJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(globalDir, "agent", "settings.json"), JSON.stringify(data, null, 2));
  }

  function writeProjectSettingsJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), JSON.stringify(data, null, 2));
  }

  test("reads project-level settings.json and merges with global", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "anthropic/claude-sonnet-4-5" },
      },
    });
    writeProjectSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { design: "openai/gpt-4o" },
      },
    });

    const config = loadFeatyardConfig(globalDir, projectDir);

    // Both global and project stage-models should be present
    expect(config["stage-models"]?.review).toEqual("anthropic/claude-sonnet-4-5");
    expect(config["stage-models"]?.design).toEqual("openai/gpt-4o");
  });

  test("project-level overrides global for same key", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "anthropic/claude-sonnet-4-5" },
      },
    });
    writeProjectSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "openai/gpt-4o" },
      },
    });

    const config = loadFeatyardConfig(globalDir, projectDir);

    // Project should override global for the same key
    expect(config["stage-models"]?.review).toEqual("openai/gpt-4o");
  });

  test("works with only project-level config, no global", async () => {
    // No global file
    writeProjectSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "deepseek/deepseek-chat" },
      },
    });

    const config = loadFeatyardConfig(globalDir, projectDir);

    expect(config["stage-models"]?.review).toEqual("deepseek/deepseek-chat");
  });

  test("returns global-only config when project has no featyard key", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "anthropic/claude-sonnet-4-5" },
      },
    });
    writeProjectSettingsJson({ defaultProvider: "openai" });

    const config = loadFeatyardConfig(globalDir, projectDir);

    expect(config["stage-models"]?.review).toEqual("anthropic/claude-sonnet-4-5");
  });

  test("handles missing project.pi directory gracefully", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "anthropic/claude-sonnet-4-5" },
      },
    });
    // projectDir exists but has no .pi subdirectory

    const config = loadFeatyardConfig(globalDir, projectDir);

    expect(config["stage-models"]?.review).toEqual("anthropic/claude-sonnet-4-5");
  });
});

describe("loadFeatyardConfig cache reset", () => {
  let tmpDir: string;
  let globalDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-cache-test-"));
    globalDir = path.join(tmpDir, "global");
    fs.mkdirSync(path.join(globalDir, "agent"), { recursive: true });
    resetFeatyardConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGlobalSettingsJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(globalDir, "agent", "settings.json"), JSON.stringify(data, null, 2));
  }

  test("resetFeatyardConfig clears cache so next load reads fresh data", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "anthropic/claude-sonnet-4-5" },
      },
    });

    // First load caches the config
    const config1 = loadFeatyardConfig(globalDir, null);
    expect(config1["stage-models"]?.review).toEqual("anthropic/claude-sonnet-4-5");

    // Update the file on disk
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "openai/gpt-4o" },
      },
    });

    // Without reset, cached config is returned
    const config2 = loadFeatyardConfig(globalDir, null);
    expect(config2["stage-models"]?.review).toEqual("anthropic/claude-sonnet-4-5");

    // Reset and reload
    resetFeatyardConfig();
    const config3 = loadFeatyardConfig(globalDir, null);
    expect(config3["stage-models"]?.review).toEqual("openai/gpt-4o");
  });

  test("resetFeatyardConfig allows recovery from initial load failure", async () => {
    // First load: malformed file
    writeGlobalSettingsJson({ "avtc-pi-featyard": "not-an-object" });

    const config1 = loadFeatyardConfig(globalDir, null);
    expect(config1).toEqual({
      "stage-models": {},
      "default-model": null,
      "kanban-port": null,
      "source-extensions": null,
    });

    // Fix the file on disk
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "anthropic/claude-sonnet-4-5" },
      },
    });

    // Without reset, empty config is still cached
    const config2 = loadFeatyardConfig(globalDir, null);
    expect(config2).toEqual({
      "stage-models": {},
      "default-model": null,
      "kanban-port": null,
      "source-extensions": null,
    });

    // After reset, new data is loaded
    resetFeatyardConfig();
    const config3 = loadFeatyardConfig(globalDir, null);
    expect(config3["stage-models"]?.review).toEqual("anthropic/claude-sonnet-4-5");
  });
});

describe("ModelOverride shape validation", () => {
  let tmpDir: string;
  let globalDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-validation-test-"));
    globalDir = path.join(tmpDir, "global");
    fs.mkdirSync(path.join(globalDir, "agent"), { recursive: true });
    resetFeatyardConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGlobalSettingsJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(globalDir, "agent", "settings.json"), JSON.stringify(data, null, 2));
  }

  test("skips malformed string entry and logs warning", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "not-a-model" },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    // Malformed entry (no / separator) should be skipped
    expect(config["stage-models"]?.review).toBeUndefined();
  });

  test("skips entry with no provider (starts with /)", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "/claude-sonnet-4-5" },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toBeUndefined();
  });

  test("skips entry with no id (ends with /)", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "anthropic/" },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toBeUndefined();
  });

  test("skips malformed array entry with non-string items", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: ["bad", "values"] },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toBeUndefined();
  });

  test("skips mixed array with some valid and some invalid entries", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": {
          review: ["anthropic/claude-sonnet-4-5", "invalid", "openai/gpt-4o"],
        },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    // Should filter out the invalid entry, keeping only valid ones
    expect(config["stage-models"]?.review).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
  });

  test("skips entry with non-string value (object)", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: { provider: 123, id: "claude-sonnet-4-5" } },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toBeUndefined();
  });

  test("valid single model string passes validation", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: "anthropic/claude-sonnet-4-5" },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toEqual("anthropic/claude-sonnet-4-5");
  });

  test("valid model string array passes validation", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": {
          review: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
        },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
  });

  test("skips non-object stage-models value entirely", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": "not-a-record",
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]).toEqual({});
  });

  test("whitespace-padded model string passes validation (current behavior)", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: " anthropic/claude-sonnet-4-5" },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    // isValidModelString only checks for '/' with chars on both sides — whitespace passes
    // This documents current behavior; trim could be added if needed
    expect(config["stage-models"]?.review).toEqual(" anthropic/claude-sonnet-4-5");
  });

  test("skips null value in stage-models", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: null },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toBeUndefined();
  });

  test("skips boolean value in stage-models", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: true },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toBeUndefined();
  });

  test("skips number value in stage-models", async () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": {
        "stage-models": { review: 42 },
      },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["stage-models"]?.review).toBeUndefined();
  });
});

describe("default-model loading", () => {
  let tmpDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-default-model-test-"));
    globalDir = path.join(tmpDir, "global");
    projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(globalDir, "agent"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    resetFeatyardConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGlobalSettingsJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(globalDir, "agent", "settings.json"), JSON.stringify(data, null, 2));
  }

  function writeProjectSettingsJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), JSON.stringify(data, null, 2));
  }

  test("loads default-model from global settings", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "default-model": "anthropic/claude-sonnet-4-5" },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["default-model"]).toEqual("anthropic/claude-sonnet-4-5");
  });

  test("project default-model overrides global", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "default-model": "anthropic/claude-sonnet-4-5" },
    });
    writeProjectSettingsJson({
      "avtc-pi-featyard": { "default-model": "openai/gpt-4o" },
    });
    const config = loadFeatyardConfig(globalDir, projectDir);
    expect(config["default-model"]).toEqual("openai/gpt-4o");
  });

  test("global default-model used when project has none", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "default-model": "anthropic/claude-sonnet-4-5" },
    });
    writeProjectSettingsJson({ "avtc-pi-featyard": {} });
    const config = loadFeatyardConfig(globalDir, projectDir);
    expect(config["default-model"]).toEqual("anthropic/claude-sonnet-4-5");
  });

  test("skips invalid default-model with warning", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "default-model": "not-a-model" },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["default-model"]).toBeNull();
  });

  test("project null overrides global default-model", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "default-model": "anthropic/claude-sonnet-4-5" },
    });
    writeProjectSettingsJson({
      "avtc-pi-featyard": { "default-model": null, "kanban-port": null },
    });
    const config = loadFeatyardConfig(globalDir, projectDir);
    expect(config["default-model"]).toBeNull(); // project null wins over global value
  });

  test("returns null when no default-model configured", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "stage-models": { review: "openai/gpt-4o" } },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["default-model"]).toBeNull();
  });

  test("skips empty string default-model", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "default-model": "" },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["default-model"]).toBeNull();
  });

  test("skips slash-only default-model", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "default-model": "/" },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["default-model"]).toBeNull();
  });

  test("skips provider-only default-model (trailing slash)", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "default-model": "provider/" },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["default-model"]).toBeNull();
  });

  test("skips id-only default-model (leading slash)", () => {
    writeGlobalSettingsJson({
      "avtc-pi-featyard": { "default-model": "/model-id" },
    });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["default-model"]).toBeNull();
  });

  test("skips non-string default-model values (number, boolean, object)", () => {
    for (const val of [123, true, { provider: "anthropic", id: "claude" }]) {
      writeGlobalSettingsJson({
        "avtc-pi-featyard": { "default-model": val },
      });
      const config = loadFeatyardConfig(globalDir, null);
      expect(config["default-model"]).toBeNull();
    }
  });
});

describe("FeatyardConfig kanban-port loading", () => {
  let tmpDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-config-test-"));
    globalDir = path.join(tmpDir, "global");
    projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(globalDir, "agent"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    resetFeatyardConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGlobalSettingsJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(globalDir, "agent", "settings.json"), JSON.stringify(data, null, 2));
  }

  function writeProjectSettingsJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), JSON.stringify(data, null, 2));
  }

  test("defaults kanban-port to null when not configured", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": {} });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["kanban-port"]).toBeNull();
  });

  test("loads valid kanban-port from global settings", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": 4242 } });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["kanban-port"]).toBe(4242);
  });

  test("accepts boundary port values (1 and 65535)", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": 1 } });
    expect(loadFeatyardConfig(globalDir, null)["kanban-port"]).toBe(1);
    resetFeatyardConfig();
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": 65535 } });
    expect(loadFeatyardConfig(globalDir, null)["kanban-port"]).toBe(65535);
  });

  test("explicit null in global settings yields null", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": null } });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["kanban-port"]).toBeNull();
  });

  test("project kanban-port overrides global", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": 4242 } });
    writeProjectSettingsJson({ "avtc-pi-featyard": { "kanban-port": 9999 } });
    const config = loadFeatyardConfig(globalDir, projectDir);
    expect(config["kanban-port"]).toBe(9999);
  });

  test("project null overrides global kanban-port", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": 4242 } });
    writeProjectSettingsJson({ "avtc-pi-featyard": { "kanban-port": null } });
    const config = loadFeatyardConfig(globalDir, projectDir);
    expect(config["kanban-port"]).toBeNull();
  });

  test("rejects non-integer port (float)", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": 8080.5 } });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["kanban-port"]).toBeNull();
  });

  test("rejects port 0 (reserved for random)", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": 0 } });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["kanban-port"]).toBeNull();
  });

  test("rejects negative port", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": -1 } });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["kanban-port"]).toBeNull();
  });

  test("rejects port above 65535", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": 70000 } });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["kanban-port"]).toBeNull();
  });

  test("rejects non-number port (string)", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": "4242" } });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["kanban-port"]).toBeNull();
  });

  test("rejects non-number port (boolean)", () => {
    writeGlobalSettingsJson({ "avtc-pi-featyard": { "kanban-port": true } });
    const config = loadFeatyardConfig(globalDir, null);
    expect(config["kanban-port"]).toBeNull();
  });
});

describe("invalidateConfigCacheIfChanged", () => {
  let tmpDir: string;
  let globalDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-cache-if-changed-"));
    globalDir = path.join(tmpDir, "global");
    fs.mkdirSync(path.join(globalDir, "agent"), { recursive: true });
    resetSettingsState();
    resetFeatyardConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // settingsLoaded reset removed � resetSettingsState handles it
    resetFeatyardConfig();
  });

  /** No config section (empty config) */
  const NO_SECTION: Record<string, unknown> | null = null;

  function writeGlobalConfig(section: Record<string, unknown> | null): void {
    const filePath = path.join(globalDir, "agent", "settings.json");
    if (section === null) {
      fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
    } else {
      fs.writeFileSync(filePath, JSON.stringify({ "avtc-pi-featyard": section }, null, 2));
    }
  }

  test("does not invalidate when config section unchanged", () => {
    writeGlobalConfig({ "default-model": "test-provider/model-b" });
    // Prime the cache
    const config1 = loadFeatyardConfig(globalDir, null);
    expect(config1["default-model"]).toBe("test-provider/model-b");

    // Save same config — should NOT invalidate
    invalidateConfigCacheIfChanged(globalDir, null);

    // Load again — should return cached result
    const config2 = loadFeatyardConfig(globalDir, null);
    expect(config2["default-model"]).toBe("test-provider/model-b");
  });

  test("invalidates when config section changes", () => {
    writeGlobalConfig({ "default-model": "test-provider/model-b" });
    const config1 = loadFeatyardConfig(globalDir, null);
    expect(config1["default-model"]).toBe("test-provider/model-b");

    // Change config on disk
    writeGlobalConfig({ "default-model": "test-provider/model-e" });

    invalidateConfigCacheIfChanged(globalDir, null);

    const config2 = loadFeatyardConfig(globalDir, null);
    expect(config2["default-model"]).toBe("test-provider/model-e");
  });

  test("does not invalidate when config section absent both times", () => {
    writeGlobalConfig(NO_SECTION);
    const config1 = loadFeatyardConfig(globalDir, null);
    expect(config1["default-model"]).toBeNull();

    invalidateConfigCacheIfChanged(globalDir, null);

    const config2 = loadFeatyardConfig(globalDir, null);
    expect(config2["default-model"]).toBeNull();
  });
});

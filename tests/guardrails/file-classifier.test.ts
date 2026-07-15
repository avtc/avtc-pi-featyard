// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
  applyExtensionOverride,
  baseStem,
  buildExtensionOverride,
  changeSetCoversSource,
  DEFAULT_SOURCE_EXTENSIONS,
  getActiveSourceExtensions,
  isSourceFile,
  isTestFile,
  resetExtensionOverride,
} from "../../src/guardrails/file-classifier.js";
import workflowMonitorExtension from "../../src/index.js";
import { resetFeatyardConfig } from "../../src/settings/settings-ui.js";
import { createFakePi } from "../helpers/workflow-monitor-test-helpers.js";

type OverrideResult = ReturnType<typeof buildExtensionOverride>;

/**
 * Asserts the override result is the "custom" variant and returns its payload
 * (narrowing the discriminated union for the rest of the test).
 */
function asCustom(result: OverrideResult) {
  expect(result.kind).toBe("custom");
  if (result.kind !== "custom") throw new Error("expected custom override");
  return result;
}

describe("isTestFile", () => {
  test("matches.test.ts files", () => {
    expect(isTestFile("src/utils.test.ts")).toBe(true);
  });
  test("matches.spec.ts files", () => {
    expect(isTestFile("src/utils.spec.ts")).toBe(true);
  });
  test("matches.test.js files", () => {
    expect(isTestFile("src/utils.test.js")).toBe(true);
  });
  test("matches files in __tests__/ directory", () => {
    expect(isTestFile("src/__tests__/utils.ts")).toBe(true);
  });
  test("matches files in tests/ directory", () => {
    expect(isTestFile("tests/utils.ts")).toBe(true);
  });
  test("matches files in test/ directory", () => {
    expect(isTestFile("test/utils.ts")).toBe(true);
  });
  test("matches test directory paths (exercises directory pattern, not filename)", () => {
    // These use non-.test filenames so only the directory pattern matches
    expect(isTestFile("tests/utils.ts")).toBe(true);
    expect(isTestFile("test/utils.ts")).toBe(true);
    expect(isTestFile("src/tests/utils.ts")).toBe(true);
    expect(isTestFile("src/test/utils.ts")).toBe(true);
    // Also verify .test.ts in test dirs still works
    expect(isTestFile("tests/foo.test.ts")).toBe(true);
    expect(isTestFile("src/tests/foo.test.ts")).toBe(true);
  });
  test("matches python test files (test_*.py)", () => {
    expect(isTestFile("test_utils.py")).toBe(true);
  });
  test("matches python test files (*_test.py)", () => {
    expect(isTestFile("utils_test.py")).toBe(true);
  });
  test("does not match regular source files", () => {
    expect(isTestFile("src/utils.ts")).toBe(false);
  });
  test("does not match config files", () => {
    expect(isTestFile("vitest.config.ts")).toBe(false);
  });
  test("does not match setup.py", () => {
    expect(isTestFile("setup.py")).toBe(false);
  });
  test("matches JUnit-style *Test.java", () => {
    expect(isTestFile("src/FooTest.java")).toBe(true);
  });
  test("matches JUnit-style *Tests.scala", () => {
    expect(isTestFile("src/BarTests.scala")).toBe(true);
  });
  test("matches JUnit-style *Spec.kt", () => {
    expect(isTestFile("src/BazSpec.kt")).toBe(true);
  });
  test("matches JUnit-style *Test.cs (C#/NUnit)", () => {
    expect(isTestFile("tests/WidgetTest.cs")).toBe(true);
  });
  test("matches Ruby *_test.rb (Minitest)", () => {
    expect(isTestFile("test/parser_test.rb")).toBe(true);
  });
  test("matches Elixir *_test.exs (ExUnit)", () => {
    expect(isTestFile("test/app_test.exs")).toBe(true);
  });
  test("matches Dart *_test.dart", () => {
    expect(isTestFile("test/main_test.dart")).toBe(true);
  });
  test("matches Rust *_test.rs", () => {
    expect(isTestFile("src/server_test.rs")).toBe(true);
  });
  test("does not match 'latest.ts' (lowercase 'test' is not a JUnit test)", () => {
    expect(isTestFile("src/latest.ts")).toBe(false);
  });
  test("does not match 'Latest.ts' (case-sensitive suffix: ends in lowercase 'test')", () => {
    expect(isTestFile("src/Latest.ts")).toBe(false);
  });
  test("does not match 'request.ts' (ends in 'uest', not Test)", () => {
    expect(isTestFile("src/request.ts")).toBe(false);
  });
});

describe("baseStem", () => {
  test("returns the raw stem for source files (no marker stripping)", () => {
    expect(baseStem("src/ui/value-picker.ts")).toBe("value-picker");
    expect(baseStem("src/utils.py")).toBe("utils");
    expect(baseStem("src/index.ts")).toBe("index");
  });

  test("does not strip marker-like substrings from non-test source names", () => {
    // `test_runner.ts` is a SOURCE file (the test_ prefix rule is Python-only),
    // so its name must be preserved verbatim — otherwise it would falsely pair
    // with a `runner.test.ts`.
    expect(baseStem("src/test_runner.ts")).toBe("test_runner");
  });

  test("strips the .test segment (flat, mirrored, and co-located)", () => {
    expect(baseStem("tests/value-picker.test.ts")).toBe("value-picker");
    expect(baseStem("tests/ui/value-picker.test.ts")).toBe("value-picker");
    expect(baseStem("src/ui/value-picker.test.ts")).toBe("value-picker");
  });

  test("strips the .spec segment", () => {
    expect(baseStem("tests/value-picker.spec.ts")).toBe("value-picker");
  });

  test("strips the _test suffix (Go/Rust/Ruby/Elixir/Dart)", () => {
    expect(baseStem("src/value-picker_test.go")).toBe("value-picker");
    expect(baseStem("tests/parser_test.rb")).toBe("parser");
  });

  test("strips the test_ prefix (Python)", () => {
    expect(baseStem("tests/test_utils.py")).toBe("utils");
  });

  test("strips the JUnit Test/Tests/Spec suffix (case-sensitive)", () => {
    expect(baseStem("src/FooTest.java")).toBe("Foo");
    expect(baseStem("src/AppTests.kt")).toBe("App");
    expect(baseStem("src/FooSpec.java")).toBe("Foo");
  });

  test("returns the raw stem for a dir-rule test with no name marker", () => {
    // lives under tests/ so isTestFile is true, but the name has no marker.
    expect(baseStem("tests/helpers.ts")).toBe("helpers");
  });

  test("preserves extra dot-segments beyond the trailing test marker", () => {
    expect(baseStem("tests/value-picker.integration.test.ts")).toBe("value-picker.integration");
  });
});

describe("changeSetCoversSource", () => {
  test("flat tests/ layout (the reported bug): modified flat test covers nested source", () => {
    expect(
      changeSetCoversSource("src/ui/value-picker.ts", ["src/ui/value-picker.ts", "tests/value-picker.test.ts"]),
    ).toBe(true);
  });

  test("mirrored tests/<subdir>/ layout", () => {
    expect(changeSetCoversSource("src/lib/math/add.ts", ["tests/lib/math/add.test.ts"])).toBe(true);
  });

  test("co-located .spec test", () => {
    expect(changeSetCoversSource("src/utils.ts", ["src/utils.spec.ts"])).toBe(true);
  });

  test("test with a different extension but matching stem still covers", () => {
    expect(changeSetCoversSource("src/utils.ts", ["tests/utils.test.tsx"])).toBe(true);
  });

  test("no test in the change set -> not covered", () => {
    expect(changeSetCoversSource("src/ui/value-picker.ts", ["src/ui/value-picker.ts"])).toBe(false);
  });

  test("unrelated test in the change set -> not covered (stems differ)", () => {
    // This is the false-negative P2 would have missed: a test for `a` must not
    // cover an edit to `b`.
    expect(changeSetCoversSource("src/b.ts", ["tests/a.test.ts"])).toBe(false);
  });

  test("empty change set -> not covered", () => {
    expect(changeSetCoversSource("src/foo.ts", [])).toBe(false);
  });

  test("empty source -> not covered", () => {
    expect(changeSetCoversSource("", ["tests/x.test.ts"])).toBe(false);
  });

  test("the source file itself in the set never self-matches", () => {
    expect(changeSetCoversSource("src/value-picker.ts", ["src/value-picker.ts"])).toBe(false);
  });

  test("a test that EXTENDS the source name (at a separator) covers it", () => {
    // value-picker.ts covered by value-picker-helpers.test.ts (extends at '-')
    expect(changeSetCoversSource("src/value-picker.ts", ["tests/value-picker-helpers.test.ts"])).toBe(true);
    // auto-agent-lifecycle.ts covered by auto-agent-lifecycle-callbacks.test.ts
    expect(
      changeSetCoversSource("extensions/auto-agent-lifecycle.ts", ["tests/auto-agent-lifecycle-callbacks.test.ts"]),
    ).toBe(true);
    // extension at a '.' boundary (dot-segment variant)
    expect(changeSetCoversSource("src/utils.ts", ["tests/utils.render.test.ts"])).toBe(true);
  });

  test("a test whose stem starts with the source but NOT at a separator does NOT cover", () => {
    // 'agent' is a prefix of 'reagent' chars-wise but not at a boundary -> reject.
    expect(changeSetCoversSource("src/agent.ts", ["tests/reagent.test.ts"])).toBe(false);
    // 'auto-agent' is inside 'auto-agentics' with no separator after 'auto-agent' -> reject.
    expect(changeSetCoversSource("src/auto-agent.ts", ["tests/auto-agentics.test.ts"])).toBe(false);
  });

  test("sibling-named tests do NOT cover a source (the rename driver)", () => {
    // auto-agent-callbacks.test does not extend auto-agent-lifecycle.ts -> not covered.
    // This is exactly the case the rename convention must fix.
    expect(changeSetCoversSource("extensions/auto-agent-lifecycle.ts", ["tests/auto-agent-callbacks.test.ts"])).toBe(
      false,
    );
  });
});

describe("isTestFile expanded extensions", () => {
  test("matches.test.dart files", () => {
    expect(isTestFile("lib/main.test.dart")).toBe(true);
  });
  test("matches.spec.php files", () => {
    expect(isTestFile("tests/index.spec.php")).toBe(true);
  });
  test("matches.test.ex files (Elixir)", () => {
    expect(isTestFile("test/app.test.ex")).toBe(true);
  });
});

describe("isSourceFile", () => {
  test("matches.ts files", () => {
    expect(isSourceFile("src/utils.ts")).toBe(true);
  });
  test("matches.py files", () => {
    expect(isSourceFile("src/main.py")).toBe(true);
  });
  test("excludes declaration-only file formats (*.d.ts/.d.tsx/.d.mts/.d.cts, *.di, *.mli)", () => {
    // These formats definitionally carry no runtime implementation — only type/
    // signature declarations — so they have nothing to test and must not trigger
    // the TDD check. The signal is in the EXTENSION, not the basename, so it is
    // safe to exclude (unlike conventionally-named files like index.ts/types.ts).
    //   .d.*  -> TypeScript ambient declarations
    //   .di   -> D interface files
    //   .mli  -> OCaml interface (signature) files
    expect(isSourceFile("extensions/global.d.ts")).toBe(false);
    expect(isSourceFile("src/types.d.tsx")).toBe(false);
    expect(isSourceFile("src/env.d.mts")).toBe(false);
    expect(isSourceFile("src/vite-env.d.cts")).toBe(false);
    expect(isSourceFile("src/types.di")).toBe(false);
    expect(isSourceFile("src/foo.mli")).toBe(false);
  });
  test("matches.go files", () => {
    expect(isSourceFile("cmd/server.go")).toBe(true);
  });
  test("does not match test files", () => {
    expect(isSourceFile("src/utils.test.ts")).toBe(false);
  });
  test("does not match config files", () => {
    expect(isSourceFile("vitest.config.ts")).toBe(false);
  });
  test("does not match markdown", () => {
    expect(isSourceFile("README.md")).toBe(false);
  });
  test("does not match json", () => {
    expect(isSourceFile("package.json")).toBe(false);
  });
  test("matches.dart files", () => {
    expect(isSourceFile("lib/main.dart")).toBe(true);
  });
  test("matches.php files", () => {
    expect(isSourceFile("src/index.php")).toBe(true);
  });
  test("matches.cpp files", () => {
    expect(isSourceFile("src/engine.cpp")).toBe(true);
  });
  test("matches.ex files (Elixir)", () => {
    expect(isSourceFile("lib/app.ex")).toBe(true);
  });
  test("matches.lua files", () => {
    expect(isSourceFile("src/main.lua")).toBe(true);
  });
  test("matches.zig files", () => {
    expect(isSourceFile("src/main.zig")).toBe(true);
  });
  test("matches.hs files (Haskell)", () => {
    expect(isSourceFile("src/Main.hs")).toBe(true);
  });
  test("matches.scala files", () => {
    expect(isSourceFile("src/App.scala")).toBe(true);
  });
  test("matches.d files (D language)", () => {
    expect(isSourceFile("src/main.d")).toBe(true);
  });
  test("excludes .di files (D interface — declaration-only, not source)", () => {
    // D interface files contain signatures only (no function bodies), so they
    // are declaration-only and must not trigger the TDD check.
    expect(isSourceFile("src/types.di")).toBe(false);
  });
  test("matches.sol files (Solidity)", () => {
    expect(isSourceFile("contracts/Token.sol")).toBe(true);
  });
  test("matches.hx files (Haxe)", () => {
    expect(isSourceFile("src/Main.hx")).toBe(true);
  });
  test("matches.gd files (GDScript)", () => {
    expect(isSourceFile("player.gd")).toBe(true);
  });
  test("matches.astro files (Astro)", () => {
    expect(isSourceFile("src/pages/index.astro")).toBe(true);
  });
  test("matches.gleam files (Gleam)", () => {
    expect(isSourceFile("src/app.gleam")).toBe(true);
  });
  test("matches.rkt files (Racket)", () => {
    expect(isSourceFile("src/main.rkt")).toBe(true);
  });
  test("matches.scm files (Scheme)", () => {
    expect(isSourceFile("src/main.scm")).toBe(true);
  });
  test("matches.mojo files (Mojo)", () => {
    expect(isSourceFile("src/main.mojo")).toBe(true);
  });
  test("does not match.ps1 files (PowerShell excluded by design)", () => {
    expect(isSourceFile("scripts/build.ps1")).toBe(false);
  });
  test("does not match.sh files (shell excluded by design)", () => {
    expect(isSourceFile("scripts/deploy.sh")).toBe(false);
  });
  test("does not match files inside dotfolders (.featyard/,.git/,.vscode/,.github/)", () => {
    expect(isSourceFile(".featyard/research/scratch/foo.ts")).toBe(false);
    expect(isSourceFile(".featyard/task-plans/x.ts")).toBe(false);
    expect(isSourceFile(".git/hooks/foo.ts")).toBe(false);
    expect(isSourceFile(".pi/featyard/foo.ts")).toBe(false);
    expect(isSourceFile(".vscode/foo.ts")).toBe(false);
    expect(isSourceFile(".github/workflows/ci.ts")).toBe(false);
  });
  test("still matches normal source at the repo root", () => {
    expect(isSourceFile("foo.ts")).toBe(true);
    expect(isSourceFile("lib/app.ex")).toBe(true);
  });
  test("relative paths with. /.. segments still classify as source", () => {
    expect(isSourceFile("./src/foo.ts")).toBe(true);
    expect(isSourceFile("../lib/foo.ts")).toBe(true);
    expect(isSourceFile("././src/foo.ts")).toBe(true);
  });
  test("nested source under a normal dir still matches even when a sibling dotdir exists", () => {
    expect(isSourceFile("src/nested/deep/foo.ts")).toBe(true);
    expect(isSourceFile("packages/lib/src/index.ts")).toBe(true);
  });
});

describe("applyExtensionOverride", () => {
  afterEach(() => {
    resetExtensionOverride(); // reset between tests
  });

  test("overrides SOURCE_EXTENSIONS for isSourceFile", () => {
    applyExtensionOverride(".ts|.py");
    expect(isSourceFile("src/app.dart")).toBe(false);
    expect(isSourceFile("src/app.ts")).toBe(true);
  });

  test("isSourceFile still excludes test files after applyExtensionOverride", () => {
    applyExtensionOverride(".ts|.py|.dart");
    // Source files should match
    expect(isSourceFile("src/app.ts")).toBe(true);
    expect(isSourceFile("lib/main.dart")).toBe(true);
    // Test files must still be excluded even though extension matches
    expect(isSourceFile("src/app.test.ts")).toBe(false);
    expect(isSourceFile("src/app.spec.ts")).toBe(false);
    expect(isSourceFile("test/app.test.ts")).toBe(false);
  });

  test("overrides TEST_PATTERNS.test./.spec. extension check", () => {
    applyExtensionOverride(".ts");
    expect(isTestFile("src/app.test.ts")).toBe(true);
    expect(isTestFile("src/app.test.py")).toBe(false);
  });

  test("reset restores built-in defaults", () => {
    applyExtensionOverride(".ts");
    expect(isSourceFile("src/app.py")).toBe(false);
    resetExtensionOverride();
    expect(isSourceFile("src/app.py")).toBe(true);
  });

  test("getActiveSourceExtensions returns default extensions when no override", () => {
    const exts = getActiveSourceExtensions();
    expect(exts).toContain(".ts");
    expect(exts).toContain(".py");
  });

  test("directory-based test patterns still work after applyExtensionOverride narrows extensions", () => {
    applyExtensionOverride(".ts");
    // .test.py should NOT match (narrowed to ts only for spec pattern)
    expect(isTestFile("src/app.test.py")).toBe(false);
    // But directory-based patterns always use defaults
    expect(isTestFile("tests/app.py")).toBe(true);
    expect(isTestFile("src/__tests__/app.rs")).toBe(true);
    expect(isTestFile("test_utils.py")).toBe(true);
    expect(isTestFile("src/utils_test.go")).toBe(true);
  });

  test("getActiveSourceExtensions returns override after applyExtensionOverride", () => {
    applyExtensionOverride(".rs|.go");
    const exts = getActiveSourceExtensions();
    expect(exts).toContain(".rs");
    expect(exts).toContain(".go");
    expect(exts).not.toContain(".ts");
  });
});

describe("buildExtensionOverride", () => {
  test("full-replace mode: returns { pattern, extensions } from valid entries", () => {
    const { extensions, pattern } = asCustom(buildExtensionOverride([".ts", ".py"]));
    expect(pattern.test("file.ts")).toBe(true);
    expect(pattern.test("file.py")).toBe(true);
    expect(pattern.test("file.go")).toBe(false);
    expect(extensions).toBe(".py|.ts");
  });

  test("modify-defaults mode: adds extensions", () => {
    const { pattern } = asCustom(buildExtensionOverride(["+.dart"]));
    expect(pattern.test("file.dart")).toBe(true);
    expect(pattern.test("file.ts")).toBe(true);
  });

  test("modify-defaults mode: removes extensions", () => {
    const { pattern } = asCustom(buildExtensionOverride(["-.v"]));
    expect(pattern.test("file.v")).toBe(false);
    expect(pattern.test("file.ts")).toBe(true);
  });

  test("modify-defaults mode: mixed add and remove", () => {
    const { pattern } = asCustom(buildExtensionOverride(["+.dart", "-.v"]));
    expect(pattern.test("file.dart")).toBe(true);
    expect(pattern.test("file.v")).toBe(false);
    expect(pattern.test("file.ts")).toBe(true);
  });

  test("invalid entries are silently skipped", () => {
    const { pattern } = asCustom(buildExtensionOverride([".ts", "bad", "", ".py"]));
    expect(pattern.test("file.ts")).toBe(true);
    expect(pattern.test("file.py")).toBe(true);
  });

  test("all-invalid entries return defaults", () => {
    const result = buildExtensionOverride(["bad", ""]);
    expect(result.kind).toBe("defaults");
  });

  test("empty array returns defaults", () => {
    const result = buildExtensionOverride([]);
    expect(result.kind).toBe("defaults");
  });

  test("mixed mode (prefix and non-prefix) returns defaults", () => {
    const result = buildExtensionOverride([".ts", "+.dart"]);
    expect(result.kind).toBe("defaults");
  });

  test("extensions are case-insensitive", () => {
    const { pattern } = asCustom(buildExtensionOverride([".TS"]));
    expect(pattern.test("file.ts")).toBe(true);
    expect(pattern.test("file.TS")).toBe(true);
  });

  test("modify-defaults: removing all defaults yields defaults", () => {
    // Remove every default extension
    const removeAll = DEFAULT_SOURCE_EXTENSIONS.map((e) => `-${e}`);
    const result = buildExtensionOverride(removeAll);
    expect(result.kind).toBe("defaults");
  });

  test("modify-defaults: duplicate additions are deduped", () => {
    const { extensions } = asCustom(buildExtensionOverride(["+.ts", "+.ts"]));
    // ts already exists in defaults, so extensions should list .ts only once
    const tsCount = extensions.split("|").filter((e) => e === ".ts").length;
    expect(tsCount).toBe(1);
  });

  test("+/- entries without dot prefix are silently skipped", () => {
    const result = buildExtensionOverride(["+ts", "-js"]);
    // Neither "+ts" nor "-js" has a dot after the prefix, so both are skipped
    expect(result.kind).toBe("defaults");
  });

  test("single-dot entry (no extension after dot) is silently skipped", () => {
    const result = buildExtensionOverride(["."]);
    // "." fails the dot+body validation
    expect(result.kind).toBe("defaults");

    // Also verify mixed: valid entries + bare dot still works
    const { pattern } = asCustom(buildExtensionOverride([".", ".ts"]));
    expect(pattern.test("file.ts")).toBe(true);
    // Should NOT match bare dot (any file)
    expect(pattern.test("file")).toBe(false);
  });

  test("whitespace-only entries are silently skipped", () => {
    const result = buildExtensionOverride(["  ", "\t", "\n"]);
    // All entries are whitespace-only, treated as empty, so falls back to defaults
    expect(result.kind).toBe("defaults");
  });

  test("regex special characters in user input are safely rejected", () => {
    // Extensions with regex special chars (e.g., .c++, .*) are not valid file extensions.
    // The function should skip them rather than crash or produce invalid regex.
    const result = buildExtensionOverride([".c++"]);
    expect(result.kind).toBe("defaults"); // unsafe entry skipped, no valid entries remain

    // Mixed: valid + unsafe entries — only valid ones are kept
    const { pattern } = asCustom(buildExtensionOverride([".ts", ".c++", ".py"]));
    expect(pattern.test("file.ts")).toBe(true);
    expect(pattern.test("file.py")).toBe(true);
  });

  test("removing all defaults then adding one back yields only the added extension", () => {
    // Re-adding a default extension after removing all defaults must survive:
    // removes apply first, then adds — so an added extension wins even if it was removed.
    const removeAllThenAdd = [...DEFAULT_SOURCE_EXTENSIONS.map((e) => `-${e}`), "+.dart"];
    const { extensions, pattern } = asCustom(buildExtensionOverride(removeAllThenAdd));
    expect(pattern.test("file.dart")).toBe(true);
    // Original defaults should no longer match
    expect(pattern.test("file.ts")).toBe(false);
    expect(pattern.test("file.py")).toBe(false);
    expect(extensions).toBe(".dart");
  });

  test("add wins over remove of the same extension (removes apply first)", () => {
    // +.dart and -.dart together: the remove drops .dart, but the add re-adds it.
    const result = buildExtensionOverride(["+.dart", "-.dart"]);
    const { pattern } = asCustom(result);
    expect(pattern.test("file.dart")).toBe(true);
    // and .dart appears exactly once
    expect(
      asCustom(result)
        .extensions.split("|")
        .filter((e) => e === ".dart"),
    ).toHaveLength(1);
  });
});

describe("syncSourceExtensions wiring (integration)", () => {
  afterEach(() => {
    resetExtensionOverride();
  });

  test("settings with sourceExtensions → buildExtensionOverride → applyExtensionOverride → isSourceFile matches", () => {
    // Simulate what syncSourceExtensions() does:
    // 1. Read sourceExtensions from settings
    const settingsExtensions = [".ts", ".py"];
    // 2. Build override from settings
    const result = buildExtensionOverride(settingsExtensions);
    // 3. Apply via applyExtensionOverride (the extensions path)
    const { extensions } = asCustom(result);
    applyExtensionOverride(extensions);
    // 4. Verify isSourceFile behavior changed
    expect(isSourceFile("file.ts")).toBe(true);
    expect(isSourceFile("file.py")).toBe(true);
    // Non-configured extensions should NOT match
    expect(isSourceFile("file.rs")).toBe(false);
    expect(isSourceFile("file.go")).toBe(false);
  });

  test("settings with invalid sourceExtensions → buildExtensionOverride returns defaults → resetExtensionOverride → defaults apply", () => {
    // Simulate syncSourceExtensions with invalid entries
    const settingsExtensions = ["bad", ""];
    const result = buildExtensionOverride(settingsExtensions);
    expect(result.kind).toBe("defaults");
    // syncSourceExtensions calls resetExtensionOverride() for a defaults result
    resetExtensionOverride();
    // Defaults should still work
    expect(isSourceFile("file.ts")).toBe(true);
    expect(isSourceFile("file.py")).toBe(true);
  });

  test("settings with modify-defaults sourceExtensions → adds extension to defaults", () => {
    const settingsExtensions = ["+.dart"];
    const result = buildExtensionOverride(settingsExtensions);
    const { extensions } = asCustom(result);
    applyExtensionOverride(extensions);
    // dart should now be recognized as source
    expect(isSourceFile("file.dart")).toBe(true);
    // defaults still work
    expect(isSourceFile("file.ts")).toBe(true);
  });
});

describe("syncSourceExtensions real wiring (integration)", () => {
  // These tests exercise the real syncSourceExtensions() path through
  // workflowMonitorExtension initialization, not the manual simulation above.

  afterEach(() => {
    resetExtensionOverride();
  });

  test("workflowMonitorExtension init applies sourceExtensions from featyard config", async () => {
    delete (globalThis as unknown as Record<string, unknown>).__piWorkflowMonitor;

    const fake = createFakePi();
    // Write a featyard section to the project settings.json (temp cwd) so
    // loadFeatyardConfig reads source-extensions from disk during init.
    // (settings onLoad hook resets the config cache, so a pre-seeded in-memory
    //  config would be wiped — disk is the durable source.)
    const piDir = path.join(process.cwd(), ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      path.join(piDir, "settings.json"),
      JSON.stringify({ "avtc-pi-featyard": { "source-extensions": [".ts", ".py"] } }),
    );

    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    resetFeatyardConfig();

    // syncSourceExtensions should have applied the [.ts, .py] override
    // so isSourceFile only matches .ts and .py (not .rs, .go, etc.)
    expect(isSourceFile("file.ts")).toBe(true);
    expect(isSourceFile("file.py")).toBe(true);
    expect(isSourceFile("file.rs")).toBe(false);
    expect(isSourceFile("file.go")).toBe(false);
  });

  test("workflowMonitorExtension init resets to defaults when sourceExtensions is omitted", async () => {
    // First, set a custom extension list
    applyExtensionOverride(".ts|.py");
    expect(isSourceFile("file.rs")).toBe(false);

    // No source-extensions in config → defaults are restored
    delete (globalThis as unknown as Record<string, unknown>).__piWorkflowMonitor;

    const fake = createFakePi();
    // Project settings.json with a featyard section but NO source-extensions.
    const piDir = path.join(process.cwd(), ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ "avtc-pi-featyard": {} }));

    await workflowMonitorExtension(fake.api as unknown as ExtensionAPI);
    resetFeatyardConfig();

    // Defaults should be restored — .rs and .go are in the default set
    expect(isSourceFile("file.rs")).toBe(true);
    expect(isSourceFile("file.go")).toBe(true);
  });
});

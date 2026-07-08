// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Pure path-string file classifier for a TDD-disciplined coding-agent workflow.
 *
 * This module answers four questions about a POSIX file path using ONLY string
 * analysis (no filesystem access):
 *
 *   1. Is this path a test file?            -> {@link isTestFile}
 *   2. Is this path a source file?          -> {@link isSourceFile}
 *   3. Does a change set cover a source?    -> {@link changeSetCoversSource}
 *   4. Narrow / replace the source-ext set  -> {@link buildExtensionOverride} /
 *                                              {@link applyExtensionOverride} /
 *                                              {@link resetExtensionOverride}
 *
 * The only import is `node:path` (its `posix` flavor). Nothing reads the disk.
 */

import { posix as pathPosix } from "node:path";

// ---------------------------------------------------------------------------
// Default source-code extension set (BEHAVIOR 2 breadth)
// ---------------------------------------------------------------------------

/**
 * Built-in, broad set of source-code extensions. Deliberately excludes script
 * extensions (`.ps1`, `.sh`) because those do not participate in source/test
 * pairing. Frozen so callers cannot mutate the shared default.
 */
export const DEFAULT_SOURCE_EXTENSIONS: readonly string[] = Object.freeze([
  // TypeScript / JavaScript family
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  // Python
  ".py",
  // Go
  ".go",
  // Rust
  ".rs",
  // JVM
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".groovy",
  // Clojure
  ".clj",
  ".cljs",
  ".cljc",
  // C / C++
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hxx",
  // .NET
  ".cs",
  ".fs",
  ".fsx",
  ".vb",
  // Objective-C
  ".m",
  ".mm",
  // Dynamic / scripting
  ".rb",
  ".php",
  ".swift",
  ".dart",
  // Functional
  ".hs",
  ".lhs",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".lua",
  ".r",
  ".pl",
  ".pm",
  // Systems / modern
  ".zig",
  ".nim",
  ".cr",
  ".ml",
  ".mli",
  ".elm",
  ".purs",
  ".jl",
  // Web components
  ".vue",
  ".svelte",
  ".astro",
  // Niche / academic
  ".v",
  ".idr",
  ".d",
  ".di",
  ".sol",
  ".hx",
  ".gd",
  ".gleam",
  ".rkt",
  ".scm",
  ".mojo",
]);

const DEFAULT_SOURCE_EXT_SET: ReadonlySet<string> = new Set(DEFAULT_SOURCE_EXTENSIONS);

/**
 * Extensions whose `*_test.<ext>` form is a language-native test convention.
 * Used by the underscore-suffix rule (BEHAVIOR 1). Fixed regardless of any
 * runtime override (language-specific rules always use the built-in defaults).
 */
const UNDERSCORE_TEST_EXTS: ReadonlySet<string> = new Set([
  ".py", // Python *_test.py
  ".go", // Go *_test.go
  ".rs", // Rust *_test.rs
  ".rb", // Ruby (Minitest) *_test.rb
  ".exs", // Elixir (ExUnit) *_test.exs
  ".dart", // Dart *_test.dart
]);

/** Directory names that mark any path beneath them as a test path (any depth). */
const TEST_DIR_NAMES: ReadonlySet<string> = new Set(["test", "tests", "__tests__"]);

/** JUnit-family suffix on the filename stem (case-sensitive: Test / Tests / Spec). */
const JUNIT_STEM_SUFFIX = /(?:Tests?|Spec)$/;

// ---------------------------------------------------------------------------
// Runtime override state (BEHAVIOR 4)
// ---------------------------------------------------------------------------

/**
 * Active override, or `null` to use {@link DEFAULT_SOURCE_EXT_SET}. Mutated only
 * by {@link applyExtensionOverride} / {@link resetExtensionOverride}.
 */
let activeOverride: ReadonlySet<string> | null = null;

/** Returns the extension set currently in effect (override, else default). */
function activeExtSet(): ReadonlySet<string> {
  return activeOverride ?? DEFAULT_SOURCE_EXT_SET;
}

/**
 * Snapshot of the extensions currently in effect, as a fresh array. Handy for
 * introspection and tests.
 */
export function getActiveSourceExtensions(): readonly string[] {
  return [...activeExtSet()];
}

// ---------------------------------------------------------------------------
// Small path helpers
// ---------------------------------------------------------------------------

/** Splits a basename into stem + lowercased extension. Dotfiles get no ext. */
function splitName(basename: string): { stem: string; ext: string } {
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return { stem: basename, ext: "" };
  return { stem: basename.slice(0, dot), ext: basename.slice(dot).toLowerCase() };
}

/** True for config / dotfile basenames that are never source files. */
function isConfigOrDotfile(basename: string): boolean {
  if (basename.startsWith(".")) return true; // hidden / dotfile
  if (basename === "package.json") return true;
  if (/^tsconfig.*\.json$/.test(basename)) return true;
  if (/\.config\.(?:ts|js|mjs|cjs)$/.test(basename)) return true;
  return false;
}

/**
 * True when any DIRECTORY segment of `p` is a dotfolder (starts with `.`).
 * Excludes the literal `.` and `..` segments so relative paths like
 * `./src/foo.ts` or `../lib/foo.ts` still classify as source. Files inside
 * tooling / scratch / config directories (`.ff/`, `.git/`, `.pi/`, `.vscode/`,
 * `.github/`, …) are not project source and must not trip the TDD source-write
 * warning. The basename is not considered here — a dotfile basename is handled
 * by {@link isConfigOrDotfile}.
 */
function isUnderDotdir(p: string): boolean {
  const segments = p.split("/");
  // Drop the trailing basename so a dotfile basename isn't double-counted.
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg.length > 0 && seg.startsWith(".") && seg !== "." && seg !== "..") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// BEHAVIOR 1 — is this a test file?
// ---------------------------------------------------------------------------

/**
 * Returns true when `p` matches ANY recognized test-file convention:
 *   - lives under a `test` / `tests` / `__tests__` directory (any depth, any ext),
 *   - has a `.test.` / `.spec.` segment AND a recognized source extension
 *     (this rule honors a runtime override),
 *   - Python `test_*.py` / `*_test.py`,
 *   - Go / Rust / Ruby / Elixir / Dart `*_test.<ext>`,
 *   - JUnit-family stem ending in `Test` / `Tests` / `Spec` (case-sensitive).
 *
 * The directory and language-specific rules always use the built-in defaults;
 * only the `.test.` / `.spec.` segment rule honors a runtime override.
 */
export function isTestFile(p: string): boolean {
  if (!p) return false;

  // Directory rule (any extension).
  const segments = p.split("/");
  for (const seg of segments) {
    if (TEST_DIR_NAMES.has(seg)) return true;
  }

  const base = pathPosix.basename(p);
  if (!base) return false;
  const { stem, ext } = splitName(base);

  // `.test.` / `.spec.` segment rule — honors the active extension set.
  const parts = base.split(".");
  if (parts.length >= 3) {
    const inner = parts.slice(1, -1);
    if (inner.includes("test") || inner.includes("spec")) {
      if (ext && activeExtSet().has(ext)) return true;
    }
  }

  // Underscore-suffix rule (language-native, fixed ext set).
  if (ext && stem.endsWith("_test") && UNDERSCORE_TEST_EXTS.has(ext)) return true;

  // Python `test_*` prefix rule.
  if (ext === ".py" && stem.startsWith("test_")) return true;

  // JUnit-family stem-suffix rule (case-sensitive, any extension).
  if (JUNIT_STEM_SUFFIX.test(stem)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// BEHAVIOR 2 — is this a source file?
// ---------------------------------------------------------------------------

/**
 * Returns true when `p` has a recognized source extension (honors the active
 * override) AND is not a test file AND is not a config / dotfile.
 */
export function isSourceFile(p: string): boolean {
  if (!p) return false;
  if (isUnderDotdir(p)) return false; // tooling / scratch / config dir (e.g. .ff/, .git/, .vscode/)
  const base = pathPosix.basename(p);
  if (!base || isConfigOrDotfile(base)) return false;
  // Declaration-only file formats carry no runtime implementation — only
  // type / signature declarations — so they have nothing to test and must not
  // trigger the TDD check. The signal is the EXTENSION (which definitionally
  // guarantees "no implementation"), not the basename, so excluding by name is
  // safe here (unlike conventionally-named files such as index.ts / types.ts):
  //   .d.*  -> TypeScript ambient declarations
  //   .di   -> D interface files
  //   .mli  -> OCaml interface (signature) files
  if (/\.d\.(?:ts|tsx|mts|cts)$/.test(base)) return false;
  if (/\.(?:di|mli)$/.test(base)) return false;
  const { ext } = splitName(base);
  if (!ext || !activeExtSet().has(ext)) return false;
  if (isTestFile(p)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// BEHAVIOR 3b — stem-based correspondence (change-set coverage)
// ---------------------------------------------------------------------------
//
// These helpers answer the layout-independent question: "given the set of
// files in a change set, does one of them correspond to this source by NAME?"
// This is what the TDD write-order and pre-commit coverage checks need — they
// already have the file list (from a git query) and pair by stem, so they do
// not depend on any particular test-tree layout.

/**
 * Strip the test marker from a stem that is already known to belong to a test
 * file (caller gates via {@link isTestFile}). Recognizes the same conventions
 * isTestFile uses: a trailing `.test`/`.spec` dot-segment, a `_test` suffix, a
 * `test_` prefix, and a JUnit `Test`/`Tests`/`Spec` suffix (case-sensitive).
 * Returns the stem unchanged when no marker is present (e.g. a file that is a
 * test only by virtue of living under a `tests/` directory).
 */
function stripTestMarker(stem: string): string {
  // `.test` / `.spec` as the final dot-segment.
  const parts = stem.split(".");
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last === "test" || last === "spec") {
      return parts.slice(0, -1).join(".");
    }
  }
  // `_test` suffix (Go/Rust/Ruby/Elixir/Dart).
  if (stem.endsWith("_test")) return stem.slice(0, -"_test".length);
  // `test_` prefix (Python).
  if (stem.startsWith("test_")) return stem.slice("test_".length);
  // JUnit `Test`/`Tests`/`Spec` suffix (case-sensitive).
  const junit = stem.match(/(Tests?|Spec)$/);
  if (junit) return stem.slice(0, -junit[0].length);
  return stem;
}

/**
 * The canonical name a test would target, used to pair a source with its test
 * regardless of layout. For a non-test file this is the basename minus its
 * extension (the raw stem, preserved verbatim — a source named `test_runner.ts`
 * stays `test_runner`). For a test file the test marker is stripped
 * (`value-picker.test.ts`, `value-picker_test.go`, `test_utils.py`,
 * `FooTest.java` all reduce to the subject name).
 */
export function baseStem(p: string): string {
  if (!p) return "";
  const base = pathPosix.basename(p);
  if (!base) return "";
  const { stem } = splitName(base);
  // Only strip a marker when the path is actually a test file, so source names
  // that happen to contain marker-like substrings are never altered.
  return isTestFile(p) ? stripTestMarker(stem) : stem;
}

/**
 * Does the change-set file list contain a test that corresponds to `source` by
 * name? Layout-independent: works for flat (`tests/x.test.ts`), mirrored
 * (`tests/ui/x.test.ts`), and co-located (`src/x.spec.ts`) conventions alike,
 * because correspondence is by stem, not by path. The source itself, if present
 * in the list, never matches (it is not a test file).
 */
export function changeSetCoversSource(source: string, files: readonly string[]): boolean {
  if (!source || files.length === 0) return false;
  const want = baseStem(source);
  if (want === "") return false;
  return files.some((p) => {
    if (!isTestFile(p)) return false;
    const ts = baseStem(p);
    // A test corresponds to a source when its stem equals the source's stem, or
    // EXTENDS it at a separator boundary ("-" / "."): `value-picker` covers
    // `value-picker` and `value-picker-helpers`; `auto-agent-lifecycle` covers
    // `auto-agent-lifecycle-callbacks`. The boundary prevents `agent` matching
    // `reagent` / `auto-agent` (no separator) and keeps short names honest.
    if (ts === want) return true;
    if (ts.startsWith(want)) {
      const next = ts.charCodeAt(want.length);
      // 45 = '-', 46 = '.'
      return next === 45 || next === 46;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// BEHAVIOR 4 — runtime extension override
// ---------------------------------------------------------------------------

/** Outcome of parsing a user extension-override spec. */
export type ExtensionOverrideResult =
  | { readonly kind: "defaults" }
  | { readonly kind: "custom"; readonly extensions: string; readonly pattern: RegExp };

/** Validates one spec token into a normalized `.<ext>` (lowercase), or null. */
function normalizeToken(raw: string): { sign: "+" | "-" | ""; ext: string } | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let sign: "+" | "-" | "" = "";
  let body = trimmed;
  if (trimmed.startsWith("+")) {
    sign = "+";
    body = trimmed.slice(1);
  } else if (trimmed.startsWith("-")) {
    sign = "-";
    body = trimmed.slice(1);
  }
  const ext = body.toLowerCase();
  if (!/^\.[a-z0-9-]+$/.test(ext)) return null; // must be ".<letters|digits|hyphens>"
  return { sign, ext };
}

/** Builds extensions + regex (sorted) from a finalized extension set. */
function toCustomResult(set: Set<string>): ExtensionOverrideResult {
  const sorted = [...set].sort();
  const extensions = sorted.join("|"); // ".go|.py|.ts"
  const alts = sorted.map((e) => e.slice(1)).join("|"); // "go|py|ts"
  const pattern = new RegExp(`\\.(?:${alts})$`, "i");
  return { kind: "custom", extensions, pattern };
}

/**
 * Resolves a user override spec into either a custom extension set or a signal
 * to keep the defaults.
 *
 * Each entry is one of:
 *   - `.<ext>`   — full-replace (only these count, defaults discarded),
 *   - `+.<ext>`  — add to defaults,
 *   - `-.<ext>`  — remove from defaults.
 *
 * Tokens are trimmed and lowercased; whitespace and invalid tokens
 * (`.c++`, `.`, `+ts`, …) are silently skipped. Mixing bare tokens with
 * `+`/`-` tokens is ambiguous and rejects the whole spec. An empty result
 * (everything removed, or no valid tokens) also falls back to defaults.
 */
export function buildExtensionOverride(entries: readonly string[]): ExtensionOverrideResult {
  const adds: string[] = [];
  const removes: string[] = [];
  const replaces: string[] = [];

  for (const entry of entries) {
    const tok = normalizeToken(entry);
    if (tok === null) continue;
    if (tok.sign === "+") adds.push(tok.ext);
    else if (tok.sign === "-") removes.push(tok.ext);
    else replaces.push(tok.ext);
  }

  const hasPrefixed = adds.length > 0 || removes.length > 0;
  const hasBare = replaces.length > 0;

  if (hasPrefixed && hasBare) return { kind: "defaults" }; // ambiguous mix
  if (hasBare) {
    const set = new Set(replaces);
    return set.size > 0 ? toCustomResult(set) : { kind: "defaults" };
  }
  if (hasPrefixed) {
    const set = new Set(DEFAULT_SOURCE_EXT_SET);
    for (const r of removes) set.delete(r); // removes first …
    for (const a of adds) set.add(a); // …then adds (so re-adding a removed extension wins)
    return set.size > 0 ? toCustomResult(set) : { kind: "defaults" };
  }
  return { kind: "defaults" }; // no valid tokens
}

/**
 * Applies a pipe-separated extension string (e.g. `.ts|.js|.py`, the `extensions`
 * field of a custom {@link ExtensionOverrideResult}) as the active override.
 * Tokens are validated and lowercased; if nothing valid remains, the override is
 * cleared (defaults restored).
 */
export function applyExtensionOverride(extensions: string): void {
  const set = new Set<string>();
  for (const raw of extensions.split("|")) {
    const tok = normalizeToken(raw);
    if (tok) set.add(tok.ext);
  }
  activeOverride = set.size > 0 ? set : null;
}

/** Clears any active override and restores the built-in default extensions. */
export function resetExtensionOverride(): void {
  activeOverride = null;
}

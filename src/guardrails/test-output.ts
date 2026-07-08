// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Pure, stateless pattern matching for a TDD workflow loop.
 *
 * `isTestRun` recognises test invocations across the supported ecosystems;
 * `detectTestOutcome` decides pass / fail / unknown from runner output and the
 * process exit code. Nothing is executed and no state is kept.
 */

/* ============================================================================
 * Command classification — is this shell command a test run?
 * ============================================================================ */

/**
 * Regexes marking a command as a test run, grouped by ecosystem. Word
 * boundaries keep signal high: e.g. "npm install" never matches "npm test".
 */
const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  // --- JavaScript / TypeScript ---
  /\bnpm\s+(?:run(?:-script)?\s+)?t(?:est)?\b/, // npm test | npm t | npm run test
  /\b(?:yarn|pnpm|bun)\s+(?:run\s+)?test\b/, // yarn/pnpm/bun test [run]
  /\bnpx\s+(?:vitest|jest|mocha)\b/, // npx <runner>
  /\b(?:jest|vitest|mocha)\b/, // direct runner calls
  /\bnode\b[^\n]*--test\b/, // Node.js native test runner

  // --- Python ---
  /\bpytest\b/, // pytest
  /\bpython\d?(?:\.\d+)?\s+-m\s+(?:pytest|unittest)\b/, // python -m pytest|unittest

  // --- Rust ---
  /\bcargo\s+test\b/, // cargo test

  // --- Go ---
  /\bgo\s+test\b/, // go test

  // --- Java / Kotlin (Maven & Gradle) ---
  // "test" must appear as its own whitespace-delimited phase/goal token, so
  // "mvn install -DskipTests" / "-Dmaven.test.skip" do NOT match.
  /\bmvnw?\b(?:\s+\S+)*\s+(?:integration-test|surefire:test|test)\b/, // mvn(w) [opts] test
  /\bgradlew?\b(?:\s+\S+)*\s+test\b/, // gradle(w) [opts] test

  // --- C# / .NET ---
  /\bdotnet\s+test\b/, // dotnet test

  // --- Ruby (RSpec & Minitest) ---
  /\b(?:bundle\s+exec\s+)?rspec\b/, // [bundle exec] rspec
  /\b(?:bundle\s+exec\s+)?rake\s+test\b/, // [bundle exec] rake test
  /\bruby\b[^\n]*-Itest\b/, // ruby -Itest (Minitest)

  // --- PHP (PHPUnit, Pest, Laravel) ---
  /\bphpunit\b/, // phpunit
  /\bpest\b/, // pest
  /\bphp\s+artisan\s+test\b/, // php artisan test (Laravel)

  // --- Swift ---
  /\bswift\s+test\b/, // swift test

  // --- Dart (Flutter & Dart VM) ---
  /\bflutter\s+test\b/, // flutter test
  /\bdart\s+test\b/, // dart test

  // --- Scala ---
  /\bsbt\b(?:\s+\S+)*\s+test\b/, // sbt test | sbt clean test

  // --- Clojure (Leiningen & clojure CLI) ---
  /\blein\s+test\b/, // lein test
  /\b(?:clj|clojure)\b[^\n]*:test\b/, // clj/clojure with :test alias

  // --- C / C++ (CMake/CTest, autotools) ---
  /\bctest\b/, // ctest
  /\bmake\s+(?:test|check)\b/, // make test | make check

  // --- Haskell ---
  /\bstack\s+test\b/, // stack test
  /\bcabal\s+test\b/, // cabal test

  // --- Elixir ---
  /\bmix\s+test\b/, // mix test

  // --- Erlang (rebar3) ---
  /\brebar3\s+(?:eunit|ct)\b/, // rebar3 eunit | rebar3 ct

  // --- Lua (busted) ---
  /\bbusted\b/, // busted

  // --- R (testthat) ---
  /\bR\s+CMD\s+check\b/, // R CMD check
  /\bRscript\b[^\n]*testthat\b/, // Rscript ... testthat

  // --- Perl (prove / TAP) ---
  /\bprove\b/, // prove

  // --- Zig ---
  /\bzig\s+(?:build\s+)?test\b/, // zig test | zig build test

  // --- Nim ---
  /\bnimble\s+test\b/, // nimble test

  // --- Crystal ---
  /\bcrystal\s+spec\b/, // crystal spec

  // --- OCaml (dune) ---
  /\bdune\s+(?:runtest|test)\b/, // dune runtest | dune test

  // --- Elm ---
  /\belm-test\b/, // elm-test

  // --- Julia ---
  /\bjulia\b[^\n]*\bPkg\.test\b/, // julia ... Pkg.test()

  // --- D ---
  /\bdub\s+test\b/, // dub test

  // --- Solidity (Foundry & Hardhat) ---
  /\bforge\s+test\b/, // forge test (Foundry)
  /\bhardhat\s+test\b/, // hardhat test

  // --- V / Vlang ---
  // Lookbehind excludes "-v test" docker volume mounts from matching.
  /(?<![\w-])v\s+test\b/, // v test

  // --- Gleam ---
  /\bgleam\s+test\b/, // gleam test

  // --- Racket ---
  /\braco\s+test\b/, // raco test

  // --- Objective-C / Objective-C++ (Xcode) ---
  // "test" must be its own action token so "xcodebuild build" never matches.
  /\bxcodebuild\b[^\n]*\btest\b/, // xcodebuild ... test

  // --- PureScript (spago / pulp) ---
  /\bspago\s+test\b/, // spago test
  /\bpulp\s+test\b/, // pulp test

  // --- Idris (Idris 1 & 2) ---
  // Optional trailing "2" covers both idris and idris2; --testpkg is the test action.
  /\bidris2?\s+--testpkg\b/, // idris2 --testpkg | idris --testpkg

  // --- Haxe (munit & hxml test build) ---
  // Requires the test verb so "haxelib install munit" / "haxe build.hxml" don't match.
  /\b(?:haxelib\s+run\s+)?munit\s+test\b/, // munit test | haxelib run munit test
  /\bhaxe\s+test\.hxml\b/, // haxe test.hxml (build file literally named test.hxml)

  // --- Godot / GDScript (GUT & GDUnit4) ---
  // Match the distinctive runner markers, not bare "godot" (a non-test command).
  /\bgut_cmdln\.gd\b/, // GUT runner script
  /\bgdunit4?\b/i, // GDUnit4 addon/CLI token

  // --- Mojo ---
  /\bmojo\s+test\b/, // mojo test
];

/** Returns true when `command` is a test invocation in any supported ecosystem. */
export function isTestRun(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  return TEST_COMMAND_PATTERNS.some((re) => re.test(command));
}

/* ============================================================================
 * Outcome detection — did the test run pass or fail?
 * ============================================================================
 *
 * Resolution rule:
 *   1. Any explicit failure marker in the output => FAILED. These markers are
 *      direct evidence and win even when a wrapper swallowed the exit code
 *      (safest choice for a "don't commit before tests pass" gate).
 *   2. Otherwise, when an exit code is present it is authoritative:
 *      0 => passed, non-zero => failed.
 *   3. With no failure marker and no exit code, an explicit pass marker
 *      => passed; anything else => null (cannot determine).
 */

/** Output substrings that prove at least one test failed. */
const FAIL_PATTERNS: readonly RegExp[] = [
  /[1-9]\d*\s+(?:failed|failures?|errors?)\b/i, // "2 failed", "1 failure", "3 errors"
  /[1-9]\d*\s+failing\b/i, // mocha "2 failing"
  /Failures?:\s*[1-9]\d*/i, // Maven/dotnet "Failures: 2"
  /Errors?:\s*[1-9]\d*/i, // Maven/dotnet "Errors: 1"
  /Failed:\s*[1-9]\d*/i, // dotnet "Failed: 2"
  /test result:\s*FAILED/i, // cargo "test result: FAILED."
  /(?:^|\n)\s*FAILED\s*\(/i, // unittest "FAILED (failures=2)"
  /---\s*FAIL:/, // go/jest "--- FAIL: TestX"
  /(?:^|\n)\s*FAIL\b/i, // go/jest "FAIL" line
  /\bFAILURES?!\b/i, // phpunit "FAILURES!"
  /BUILD\s+FAIL(?:ED|URE)?\b/i, // Maven/Gradle "BUILD FAILURE"
  /Test Run Failed/i, // dotnet "Test Run Failed."
  /Some tests failed/i, // flutter "Some tests failed!"
  /Test Suite\b[^\n]*\bfailed/i, // swift "Test Suite 'X' failed"
  /\*\*\*\s*Test failed/i, // swift "*** Test failed"

  // --- additional ecosystems ---
  /Total\s+\d+,\s*Failed\s+[1-9]\d*/i, // sbt "Failed: Total 5, Failed 1, Errors 0, Passed 4"
  /Test suite\s+\S+:\s*FAIL/i, // cabal/stack "Test suite foo: FAIL"
  /FAIL\s+[1-9]\d*\s*\|/i, // testthat "[ FAIL 1 | WARN 0 | SKIP 0 | PASS 11 ]"
  /Result:\s*FAIL\b/i, // prove "Result: FAIL"
  /\b\d+\/\d+\b[^\n]*FAIL/i, // zig "1/3 test.foo... FAIL"
  /\[FAILED\]/, // nim unittest "[FAILED]"
  /\bTest Failed at\b/i, // julia "Test Failed at /path/runtests.jl:5"

  // --- node:test (Node.js built-in test runner) ---
  // Summary footer emits word-then-count lines ("# fail 1" TAP / "ℹ fail 1"
  // default), distinct from the "N failed" idiom other runners use.
  /(?:^|\n)\s*[#ℹ]\s*fail\s+[1-9]\d*/i, // node:test "# fail 1" / "ℹ fail 1"

  // --- Objective-C / Objective-C++ (xcodebuild) ---
  /\*\*\s*TEST\s+FAILED\s*\*\*/i, // xcodebuild summary "** TEST FAILED **"
];

/** Output substrings that indicate a clean, fully-passing run. */
const PASS_PATTERNS: readonly RegExp[] = [
  /\b\d+\s+passed\b/i, // jest/vitest/pytest "5 passed"
  /\b\d+\s+passing\b/i, // mocha "5 passing"
  /Passed:\s*\d+/i, // dotnet "Passed: 5"
  /test result:\s*ok/i, // cargo "test result: ok."
  /(?:^|\n)\s*ok\b[^\n]*(?:\(cached\)|\b\d+(?:\.\d+)?s\b)/, // go "ok  pkg  0.12s"
  /All tests passed/i, // flutter/dart "All tests passed!"
  /Test Run Successful/i, // dotnet "Test Run Successful."
  /BUILD\s+SUCCESS(?:FUL)?\b/i, // Maven/Gradle "BUILD SUCCESS(FUL)"
  /(?:^|\n)\s*\d+\s+examples?,\s*0\s+failures?/i, // rspec "5 examples, 0 failures"
  /\b\d+\s+failures?,\s*0\s+errors?/i, // minitest "...0 failures, 0 errors"
  /(?:^|\n)\s*Ran\s+\d+\s+tests?\b/i, // unittest "Ran 5 tests"
  /\bOK\s*\(?\s*\d+\s+tests?/i, // phpunit "OK (5 tests, ...)"
  /\bTests?:\s*\d+,\s*Assertions?:\s*\d+/i, // phpunit/pest summary line
  /Executed\s+\d+\s+tests?,\s+with\s+0\s+failures/i, // swift "Executed N tests, with 0 failures"
  /Test Suite\b[^\n]*\bpassed/i, // swift "Test Suite 'X' passed"

  // --- additional ecosystems ---
  /Passed:\s*Total\s+\d+,\s*Failed\s+0,\s*Errors\s+0/i, // sbt "Passed: Total 5, Failed 0, Errors 0, Passed 5"
  /\d+%\s*tests?\s+passed/i, // ctest "100% tests passed"
  /Test suite\s+\S+:\s*PASS/i, // cabal/stack "Test suite foo: PASS"
  /\d+\s+tests?,\s*0\s*failures?/i, // ExUnit/eunit/gleeunit "7 tests, 0 failures"
  /FAIL\s+0\s*\|\s*WARN\s+\d+\s*\|\s*SKIP\s+\d+\s*\|\s*PASS\s+\d+/i, // testthat "[ FAIL 0 | WARN 0 | SKIP 0 | PASS 12 ]"
  /Result:\s*PASS\b/i, // prove "Result: PASS"
  /\d+\s+successes?\s*\/\s*0\s*failures?/i, // busted "3 successes / 0 failures"

  // --- node:test (Node.js built-in test runner) ---
  // Summary footer emits word-then-count lines ("# pass N" TAP / "ℹ pass N"
  // default). No generic "N passed" pattern matches this idiom, and the TAP
  // `ok N` lines carry no inline duration, so without this the runner is
  // undetectable when the exit code is unavailable. Any real failure also emits
  // a `fail [1-9]` line (matched above), so `pass 0` can never mask a failure.
  /(?:^|\n)\s*[#ℹ]\s*pass\s+\d+/i, // node:test "# pass 7" / "ℹ pass 7"

  // --- elm-test ---
  // Distinct from dotnet's "Test Run Successful" (elm-test says "PASSED").
  /TEST\s+RUN\s+PASSED\b/i, // elm-test "TEST RUN PASSED"

  // --- Nim (unittest) ---
  // Pass prints a per-test "[OK] <name>" marker; failure uses "[FAILED]" above.
  /(?:^|\n)\s*\[OK\]\s+\S/i, // nim "[OK] 2 + 2 = 4"

  // --- Objective-C / Objective-C++ (xcodebuild) ---
  /\*\*\s*TEST\s+SUCCEEDED\s*\*\*/i, // xcodebuild summary "** TEST SUCCEEDED **"
];

/** Pass (`true`), fail (`false`), or unknown (`null`) for a test run, from its output and exit code. */
export function detectTestOutcome(output: string, exitCode: number | undefined): boolean | null {
  const text = typeof output === "string" ? output : "";

  // 1. Direct failure evidence always wins.
  if (FAIL_PATTERNS.some((re) => re.test(text))) return false;

  // 2. Otherwise an exit code, when present, is authoritative.
  if (exitCode !== undefined && !Number.isNaN(exitCode)) return exitCode === 0;

  // 3. No code: an explicit pass marker means pass, else we cannot tell.
  if (PASS_PATTERNS.some((re) => re.test(text))) return true;
  return null;
}

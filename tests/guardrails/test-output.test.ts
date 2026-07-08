// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { detectTestOutcome, isTestRun } from "../../src/guardrails/test-output.js";

describe("isTestRun", () => {
  test("detects npm test", () => {
    expect(isTestRun("npm test")).toBe(true);
  });
  test("detects npx vitest", () => {
    expect(isTestRun("npx vitest run src/")).toBe(true);
  });
  test("detects pytest", () => {
    expect(isTestRun("pytest tests/")).toBe(true);
  });
  test("detects go test", () => {
    expect(isTestRun("go test ./...")).toBe(true);
  });
  test("detects cargo test", () => {
    expect(isTestRun("cargo test")).toBe(true);
  });
  test("detects jest", () => {
    expect(isTestRun("npx jest src/utils.test.ts")).toBe(true);
  });
  test("does not match ls", () => {
    expect(isTestRun("ls -la")).toBe(false);
  });
  test("does not match git commands", () => {
    expect(isTestRun("git status")).toBe(false);
  });
  test("does not match npm install", () => {
    expect(isTestRun("npm install")).toBe(false);
  });

  // --- additional ecosystems: command detection ---
  test("detects sbt test", () => {
    expect(isTestRun("sbt test")).toBe(true);
    expect(isTestRun("sbt clean test")).toBe(true);
  });
  test("detects lein/clj test", () => {
    expect(isTestRun("lein test")).toBe(true);
    expect(isTestRun("clj -M:test")).toBe(true);
  });
  test("detects ctest / make test", () => {
    expect(isTestRun("ctest")).toBe(true);
    expect(isTestRun("make test")).toBe(true);
    expect(isTestRun("make check")).toBe(true);
  });
  test("detects stack/cabal test", () => {
    expect(isTestRun("stack test")).toBe(true);
    expect(isTestRun("cabal test")).toBe(true);
  });
  test("detects mix test", () => {
    expect(isTestRun("mix test")).toBe(true);
  });
  test("detects rebar3 eunit/ct", () => {
    expect(isTestRun("rebar3 eunit")).toBe(true);
    expect(isTestRun("rebar3 ct")).toBe(true);
  });
  test("detects busted", () => {
    expect(isTestRun("busted spec/")).toBe(true);
  });
  test("detects R CMD check / testthat", () => {
    expect(isTestRun("R CMD check pkg")).toBe(true);
    expect(isTestRun("Rscript -e \"testthat::test_check('pkg')\"")).toBe(true);
  });
  test("detects prove", () => {
    expect(isTestRun("prove -l t/")).toBe(true);
  });
  test("detects zig test", () => {
    expect(isTestRun("zig build test")).toBe(true);
    expect(isTestRun("zig test src/main.zig")).toBe(true);
  });
  test("detects nimble test", () => {
    expect(isTestRun("nimble test")).toBe(true);
  });
  test("detects crystal spec", () => {
    expect(isTestRun("crystal spec")).toBe(true);
  });
  test("detects dune runtest", () => {
    expect(isTestRun("dune runtest")).toBe(true);
    expect(isTestRun("dune test")).toBe(true);
  });
  test("detects elm-test", () => {
    expect(isTestRun("elm-test")).toBe(true);
    expect(isTestRun("npx elm-test")).toBe(true);
  });
  test("detects julia Pkg.test", () => {
    expect(isTestRun("julia -e 'using Pkg; Pkg.test()'")).toBe(true);
  });
  test("detects dub test", () => {
    expect(isTestRun("dub test")).toBe(true);
  });
  test("detects forge/hardhat test", () => {
    expect(isTestRun("forge test")).toBe(true);
    expect(isTestRun("hardhat test")).toBe(true);
    expect(isTestRun("npx hardhat test")).toBe(true);
  });
  test("detects v test", () => {
    expect(isTestRun("v test")).toBe(true);
    expect(isTestRun("v test .")).toBe(true);
  });
  test("detects gleam test", () => {
    expect(isTestRun("gleam test")).toBe(true);
  });
  test("detects raco test", () => {
    expect(isTestRun("raco test")).toBe(true);
    expect(isTestRun("raco test file.rkt")).toBe(true);
  });
  test("detects xcodebuild test", () => {
    expect(isTestRun("xcodebuild test")).toBe(true);
    expect(isTestRun("xcodebuild -scheme App test")).toBe(true);
    expect(
      isTestRun("xcodebuild -workspace App.xcworkspace -scheme App -destination 'platform=iOS Simulator' test"),
    ).toBe(true);
  });
  test("detects spago/pulp test", () => {
    expect(isTestRun("spago test")).toBe(true);
    expect(isTestRun("pulp test")).toBe(true);
    expect(isTestRun("spago test -a")).toBe(true);
  });
  test("detects idris --testpkg", () => {
    expect(isTestRun("idris2 --testpkg test.ipkg")).toBe(true);
    expect(isTestRun("idris --testpkg test.ipkg")).toBe(true);
  });
  test("detects haxe test.hxml / munit", () => {
    expect(isTestRun("haxe test.hxml")).toBe(true);
    expect(isTestRun("haxe test.hxml -D ci")).toBe(true);
    expect(isTestRun("haxelib run munit test")).toBe(true);
    expect(isTestRun("munit test")).toBe(true);
  });
  test("detects godot GUT/GDUnit4", () => {
    expect(isTestRun("godot -s gut_cmdln.gd")).toBe(true);
    expect(isTestRun("godot -d -s res://addons/gut/gut_cmdln.gd")).toBe(true);
    expect(isTestRun("godot -s res://addons/gdunit4/cmd/CLI.gd")).toBe(true);
  });
  test("detects mojo test", () => {
    expect(isTestRun("mojo test")).toBe(true);
    expect(isTestRun("mojo test src/")).toBe(true);
  });

  // --- negative cases (must not false-positive) ---
  test("does not match sbt compile", () => {
    expect(isTestRun("sbt compile")).toBe(false);
  });
  test("does not match cmake build", () => {
    expect(isTestRun("cmake ..")).toBe(false);
  });
  test("does not match make all", () => {
    expect(isTestRun("make all")).toBe(false);
  });
  test("does not match stack build", () => {
    expect(isTestRun("stack build")).toBe(false);
  });
  test("does not match mix compile", () => {
    expect(isTestRun("mix compile")).toBe(false);
  });
  test("does not match rebar3 compile", () => {
    expect(isTestRun("rebar3 compile")).toBe(false);
  });
  test("does not match perl script", () => {
    expect(isTestRun("perl script.pl")).toBe(false);
  });
  test("does not match R CMD build", () => {
    expect(isTestRun("R CMD build pkg")).toBe(false);
  });
  test("does not match zig build", () => {
    expect(isTestRun("zig build")).toBe(false);
  });
  test("does not match crystal build", () => {
    expect(isTestRun("crystal build src/app.cr")).toBe(false);
  });
  test("does not match dune build", () => {
    expect(isTestRun("dune build")).toBe(false);
  });
  test("does not match elm make", () => {
    expect(isTestRun("elm make src/Main.elm")).toBe(false);
  });
  test("does not match julia script", () => {
    expect(isTestRun("julia script.jl")).toBe(false);
  });
  test("does not match dub build", () => {
    expect(isTestRun("dub build")).toBe(false);
  });
  test("does not match forge build", () => {
    expect(isTestRun("forge build")).toBe(false);
  });
  test("does not match v run", () => {
    expect(isTestRun("v run app.v")).toBe(false);
  });
  test("does not match docker -v volume mount", () => {
    expect(isTestRun("docker run -v test:/data img")).toBe(false);
  });
  test("does not match gleam build", () => {
    expect(isTestRun("gleam build")).toBe(false);
  });
  test("does not match raco make", () => {
    expect(isTestRun("raco make file.rkt")).toBe(false);
  });
  test("does not match xcodebuild build", () => {
    expect(isTestRun("xcodebuild build")).toBe(false);
    expect(isTestRun("xcodebuild -scheme App build")).toBe(false);
  });
  test("does not match spago/pulp build", () => {
    expect(isTestRun("spago build")).toBe(false);
    expect(isTestRun("pulp build")).toBe(false);
  });
  test("does not match idris2 --build", () => {
    expect(isTestRun("idris2 --build app.ipkg")).toBe(false);
    expect(isTestRun("idris2 main.idr")).toBe(false);
  });
  test("does not match haxe build.hxml", () => {
    expect(isTestRun("haxe build.hxml")).toBe(false);
    expect(isTestRun("haxe compile.hxml")).toBe(false);
    expect(isTestRun("haxelib install munit")).toBe(false);
  });
  test("does not match godot --headless", () => {
    expect(isTestRun("godot --headless")).toBe(false);
    expect(isTestRun("godot --export-debug")).toBe(false);
    expect(isTestRun("godot")).toBe(false);
  });
  test("does not match mojo build", () => {
    expect(isTestRun("mojo build")).toBe(false);
    expect(isTestRun("mojo run app.mojo")).toBe(false);
  });
});

describe("detectTestOutcome", () => {
  test("detects vitest pass", () => {
    expect(detectTestOutcome("Tests  1 passed", 0)).toBe(true);
  });
  test("detects vitest fail", () => {
    expect(detectTestOutcome("Tests  1 failed", 1)).toBe(false);
  });
  test("detects pytest pass", () => {
    expect(detectTestOutcome("1 passed in 0.5s", 0)).toBe(true);
  });
  test("detects pytest fail", () => {
    expect(detectTestOutcome("1 failed, 0 passed", 1)).toBe(false);
  });
  test("detects jest pass", () => {
    expect(detectTestOutcome("Tests:  1 passed, 1 total", 0)).toBe(true);
  });
  test("detects go test pass", () => {
    expect(detectTestOutcome("ok  \tgithub.com/user/pkg\t0.5s", 0)).toBe(true);
  });
  test("detects go test fail via FAIL prefix", () => {
    expect(detectTestOutcome("FAIL\tgithub.com/user/pkg", 1)).toBe(false);
  });
  test("uses exit code as fallback", () => {
    expect(detectTestOutcome("some unknown output", 0)).toBe(true);
    expect(detectTestOutcome("some unknown output", 1)).toBe(false);
  });
  test("returns null for ambiguous output with no exit code", () => {
    expect(detectTestOutcome("some unknown output", undefined)).toBeNull();
  });

  test("does not match bare 'passed' without numeric prefix", () => {
    expect(detectTestOutcome("All checks passed", 0)).toBe(true);
    expect(detectTestOutcome("All checks passed", undefined)).toBeNull();
    // The pass-detection should rely on exit code, not bare "passed"
  });

  // --- node:test (Node.js built-in test runner) ---
  // Its summary uses the word-then-count idiom ("# pass N" / "ℹ pass N") that no
  // generic "N passed" pattern matches, and the TAP/default `ok`/`✖` lines carry
  // no inline duration, so it was previously undetectable without an exit code.
  test("detects node:test pass from output (default reporter, no exit code)", () => {
    expect(detectTestOutcome("ℹ pass 7", undefined)).toBe(true);
  });
  test("detects node:test pass from output (TAP reporter, no exit code)", () => {
    expect(detectTestOutcome("# pass 7", undefined)).toBe(true);
  });
  test("detects node:test fail from output (default reporter, no exit code)", () => {
    expect(detectTestOutcome("ℹ fail 1", undefined)).toBe(false);
  });
  test("detects node:test fail from output (TAP reporter, no exit code)", () => {
    expect(detectTestOutcome("# fail 1", undefined)).toBe(false);
  });

  // --- elm-test ---
  test("detects elm-test pass from output (no exit code)", () => {
    expect(detectTestOutcome("TEST RUN PASSED", undefined)).toBe(true);
  });
  test("detects elm-test fail from output (no exit code)", () => {
    expect(detectTestOutcome("TEST RUN FAILED", undefined)).toBe(false);
  });

  // --- Nim (unittest) ---
  // Pass prints a per-test "[OK] <name>" marker; failure already matched by the
  // existing [FAILED] pattern.
  test("detects Nim unittest pass from output (no exit code)", () => {
    expect(detectTestOutcome("[OK] 2 + 2 = 4", undefined)).toBe(true);
  });

  // --- additional ecosystems: outcome detection ---
  // Pass/fail cases use `exitCode: undefined` so the result is decided purely by
  // the runner's output signal (exercising the pattern itself, not the exit
  // code). Ecosystems with no distinctive text signal keep an exit code.
  test("detects sbt pass from output", () => {
    expect(detectTestOutcome("[info] Passed: Total 5, Failed 0, Errors 0, Passed 5", undefined)).toBe(true);
  });
  test("detects sbt fail from output", () => {
    expect(detectTestOutcome("[error] Failed: Total 5, Failed 1, Errors 0, Passed 4", undefined)).toBe(false);
  });
  test("detects ctest pass from output", () => {
    expect(detectTestOutcome("100% tests passed, 0 tests failed out of 3", undefined)).toBe(true);
  });
  test("detects ctest fail from output", () => {
    expect(detectTestOutcome("The following tests FAILED:\n\t1 - Foo (Failed)", undefined)).toBe(false);
  });
  test("detects Catch2 fail from output", () => {
    expect(detectTestOutcome("test cases: 3 | 1 failed | 2 passed", undefined)).toBe(false);
  });
  test("detects cabal pass from output", () => {
    expect(detectTestOutcome("Test suite foo: PASS", undefined)).toBe(true);
  });
  test("detects cabal fail from output", () => {
    expect(detectTestOutcome("Test suite foo: FAIL", undefined)).toBe(false);
  });
  test("detects ExUnit pass from output", () => {
    expect(detectTestOutcome("7 tests, 0 failures", undefined)).toBe(true);
  });
  test("detects ExUnit fail from output", () => {
    expect(detectTestOutcome("7 tests, 1 failure", undefined)).toBe(false);
  });
  test("detects eunit pass from output", () => {
    expect(detectTestOutcome("5 tests, 0 failures", undefined)).toBe(true);
  });
  test("detects busted pass from output", () => {
    expect(detectTestOutcome("3 successes / 0 failures / 0 errors / 0 pending", undefined)).toBe(true);
  });
  test("detects busted fail from output", () => {
    expect(detectTestOutcome("2 successes / 1 failure / 0 errors", undefined)).toBe(false);
  });
  test("detects testthat pass from output", () => {
    expect(detectTestOutcome("[ FAIL 0 | WARN 0 | SKIP 0 | PASS 12 ]", undefined)).toBe(true);
  });
  test("detects testthat fail from output", () => {
    expect(detectTestOutcome("[ FAIL 1 | WARN 0 | SKIP 0 | PASS 11 ]", undefined)).toBe(false);
  });
  test("detects prove pass from output", () => {
    expect(detectTestOutcome("Files=3, Tests=15\nResult: PASS", undefined)).toBe(true);
  });
  test("detects prove fail from output", () => {
    expect(detectTestOutcome("Files=3, Tests=15\nResult: FAIL", undefined)).toBe(false);
  });
  test("detects zig fail from output", () => {
    expect(detectTestOutcome("1/3 test.foo... FAIL", undefined)).toBe(false);
  });
  test("detects nim unittest fail from output", () => {
    expect(detectTestOutcome("[OK] test1\n[FAILED] test2", undefined)).toBe(false);
  });
  test("detects julia fail from output", () => {
    expect(detectTestOutcome("Test Failed at /path/runtests.jl:5", undefined)).toBe(false);
  });
  test("detects crystal spec pass from output", () => {
    expect(detectTestOutcome("5 examples, 0 failures, 0 errors", undefined)).toBe(true);
  });
  test("detects crystal spec fail from output", () => {
    expect(detectTestOutcome("5 examples, 1 failure", undefined)).toBe(false);
  });
  test("detects clojure.test pass from output", () => {
    expect(detectTestOutcome("Ran 3 tests containing 12 assertions.\n0 failures, 0 errors.", undefined)).toBe(true);
  });
  test("detects clojure.test fail from output", () => {
    expect(detectTestOutcome("Ran 3 tests containing 12 assertions.\n1 failures, 0 errors.", undefined)).toBe(false);
  });
  test("detects elm-test fail from output", () => {
    expect(detectTestOutcome("TEST RUN FAILED", undefined)).toBe(false);
  });
  test("detects forge test pass from output", () => {
    expect(detectTestOutcome("Test result: OK. 1 passed; 0 failed", undefined)).toBe(true);
  });
  test("detects forge test fail from output", () => {
    expect(detectTestOutcome("Test result: FAILED. 0 passed; 1 failed", undefined)).toBe(false);
  });
  test("detects hardhat pass from output", () => {
    expect(detectTestOutcome("  1 passing (52ms)", undefined)).toBe(true);
  });

  // --- outcome via exit code (no distinctive text signal) ---
  test("elm-test pass via exit code", () => {
    expect(detectTestOutcome("TEST RUN PASSED", 0)).toBe(true);
  });
  test("julia pass via exit code", () => {
    expect(detectTestOutcome("Test Summary: | Pass  Fail  Total", 0)).toBe(true);
  });
  test("zig pass via exit code", () => {
    expect(detectTestOutcome("3/3 test.foo... OK", 0)).toBe(true);
  });
  test("nim pass via exit code", () => {
    expect(detectTestOutcome("[OK] test1", 0)).toBe(true);
  });
  test("dune outcome via exit code", () => {
    expect(detectTestOutcome("Running tests...", 0)).toBe(true);
    expect(detectTestOutcome('File "test.ml", line 1: error', 1)).toBe(false);
  });
  test("dub outcome via exit code", () => {
    expect(detectTestOutcome('Performing "unittest" build', 0)).toBe(true);
    expect(detectTestOutcome("core.exception.AssertError@x.d: failure", 1)).toBe(false);
  });
  test("v outcome via exit code", () => {
    expect(detectTestOutcome("testing took 1.2ms", 0)).toBe(true);
    expect(detectTestOutcome("test.v:5: error", 1)).toBe(false);
  });
  test("raco outcome via exit code", () => {
    expect(detectTestOutcome('raco test: ("file.rkt")', 0)).toBe(true);
    expect(detectTestOutcome('raco test: ("file.rkt")\ncheck-equal? failed', 1)).toBe(false);
  });
  test("detects xcodebuild pass from output", () => {
    expect(detectTestOutcome("** TEST SUCCEEDED **", undefined)).toBe(true);
  });
  test("detects xcodebuild fail from output", () => {
    expect(detectTestOutcome("** TEST FAILED **", undefined)).toBe(false);
    // Failure marker wins even when a wrapper reports exit 0.
    expect(detectTestOutcome("** TEST FAILED **", 0)).toBe(false);
  });

  // --- outcome via exit code (no distinctive text signal) ---
  test("purescript outcome via exit code", () => {
    expect(detectTestOutcome("spago test\nCompiling Test.Main", 0)).toBe(true);
    expect(detectTestOutcome("spago test\nCompiling Test.Main", 1)).toBe(false);
    expect(detectTestOutcome("spago test\nCompiling Test.Main", undefined)).toBeNull();
  });
  test("idris outcome via exit code", () => {
    expect(detectTestOutcome("idris2 --testpkg\nBuilding tests", 0)).toBe(true);
    expect(detectTestOutcome("idris2 --testpkg\nBuilding tests", 1)).toBe(false);
    expect(detectTestOutcome("idris2 --testpkg\nBuilding tests", undefined)).toBeNull();
  });
  test("haxe outcome via exit code", () => {
    expect(detectTestOutcome("haxe test.hxml\nBuild complete", 0)).toBe(true);
    expect(detectTestOutcome("haxe test.hxml\nBuild complete", 1)).toBe(false);
    expect(detectTestOutcome("haxe test.hxml\nBuild complete", undefined)).toBeNull();
  });
  test("godot outcome via exit code", () => {
    expect(detectTestOutcome("godot -d -s gut_cmdln.gd\nRunning tests", 0)).toBe(true);
    expect(detectTestOutcome("godot -d -s gut_cmdln.gd\nRunning tests", 1)).toBe(false);
    expect(detectTestOutcome("godot -d -s gut_cmdln.gd\nRunning tests", undefined)).toBeNull();
  });
  test("mojo outcome via exit code", () => {
    expect(detectTestOutcome("mojo test\nRunning tests", 0)).toBe(true);
    expect(detectTestOutcome("mojo test\nRunning tests", 1)).toBe(false);
    expect(detectTestOutcome("mojo test\nRunning tests", undefined)).toBeNull();
  });
});

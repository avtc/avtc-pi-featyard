// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { resolve as pathResolve } from "node:path";

/**
 * Command decomposition for parallel-work-guardrail.
 *
 * Splits a compound shell command into individual subcommands by separating
 * on `&&`, `||`, `;`, `|`, and `&`, while respecting quoting, subshells,
 * command substitution, and escapes.
 */

/**
 * Split a compound shell command into individual subcommands.
 * Returns trimmed, non-empty subcommand strings.
 */
export function decompose(input: string): string[] {
  const out: string[] = [];
  splitIntoPeel(input, WRAPPER_DEPTH_ROOT, out);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

export interface Subcommand {
  command: string;
  /** Effective cwd after applying any preceding cd commands. null if unchanged from base. */
  effectiveCwd: string | null;
}

export const CD_UNRESOLVABLE = "__CD_UNRESOLVABLE__";

/**
 * Extract the target directory from a cd command.
 * Handles quoted paths and tilde expansion.
 * Returns null if the command is not a cd command.
 * Returns CD_UNRESOLVABLE if the cd target cannot be resolved (e.g. cd -).
 */
export function extractCdTarget(cmd: string): string | null {
  const trimmed = cmd.trim();
  // Match: cd <path> / Set-Location <path> (PowerShell, case-insensitive) / chdir <path>
  // PowerShell -Path/-LiteralPath parameter prefix is stripped below.
  const match = trimmed.match(/^(?:cd|set-location|chdir)\s+(.+)$/i);
  if (!match) return null;
  let target = match[1]?.trim();
  // PowerShell explicit path parameter: Set-Location -Path <path>
  target = target.replace(/^-(?:Literal)?Path\s+/i, "");
  // Remove surrounding quotes
  if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1);
  }
  // Tilde expansion
  if (target === "~" || target.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    target = target === "~" ? home : home + target.slice(1);
  }
  // cd - means previous directory — we can't resolve this
  if (target === "-") return CD_UNRESOLVABLE;
  // Shell variables ($VAR or ${VAR}) cannot be expanded — treat as unresolvable
  if (/\$\{?\w/.test(target)) return CD_UNRESOLVABLE;
  return target;
}

/**
 * Split a compound shell command into subcommands with effective cwd tracking.
 * Tracks cd commands across subcommands to determine the working directory
 * each subcommand would execute in, relative to the base cwd.
 */
const normalizePath = (p: string) => p.replace(/\\/g, "/");

export function decomposeWithCwd(input: string, baseCwd: string): Subcommand[] {
  const raw = decompose(input);
  let currentCwd: string | null = null; // null means unchanged from baseCwd
  const result: Subcommand[] = [];

  for (const cmd of raw) {
    const cdTarget = extractCdTarget(cmd);
    if (cdTarget === CD_UNRESOLVABLE) {
      // cd - or other unresolvable cd — reset to unknown (null)
      currentCwd = null;
      continue;
    }
    if (cdTarget !== null) {
      // cd command — update tracked cwd using path.resolve for proper normalization
      const base = currentCwd ?? normalizePath(baseCwd);
      currentCwd = normalizePath(pathResolve(base, cdTarget));
      // cd itself is not a disruptive command — skip adding to results
      continue;
    }
    result.push({ command: cmd, effectiveCwd: currentCwd });
  }

  return result;
}

/**
 * Shell-wrapper peeling (powershell-era bypass hardening).
 *
 * A fragment like `powershell -Command "git push"` would never match the
 * `^git`-anchored guard patterns, so recognized wrapper invocations are
 * decomposed into their payload commands and checked like any other
 * subcommand. Wrappers whose payload cannot be inspected (`-File`, stdin,
 * interactive) are kept as-is.
 */
const MAX_WRAPPER_DEPTH = 4;
/** Depth value for the initial (non-wrapped) decomposition pass. */
const WRAPPER_DEPTH_ROOT = 0;

/** Strip one layer of matching surrounding quotes ("x" / 'x' → x). */
function stripOneQuoteLayer(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return s;
}

/** Split into fragments, then recursively peel each wrapper fragment into `out`. */
function splitIntoPeel(input: string, depth: number, out: string[]): void {
  const frags: string[] = [];
  splitInto(input, frags);
  for (const f of frags) {
    const t = f.trim();
    if (t) peelFragment(t, depth, out);
  }
}

/** Peel one shell-wrapper fragment; pushes resulting subcommand fragments into `out`. */
function peelFragment(frag: string, depth: number, out: string[]): void {
  if (depth >= MAX_WRAPPER_DEPTH) {
    out.push(frag);
    return;
  }

  // PowerShell family: powershell / pwsh (.exe) — scan for the first command-bearing token
  let m = frag.match(/^(?:powershell|pwsh)(?:\.exe)?\s+([\s\S]+)$/i);
  if (m) {
    const rest = m[1] ?? "";
    // -EncodedCommand <base64 UTF-16LE> — decode to recover the payload
    const enc = rest.match(/(?:^|\s)-EncodedCommand\s+(\S+)/i);
    if (enc?.[1]) {
      try {
        const decoded = Buffer.from(enc[1], "base64").toString("utf16le");
        splitIntoPeel(decoded, depth + 1, out);
        return;
      } catch {
        out.push(frag); // undecodable — keep the wrapper visible to any pattern that wants it
        return;
      }
    }
    // -Command / -c <payload> — leading no-arg flags (-NoProfile, …) are skipped naturally
    const cmdTok = rest.match(/(?:^|\s)-(?:Command|c)\s+([\s\S]+)$/i);
    if (cmdTok?.[1] !== undefined) {
      splitIntoPeel(stripOneQuoteLayer(cmdTok[1]), depth + 1, out);
      return;
    }
    out.push(frag); // -File / interactive / stdin — payload not inspectable
    return;
  }

  // cmd.exe: /c or /k followed by the command line
  m = frag.match(/^cmd(?:\.exe)?\s+\/[ck]\s+([\s\S]+)$/i);
  if (m?.[1] !== undefined) {
    splitIntoPeel(stripOneQuoteLayer(m[1]), depth + 1, out);
    return;
  }

  // POSIX shells: bash / sh / zsh / dash / ksh with -c / -lc <payload>
  m = frag.match(/^(?:bash|sh|zsh|dash|ksh)(?:\.exe)?\s+([\s\S]+)$/);
  if (m) {
    const cTok = m[1]?.match(/(?:^|\s)-(?:lc|c)\s+([\s\S]+)$/);
    if (cTok?.[1] !== undefined) {
      splitIntoPeel(stripOneQuoteLayer(cTok[1]), depth + 1, out);
      return;
    }
    out.push(frag); // script path / interactive
    return;
  }

  out.push(frag);
}

/**
 * Recursive splitter. Appends subcommand fragments into `out`.
 */
function splitInto(input: string, out: string[]): void {
  let buf = "";
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Single-quoted string — no escaping inside
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < input.length && input[i] !== "'") {
        buf += input[i];
        i++;
      }
      if (i < input.length) {
        buf += input[i];
        i++;
      }
      continue;
    }

    // Double-quoted string — handles \" escapes
    if (ch === '"') {
      buf += ch;
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          buf += input[i] + input[i + 1];
          i += 2;
          continue;
        }
        buf += input[i];
        i++;
      }
      if (i < input.length) {
        buf += input[i];
        i++;
      }
      continue;
    }

    // Backslash escape — skip next character
    if (ch === "\\" && i + 1 < input.length) {
      buf += ch + input[i + 1];
      i += 2;
      continue;
    }

    // Command substitution $(...)
    if (ch === "$" && i + 1 < input.length && input[i + 1] === "(") {
      let depth = 1;
      const start = i;
      i += 2; // skip $(
      while (i < input.length && depth > 0) {
        if (input[i] === "(") depth++;
        if (input[i] === ")") depth--;
        i++;
      }
      buf += input.slice(start, i);
      continue;
    }

    // Backtick command substitution `...`
    if (ch === "`") {
      const start = i;
      i++;
      while (i < input.length && input[i] !== "`") {
        if (input[i] === "\\" && i + 1 < input.length) i++; // skip escaped char
        i++;
      }
      if (i < input.length) i++; // skip closing backtick
      buf += input.slice(start, i);
      continue;
    }

    // Subshell (...)
    if (ch === "(") {
      // Find matching closing paren, respecting nesting and quoting
      let depth = 1;
      i++;
      let inner = "";
      while (i < input.length && depth > 0) {
        if (input[i] === "'") {
          inner += input[i];
          i++;
          while (i < input.length && input[i] !== "'") {
            inner += input[i];
            i++;
          }
          if (i < input.length) {
            inner += input[i];
            i++;
          }
          continue;
        }
        if (input[i] === '"') {
          inner += input[i];
          i++;
          while (i < input.length && input[i] !== '"') {
            if (input[i] === "\\" && i + 1 < input.length) {
              inner += input[i] + input[i + 1];
              i += 2;
              continue;
            }
            inner += input[i];
            i++;
          }
          if (i < input.length) {
            inner += input[i];
            i++;
          }
          continue;
        }
        if (input[i] === "(") depth++;
        if (input[i] === ")") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        if (depth > 0) {
          inner += input[i];
          i++;
        }
      }
      // Recursively split the inner content
      splitInto(inner, out);
      continue;
    }

    // Newline / CRLF → semicolon
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && i + 1 < input.length && input[i + 1] === "\n") {
        i += 2;
      } else {
        i++;
      }
      out.push(buf);
      buf = "";
      continue;
    }

    // Multi-char separators: &&, ||
    if (ch === "&" && i + 1 < input.length && input[i + 1] === "&") {
      out.push(buf);
      buf = "";
      i += 2;
      continue;
    }
    if (ch === "|" && i + 1 < input.length && input[i + 1] === "|") {
      out.push(buf);
      buf = "";
      i += 2;
      continue;
    }

    // Single-char separators: ;, |, &
    if (ch === ";") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (ch === "|") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (ch === "&") {
      // Background operator — treat as separator, discard the & itself
      out.push(buf);
      buf = "";
      i++;
      continue;
    }

    // Regular character
    buf += ch;
    i++;
  }

  if (buf.trim() !== "") {
    out.push(buf);
  }
}

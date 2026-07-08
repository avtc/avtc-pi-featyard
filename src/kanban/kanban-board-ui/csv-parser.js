// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * RFC 4180 CSV parser for single-column extraction.
 *
 * Exposed globally as `parseCSV` in browser environments.
 * Also exportable for Node.js test usage.
 */

((root, factory) => {
  if (typeof module === "object" && module.exports) {
    // Node.js / CommonJS
    module.exports = factory();
  } else {
    // Browser — attach to global scope
    root.parseCSV = factory();
  }
})(typeof self !== "undefined" ? self : globalThis, () => {
  /**
   * Parse single-column CSV text into an array of description strings.
   * Handles RFC 4180 quoted fields (embedded newlines, commas, escaped "").
   * Graceful on malformed input: unterminated quoted fields are returned as-is
   * rather than throwing, which is reasonable for user-uploaded CSVs.
   */
  return function parseCSV(text) {
    if (!text) return [];
    const rows = [];
    let i = 0;
    while (i < text.length) {
      const fields = [];
      while (i < text.length) {
        if (text[i] === '"') {
          // Quoted field
          i++;
          let value = "";
          while (i < text.length) {
            if (text[i] === '"') {
              if (text[i + 1] === '"') {
                value += '"';
                i += 2;
              } else {
                i++;
                break;
              }
            } else {
              value += text[i];
              i++;
            }
          }
          fields.push(value);
          if (text[i] === ",") {
            i++;
          } else break;
        } else {
          // Unquoted field — read until comma or newline
          let value = "";
          while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
            if (text[i] === '"' && text[i + 1] === '"') {
              value += '"';
              i += 2;
            } else {
              value += text[i];
              i++;
            }
          }
          fields.push(value);
          if (text[i] === ",") {
            i++;
          } else break;
        }
      }
      rows.push(fields[0] ?? "");
      // Skip newline
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
    }
    return rows;
  };
});

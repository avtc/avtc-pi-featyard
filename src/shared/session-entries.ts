// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { CustomEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";

/**
 * Walk the session branch in reverse and return the data from the latest
 * custom entry matching `customType`, or `undefined` if not found.
 */
export function findLatestCustomEntry<T>(ctx: ExtensionContext, customType: string): T | undefined {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && (entry as CustomEntry).customType === customType) {
        return (entry as CustomEntry<T>).data as T | undefined;
      }
    }
  } catch (err) {
    log.warn(`Failed to walk session branch for '${customType}': ${err instanceof Error ? err.message : err}`);
  }
  return undefined;
}

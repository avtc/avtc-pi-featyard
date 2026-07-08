// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * UI helper functions for workflow-monitor.
 */

import { getActiveFeatureSlug } from "../shared/workflow-refs.js";
import { withCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import { getLastMessage, withAttention } from "../snippets/vendored/subscribe-to-notifications.js";

type SelectOption<T extends string> = { label: string; value: T };

export async function selectValue<T extends string>(title: string, options: SelectOption<T>[]): Promise<T> {
  const guard = globalThis.__piCtx;
  const ui = guard?.ui;
  if (!ui?.select) {
    // No UI available — return first option as default
    return (options[0]?.value ?? "cancel") as T;
  }
  const slug = getActiveFeatureSlug();
  const labels = options.map((o) => o.label);
  const detail = [title, slug, getLastMessage()].filter(Boolean).join(" • ");
  const pickedLabel = await withAttention("workflow", detail, () => withCoordinator(() => ui.select(title, labels)));
  const picked = options.find((o) => o.label === pickedLabel);
  return (picked?.value ?? "cancel") as T;
}

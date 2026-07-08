// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SubagentPromptTransformer = (
  systemPrompt: string,
  context: {
    agentName: string;
    task?: string;
    isFork: boolean;
  },
) => string | Promise<string>;
export type SubagentModelResolver = (args: {
  agentName: string;
  explicitModel: string | undefined;
}) => string | undefined;

/** Pass as `addPromptTransformer` when no prompt-transformer hook is needed. */
export const NO_SUBAGENT_PROMPT_TRANSFORMER: SubagentPromptTransformer | null = null;
/** Pass as `addModelResolver` when no model-resolver hook is needed. */
export const NO_SUBAGENT_MODEL_RESOLVER: SubagentModelResolver | null = null;
/** Pass as `addSkillPaths` when no extra skill paths are needed. */
export const NO_SUBAGENT_SKILL_PATHS: string[] | null = null;
/** Pass as `addAgentsPaths` when no extra agents paths are needed. */
export const NO_SUBAGENT_AGENTS_PATHS: string[] | null = null;

/** API object emitted on the `pi-subagent:ready` event, exposing registration hooks. */
interface SubagentReadyApi {
  addPromptTransformer: (transformer: SubagentPromptTransformer) => void;
  addModelResolver: (resolver: SubagentModelResolver) => void;
  addSkillPaths: (paths: string[]) => void;
  addAgentsPaths: (paths: string[], extensionName: string) => void;
}

/**
 * Subscribe to pi-subagent:ready and register hooks.
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 * Copy this file into your consumer's src/snippets/vendored/ directory verbatim — no changes needed.
 */
export function subscribeToSubagent(
  pi: ExtensionAPI,
  addPromptTransformer: SubagentPromptTransformer | null,
  addModelResolver: SubagentModelResolver | null,
  addSkillPaths: string[] | null,
  addAgentsPaths: string[] | null,
  extensionName: string,
): void {
  const unsubs: Array<() => void> = [];

  // On session_shutdown (fires before reload): clean pi.events.on listeners
  pi.on("session_shutdown", () => {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
  });

  // Register :ready listener
  unsubs.push(
    pi.events.on("pi-subagent:ready", (data) => {
      const api = data as SubagentReadyApi;
      if (addPromptTransformer) api.addPromptTransformer(addPromptTransformer);
      if (addModelResolver) api.addModelResolver(addModelResolver);
      if (addSkillPaths) api.addSkillPaths(addSkillPaths);
      if (addAgentsPaths) api.addAgentsPaths(addAgentsPaths, extensionName);
    }),
  );
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * input event router — detect feature-flow skill invocations and route them to
 * the right domain action: feature activation, phase pointer advance, or review
 * loop counter increment.
 *
 * Explicit skill invocation is respected: jumping forward sets the phase pointer
 * (jumped phases fold to done via derivation). Recovery from an unintended jump
 * is via ff-reset or invoking another skill. Injected followUp messages
 * (event.source === "extension") are skipped so they don't re-trigger tracking.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.js";
import { syncEnvVarsFromState } from "../../phases/env-sync.js";
import type { Phase } from "../../phases/phase-progression.js";
import { parseSkillName } from "../../phases/phase-progression.js";
import { applyModelOverride } from "../../phases/phase-transitions.js";
import { expandSkillCommand } from "../../prompts/skill-block-builder.js";
import { startReviewIteration } from "../../review/review-counter.js";
import {
  NO_AGENT_NAME,
  NO_FEATURE_STATE_OVERRIDE,
  resolveLoopIndex,
  substituteTemplates,
} from "../../shared/workflow-refs.js";
import { activateFromDesignSkill, activateFromPlanSkill } from "../../state/feature-activation.js";
import type { FeatureSession } from "../../state/feature-session.js";
import { featureSlugFromDesignDoc, featureSlugFromPlanDoc } from "../../state/feature-state.js";
import { persistState } from "../../state/state-persistence.js";
import { NO_FEATURE_STATE, updateWidget } from "../../ui/feature-flow-widget.js";

export function registerInput(pi: ExtensionAPI, handler: FeatureSession): void {
  pi.on("input", async (event, ctx: ExtensionContext) => {
    if (event.source === "extension") return;
    const text = event.text;

    /** Helper: track input text, persist, and apply model override if phase advanced */
    async function processInputText(): Promise<boolean> {
      const changed = handler.processSkillInput(text);
      if (changed) {
        persistState(pi, handler);
        updateWidget(handler, NO_FEATURE_STATE);
        // Phase advanced — apply model override
        const phaseAfter = handler.getWorkflowState()?.currentPhase;
        if (phaseAfter) {
          await applyModelOverride(pi, ctx, phaseAfter, resolveLoopIndex(phaseAfter));
        }
      }
      return changed;
    }

    /**
     * Finalize this input: apply tracking side-effects, then take over expansion of
     * our own skills. pi's _expandSkillCommand would otherwise wrap our skills with a
     * generic "References are relative to <skillDir>" line — misleading for our skills,
     * which reference project-root paths (docs/, .ff/), never skill-relative ones.
     * Transforming to the already-expanded <skill> block (with {{PI_FF_*}} placeholders
     * substituted) makes pi's _expandSkillCommand and expandPromptTemplate no-ops
     * (the text no longer starts with "/"), so pi processes our block unchanged.
     * Unknown/non-skills return undefined so pi processes them normally.
     */
    async function proceed(): Promise<{ action: "transform"; text: string } | undefined> {
      await processInputText();
      const expanded = expandSkillCommand(
        text,
        (t) => substituteTemplates(t, NO_FEATURE_STATE_OVERRIDE, NO_AGENT_NAME).text,
      );
      if (expanded !== text) {
        return { action: "transform", text: expanded };
      }
      // Not one of our skills — let pi process normally
    }

    // Track last skill invoked from input text
    const invokedSkill = parseSkillName(text);
    if (invokedSkill) {
      log.info(`[workflow] input: tracked skill from input text: ${invokedSkill}`);
    }

    // Update executionMode when user invokes ff-implement
    if (invokedSkill === "ff-implement") {
      if (!handler.getActiveFeatureSlug()) {
        const planSlug = featureSlugFromPlanDoc(text);
        if (planSlug) {
          const pathMatch = text.match(/(\S+-task-plan\.md)/);
          const planPath = pathMatch?.[1] ?? "";
          activateFromPlanSkill(ctx, handler, planSlug, planPath);
          log.info(`Created/loaded feature state for ${planSlug} from skill invocation`);
          persistState(pi, handler);
          updateWidget(handler, NO_FEATURE_STATE);
        }
      }
    }

    // ff-plan / ff-design invoked with a design-doc path and no active
    // feature: activate an existing feature, or create+kanban-link one from the
    // design doc. Mirrors the ff-implement path above (plan-doc source),
    // generalized to a design-doc slug source. Activating at invocation time (not
    // just on plan-doc write) ensures skill placeholders resolve and the feature
    // is visible/usable for phase_ready.
    if (invokedSkill === "ff-plan" || invokedSkill === "ff-design") {
      if (!handler.getActiveFeatureSlug()) {
        const designSlug = featureSlugFromDesignDoc(text);
        if (designSlug) {
          const pathMatch = text.match(/(\S+-design\.md)/);
          const designPath = pathMatch?.[1] ?? "";
          const targetPhase: Phase = invokedSkill === "ff-plan" ? "plan" : "design";
          await activateFromDesignSkill(ctx, handler, designSlug, designPath, targetPhase);
          log.info(`Activated/created feature state for ${designSlug} from ${invokedSkill} skill invocation`);
          persistState(pi, handler);
          updateWidget(handler, NO_FEATURE_STATE);
        }
      }
    }

    // Manual review skill invocation — increment the review loop counter so the
    // substitution pipeline resolves the correct iteration context. This mirrors
    // the code-driven path (phase_ready) via the shared startReviewIteration helper.
    // Injected followUp messages are skipped (event.source === "extension"), so this
    // never double-counts with the phase_ready path.
    if (invokedSkill === "ff-design-review" || invokedSkill === "ff-plan-review") {
      const activeSlug = handler.getActiveFeatureSlug();
      if (activeSlug) {
        const phase = invokedSkill === "ff-design-review" ? "design" : "plan";
        // startReviewIteration loads+increments+saves the review counter (side effect).
        startReviewIteration(handler, activeSlug, phase, NO_FEATURE_STATE_OVERRIDE);
        syncEnvVarsFromState(handler);
        updateWidget(handler, NO_FEATURE_STATE);
        log.info(`[workflow] input: manual ${invokedSkill} invocation incremented review counter for ${activeSlug}`);
      }
    }

    // Respect explicit skill invocation: proceed() runs processInputText(), which
    // calls PhaseProgression.onInputText() — that advances the pointer to the invoked
    // skill's phase (jumped phases fold to done via derivation) and guards
    // FRESH_START_BLOCKED when no workflow is active. No blocking dialog — recovery
    // from an unintended jump is via ff-reset or invoking another skill.
    return proceed();
  });
}

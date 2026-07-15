// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Featyard settings types.
 *
 * Re-exports the FeatyardSettings interface and all enum types for consumers.
 */

// ---------------------------------------------------------------------------
// Enum types
// ---------------------------------------------------------------------------

export type TestingDiscipline = "tdd-strict" | "tdd-advisory" | "off";

export type PreCommitDiscipline = "off" | "advisory" | "strict";

export type ExecutionFlow = "current-session" | "subagent-driven" | "subagent-driven-fork";

export type FeatureReviewMode = "general" | "comprehensive";

export type FeatureReviewSubagentsMode = "new" | "fork" | "new+fork";

export type PlanReviewMode = "in-session" | "parallel-subagents";

export type PlanReviewSubagentsMode = "new" | "fork" | "new+fork";

export type VerifyPhases = "off" | "verify" | "plan+verify" | "plan+implement+verify";

export type PerTaskReviewMode = "off" | "general";

export type NestedResearchers = "off" | "on";

export type UatMode = "off" | "after-review" | "after-finish";

export type BranchPolicy = "current-branch" | "worktree";

export type AutoOnBlock = "wait" | "switch";

export type DesignDocStorage = "local" | "committed";

// ---------------------------------------------------------------------------
// Settings interface
// ---------------------------------------------------------------------------

export interface FeatyardSettings {
  interTaskCompact: string;
  testingDiscipline: TestingDiscipline;
  preCommitDiscipline: PreCommitDiscipline;
  implementMode: ExecutionFlow;
  maxFeatureReviewRounds: number;
  featureReviewMode: FeatureReviewMode;
  featureReviewSubagentsMode: FeatureReviewSubagentsMode;
  reviewerSkipThreshold: number;
  planReviewMode: PlanReviewMode;
  maxPlanReviewRounds: number;
  planReviewSubagentsMode: PlanReviewSubagentsMode;
  maxVerifyRounds: number;
  verifyPhases: VerifyPhases;
  perTaskReviewMode: PerTaskReviewMode;
  maxTaskReviewRounds: number;
  minReviewLoops: number;
  researcherMinInstances: number;
  researcherMaxInstances: number;
  nestedResearchers: NestedResearchers;
  uatMode: UatMode;
  branchPolicy: BranchPolicy;
  baseBranch: string | null;
  designDocStorage: DesignDocStorage;
  autoArchiveArtifactsOlderThanDays: number;
  autoArchiveDesignsOlderThanDays: number | null;
  // Auto-agent / kanban settings
  autoPollMs: number;
  autoOnBlock: AutoOnBlock;
  autoLockTimeoutMs: number;
  autoWorkerWaitTimeoutMs: number | null;
  autoDesignerWaitTimeoutMs: number | null;
  designApprovalEnabled: boolean;
  kanbanDoneHideAfterMs: number | null;
  reviewIterationCompact: string;
}

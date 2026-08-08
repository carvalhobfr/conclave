import type { Evidence } from "./evidence.js";
import type { Claim, ReasoningMetrics, RetrievalRequest } from "./reasoning.js";

export type ConclaveIntent = "ask" | "investigate" | "task";

export type TaskAgentRole = "planner" | "implementer" | "reviewer";

export interface TaskAgentAssignment {
  readonly role: TaskAgentRole;
  readonly providerId: string;
  readonly modelId: string;
}

export interface ExecutionPermissions {
  readonly allowFileEdits: boolean;
  readonly allowCommands: boolean;
  readonly allowRepositoryScripts: boolean;
  readonly allowNetwork: boolean;
}

export const PLAN_ONLY_PERMISSIONS: ExecutionPermissions = {
  allowFileEdits: false,
  allowCommands: false,
  allowRepositoryScripts: false,
  allowNetwork: false,
};

export interface TaskExecutionLimits {
  readonly maxImplementationRounds: number;
  readonly maxModelCalls: number;
  readonly maxOutputTokensPerCall: number;
  readonly maxFilesChanged: number;
  readonly maxTotalChangedLines: number;
  readonly maxChangedLinesPerFile: number;
  readonly maxPatchBytes: number;
  readonly maxCommands: number;
  readonly maxCommandDurationMs: number;
  readonly maxCommandOutputBytes: number;
  readonly maxExecutionDurationMs: number;
  readonly maxAdditionalEvidence: number;
}

export const DEFAULT_TASK_EXECUTION_LIMITS: TaskExecutionLimits = {
  maxImplementationRounds: 2,
  maxModelCalls: 8,
  maxOutputTokensPerCall: 2_000,
  maxFilesChanged: 8,
  maxTotalChangedLines: 500,
  maxChangedLinesPerFile: 250,
  maxPatchBytes: 80_000,
  maxCommands: 4,
  maxCommandDurationMs: 60_000,
  maxCommandOutputBytes: 64_000,
  maxExecutionDurationMs: 5 * 60_000,
  maxAdditionalEvidence: 12,
};

export type TaskVerificationStrategy =
  | {
      readonly kind: "source-contains";
      readonly path: string;
      readonly text: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "symbol-exists";
      readonly symbol: string;
      readonly path?: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "graph-path";
      readonly from: string;
      readonly to: string;
      readonly maxDepth?: number;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "callers";
      readonly symbol: string;
      readonly minimum: number;
    }
  | {
      readonly kind: "changed-file";
      readonly path: string;
      readonly expectation: "changed" | "unchanged";
    }
  | {
      readonly kind: "check-passed";
      readonly requestId: string;
    };

export interface TaskRequirement {
  readonly id: string;
  readonly statement: string;
  readonly required: boolean;
  readonly verification: TaskVerificationStrategy;
}

export interface TaskConstraint {
  readonly id: string;
  readonly statement: string;
  readonly kind: "scope" | "compatibility" | "security" | "behavior";
}

export interface ImplementationStep {
  readonly id: string;
  readonly description: string;
  readonly targetFiles: readonly string[];
  readonly rationaleClaimIds: readonly string[];
  readonly requirementIds: readonly string[];
  readonly expectedOutcome: string;
}

export interface ImplementationPlan {
  readonly id: string;
  readonly summary: string;
  readonly requirements: readonly TaskRequirement[];
  readonly constraints: readonly TaskConstraint[];
  readonly steps: readonly ImplementationStep[];
  readonly evidenceIds: readonly string[];
}

export interface ImplementationTask {
  readonly id: string;
  readonly objective: string;
  readonly diagnosisClaimIds: readonly string[];
  readonly targetEvidenceIds: readonly string[];
  readonly affectedAreas: readonly string[];
  readonly plan: ImplementationPlan;
}

export interface FileReplacement {
  readonly oldText: string;
  readonly newText: string;
  readonly expectedOccurrences: number;
}

export interface ProposedFilePatch {
  readonly id: string;
  readonly implementationStepId: string;
  readonly path: string;
  readonly expectedHash: string;
  readonly replacements: readonly FileReplacement[];
}

export type AllowedCommand =
  | { readonly kind: "node-syntax"; readonly path: string }
  | { readonly kind: "node-test"; readonly path: string }
  | { readonly kind: "package-script"; readonly name: string };

export type CapabilityRequest =
  | {
      readonly id: string;
      readonly kind: "apply-patches";
      readonly patchIds: readonly string[];
      readonly reason: string;
    }
  | {
      readonly id: string;
      readonly kind: "run-command";
      readonly command: AllowedCommand;
      readonly reason: string;
    }
  | {
      readonly id: string;
      readonly kind: "read-file";
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly id: string;
      readonly kind: "retrieve";
      readonly request: RetrievalRequest;
      readonly reason: string;
    };

export interface CapabilityDecision {
  readonly requestId: string;
  readonly capability: CapabilityRequest["kind"];
  readonly outcome: "allowed" | "rejected";
  readonly reason: string;
  readonly decidedAt: string;
}

export interface ImplementationClaim {
  readonly id: string;
  readonly statement: string;
  readonly requirementIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly verification: TaskVerificationStrategy;
}

export interface ImplementerResult {
  readonly summary: string;
  readonly patches: readonly ProposedFilePatch[];
  readonly claims: readonly ImplementationClaim[];
  readonly capabilityRequests: readonly CapabilityRequest[];
}

export interface ChangedRange {
  readonly startLine: number;
  readonly originalLines: number;
  readonly resultingLines: number;
}

export interface ChangedFile {
  readonly path: string;
  readonly changeType: "modified" | "added" | "deleted";
  readonly originalHash?: string;
  readonly resultingHash?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedRanges: readonly ChangedRange[];
  readonly implementationStepIds: readonly string[];
  readonly expectedByPlan: boolean;
}

export interface PatchRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly patches: readonly ProposedFilePatch[];
  readonly changedFiles: readonly ChangedFile[];
  readonly unifiedDiff: string;
  readonly totalChangedLines: number;
}

export interface CheckResult {
  readonly requestId: string;
  readonly command: AllowedCommand;
  readonly status: "passed" | "failed" | "timed-out" | "rejected";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
  readonly policyReason: string;
}

export type ReviewFindingType =
  | "requirement-gap"
  | "unrelated-change"
  | "regression-risk"
  | "architecture"
  | "security"
  | "failed-check"
  | "unsupported-claim";

export interface ReviewFinding {
  readonly id: string;
  readonly type: ReviewFindingType;
  readonly severity: "info" | "warning" | "blocking";
  readonly statement: string;
  readonly requirementIds: readonly string[];
  readonly paths: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface ReviewResult {
  readonly status: "approved" | "revision-required" | "uncertain";
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export interface RevisionRequest {
  readonly id: string;
  readonly round: number;
  readonly failedRequirementIds: readonly string[];
  readonly rejectedClaimIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly allowedFiles: readonly string[];
  readonly instructions: string;
}

export interface RequirementVerification {
  readonly requirementId: string;
  readonly outcome: "supported" | "rejected" | "uncertain";
  readonly method: TaskVerificationStrategy["kind"];
  readonly explanation: string;
  readonly evidenceIds: readonly string[];
  readonly checkRequestIds: readonly string[];
}

export type ExecutionVerdictStatus =
  | "planned"
  | "completed"
  | "completed-with-uncertainty"
  | "failed"
  | "blocked";

export interface ExecutionVerdict {
  readonly status: ExecutionVerdictStatus;
  readonly summary: string;
  readonly requirements: readonly RequirementVerification[];
  readonly changedFiles: readonly ChangedFile[];
  readonly supportedClaims: readonly ImplementationClaim[];
  readonly rejectedClaims: readonly ImplementationClaim[];
  readonly uncertainClaims: readonly ImplementationClaim[];
  readonly checks: readonly CheckResult[];
  readonly revisionRounds: number;
}

export interface RepositoryExecutionSnapshot {
  readonly originalRoot: string;
  readonly executionRoot?: string;
  readonly isolation: "git-worktree" | "copied-directory" | "none";
  readonly gitBacked: boolean;
  readonly branch?: string;
  readonly baseRevision?: string;
  readonly dirtyPaths: readonly string[];
}

export type TaskTraceEventType =
  | "task_started"
  | "execution_permission_checked"
  | "repository_snapshot_created"
  | "implementation_plan_created"
  | "implementer_started"
  | "patch_proposed"
  | "patch_validated"
  | "patch_applied"
  | "repository_reindexed"
  | "post_change_evidence_created"
  | "command_requested"
  | "command_allowed"
  | "command_rejected"
  | "command_started"
  | "command_completed"
  | "reviewer_started"
  | "implementation_claim_proposed"
  | "implementation_claim_rejected"
  | "revision_requested"
  | "execution_verdict_completed"
  | "execution_blocked";

export interface TaskTraceEvent {
  readonly sequence: number;
  readonly type: TaskTraceEventType;
  readonly occurredAt: string;
  readonly round: number;
  readonly detail: string;
  readonly data?: Readonly<Record<string, string | number | boolean>>;
}

export interface TaskRoleUsage {
  readonly role: TaskAgentRole;
  readonly providerIds: readonly string[];
  readonly modelIds: readonly string[];
  readonly calls: number;
  readonly approximateInputTokens: number;
  readonly approximateOutputTokens: number;
  readonly providerReportedInputTokens: number;
  readonly providerReportedOutputTokens: number;
  readonly latencyMs: number;
}

export interface TaskExecutionMetrics {
  readonly investigation: ReasoningMetrics;
  readonly taskModelCalls: number;
  readonly commandCount: number;
  readonly revisionRounds: number;
  readonly filesChanged: number;
  readonly changedLines: number;
  readonly approximateInputTokens: number;
  readonly approximateOutputTokens: number;
  readonly providerReportedInputTokens: number;
  readonly providerReportedOutputTokens: number;
  readonly latencyMs: number;
  readonly roleUsage: readonly TaskRoleUsage[];
}

export interface TaskExecutionResult {
  readonly intent: "task";
  readonly task: ImplementationTask;
  readonly diagnosisClaims: readonly Claim[];
  readonly preChangeEvidence: readonly Evidence[];
  readonly postChangeEvidence: readonly Evidence[];
  readonly snapshot: RepositoryExecutionSnapshot;
  readonly patchRecords: readonly PatchRecord[];
  readonly capabilityDecisions: readonly CapabilityDecision[];
  readonly review: ReviewResult;
  readonly revisions: readonly RevisionRequest[];
  readonly verdict: ExecutionVerdict;
  readonly trace: readonly TaskTraceEvent[];
  readonly metrics: TaskExecutionMetrics;
}

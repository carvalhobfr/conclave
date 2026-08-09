import type { Evidence } from "./evidence.js";
import type { AgentRole, Claim, ReasoningLimits } from "./reasoning.js";

export type AnalysisDepth = "auto" | "fast" | "balanced" | "deep";
export type SelectedAnalysisDepth = Exclude<AnalysisDepth, "auto">;

export type QueryKind =
  | "exact-lookup"
  | "relationship"
  | "explanation"
  | "causal"
  | "comparison"
  | "task"
  | "ambiguous";

export interface QueryAssessment {
  readonly queryKind: QueryKind;
  readonly resolvedEntities: readonly string[];
  readonly relevantFiles: readonly string[];
  readonly crossModule: boolean;
  readonly ambiguity: "low" | "medium" | "high";
  readonly deterministicCoverage: "none" | "partial" | "strong";
  readonly requiresModelReasoning: boolean;
  readonly signals: readonly string[];
}

export interface ModelRequirement {
  readonly reasoning?: "low" | "medium" | "high";
  readonly coding?: "low" | "medium" | "high";
  readonly speed?: "interactive" | "normal" | "slow-ok";
  readonly context?: "small" | "medium" | "large";
  readonly independencePreferred?: boolean;
  readonly costPreference?: "free-only" | "prefer-free" | "any-configured";
}

export interface ModelProfile {
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilities: {
    readonly reasoning: "low" | "medium" | "high";
    readonly coding: "low" | "medium" | "high";
    readonly speed: "fast" | "medium" | "slow";
    readonly context: "small" | "medium" | "large";
  };
  readonly costClass: "free" | "standard" | "premium";
  readonly available?: boolean;
}

export interface PlannedRole {
  readonly role: AgentRole;
  readonly requirement: "required" | "conditional";
}

export interface ReasoningPlan {
  readonly depth: SelectedAnalysisDepth;
  readonly strategy:
    | "deterministic"
    | "graph-first"
    | "retrieval-first"
    | "causal-investigation"
    | "task-investigation";
  readonly roles: readonly PlannedRole[];
  readonly modelRequirements: Partial<Readonly<Record<AgentRole, ModelRequirement>>>;
  readonly finalReview: "none" | "conditional" | "recommended";
  readonly reasonCodes: readonly string[];
}

export type AnalysisSnapshotStatus =
  | "working"
  | "sufficient"
  | "complete"
  | "cancelled"
  | "timed-out";

export interface AnalysisSnapshot {
  readonly status: AnalysisSnapshotStatus;
  readonly provisionalConclusion?: string;
  readonly supportedClaims: readonly Claim[];
  readonly rejectedClaims: readonly Claim[];
  readonly uncertainClaims: readonly Claim[];
  readonly evidence: readonly Evidence[];
  readonly remainingChecks: readonly string[];
}

export interface DepthBudget {
  readonly depth: SelectedAnalysisDepth;
  readonly limits: ReasoningLimits;
  readonly providerTimeoutMs: number;
}

export interface AnalysisRunOptions {
  readonly depth?: AnalysisDepth;
  readonly signal?: AbortSignal;
  readonly intent?: "ask" | "investigate" | "task";
  readonly onSnapshot?: (snapshot: AnalysisSnapshot) => void;
}

export interface ReviewRecommendation {
  readonly recommended: boolean;
  readonly reasons: readonly string[];
  readonly handoff?: string;
}

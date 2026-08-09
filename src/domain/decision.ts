import type { AnalysisDepth, QueryAssessment, ReasoningPlan, SelectedAnalysisDepth } from "./adaptive-reasoning.js";
import type { Evidence } from "./evidence.js";
import type { ReasoningTraceEvent } from "./reasoning.js";

export type DecisionClaimKind = "goal" | "assumption" | "constraint" | "consequence";
export type DecisionClaimStatus = "supported" | "rejected" | "uncertain";

export interface DecisionClaim {
  readonly id: string;
  readonly statement: string;
  readonly kind: DecisionClaimKind;
  readonly status: DecisionClaimStatus;
  readonly evidenceIds: readonly string[];
  readonly explanation: string;
  readonly deterministic: boolean;
}

export interface DecisionRequest {
  readonly proposal: string;
  readonly objective?: string;
}

export interface DecisionRunOptions {
  readonly depth?: AnalysisDepth;
  readonly signal?: AbortSignal;
}

export interface DecisionVerdict {
  readonly status: "proceed" | "revise" | "uncertain" | "invalid";
  readonly summary: string;
  readonly claims: readonly DecisionClaim[];
  readonly confirmedProperties: readonly string[];
  readonly challengedAssumptions: readonly string[];
  readonly uncertainty: readonly string[];
  readonly evidence: readonly Evidence[];
  readonly implementationHandoff?: string;
  readonly revisionHandoff?: string;
  readonly trace: readonly ReasoningTraceEvent[];
  readonly metrics: {
    readonly modelCalls: number;
    readonly deterministicOperations: number;
    readonly approximateInputTokens: number;
    readonly approximateOutputTokens: number;
    readonly latencyMs: number;
  };
  readonly analysis: {
    readonly requestedDepth: AnalysisDepth;
    readonly selectedDepth: SelectedAnalysisDepth;
    readonly assessment: QueryAssessment;
    readonly plan: ReasoningPlan;
    readonly deterministic: boolean;
  };
}

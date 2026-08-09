import type {
  AnalysisDepth,
  AnalysisSnapshot,
  QueryAssessment,
  ReasoningPlan,
  SelectedAnalysisDepth,
} from "./adaptive-reasoning.js";
import type { CodeSymbolKind } from "./code-intelligence.js";
import type { Evidence } from "./evidence.js";
import type { ReasoningTraceEvent } from "./reasoning.js";
import type { SourceLanguage } from "./repository.js";

export type ChangeSetSource =
  | { readonly kind: "working-tree" }
  | { readonly kind: "staged" }
  | { readonly kind: "branch"; readonly base: string; readonly head?: string }
  | { readonly kind: "commit"; readonly base: string; readonly target: string }
  | { readonly kind: "explicit"; readonly label?: string };

export interface ChangeSet {
  readonly id: string;
  readonly repositoryRoot: string;
  readonly source: ChangeSetSource;
  readonly unifiedDiff: string;
  readonly createdAt: string;
  readonly excludedSensitivePaths: readonly string[];
  readonly limitations: readonly string[];
}

export type ReviewVerdictStatus =
  | "approved"
  | "changes-requested"
  | "uncertain"
  | "nothing-to-review"
  | "invalid";

export type ReviewFindingCategory =
  | "invalid-diff"
  | "merge-conflict"
  | "secret-exposure"
  | "security"
  | "correctness"
  | "regression-risk"
  | "objective-gap"
  | "scope"
  | "maintainability";

export interface ReviewVerdictFinding {
  readonly id: string;
  readonly category: ReviewFindingCategory;
  readonly severity: "blocking" | "warning" | "suggestion";
  readonly statement: string;
  readonly consequence: string;
  readonly path?: string;
  readonly line?: number;
  readonly evidenceIds: readonly string[];
  readonly deterministic: boolean;
  readonly secretType?: "private-key" | "aws-access-key" | "github-token" | "provider-token" | "credential-assignment";
}

export interface ReviewedFile {
  readonly path: string;
  readonly changeType: "added" | "modified" | "deleted";
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: number;
  readonly indexed: boolean;
}

export interface ChangedSymbol {
  readonly id: string;
  readonly path: string;
  readonly symbol: string;
  readonly symbolKind: CodeSymbolKind;
  readonly language: SourceLanguage;
  readonly startLine: number;
  readonly endLine: number;
  readonly changeType: "added" | "modified" | "deleted";
  readonly evidenceIds: readonly string[];
}

export interface ImpactedSymbol {
  readonly id: string;
  readonly path: string;
  readonly symbol: string;
  readonly relation: string;
  readonly direction: "incoming" | "outgoing";
  readonly evidenceIds: readonly string[];
}

export interface ReviewImpactAnalysis {
  readonly changedSymbols: readonly ChangedSymbol[];
  readonly impactedSymbols: readonly ImpactedSymbol[];
  readonly affectedFiles: readonly string[];
  readonly graphEdgesInspected: number;
  readonly truncated: boolean;
  readonly limits: {
    readonly maxChangedSymbols: number;
    readonly maxImpactedSymbols: number;
    readonly maxGraphEdges: number;
  };
}

export interface ConfirmedProperty {
  readonly id: string;
  readonly statement: string;
  readonly method: "diff" | "parser" | "symbol" | "graph" | "safety-scan";
  readonly evidenceIds: readonly string[];
}

export interface ReviewUncertainty {
  readonly id: string;
  readonly statement: string;
  readonly reason: "runtime" | "dynamic-dispatch" | "deleted-source" | "unindexed-file" | "objective" | "incomplete-diff" | "model";
  readonly paths: readonly string[];
}

export interface ReviewRequest {
  readonly unifiedDiff: string;
  readonly objective?: string;
  readonly changeSet?: ChangeSet;
}

export interface ReviewRunOptions {
  readonly depth?: AnalysisDepth;
  readonly signal?: AbortSignal;
  readonly onSnapshot?: (snapshot: AnalysisSnapshot) => void;
}

export interface ReviewVerdict {
  readonly status: ReviewVerdictStatus;
  readonly summary: string;
  readonly objective?: string;
  readonly changeSet?: Pick<ChangeSet, "id" | "source" | "excludedSensitivePaths" | "limitations">;
  readonly findings: readonly ReviewVerdictFinding[];
  readonly confirmedProperties: readonly ConfirmedProperty[];
  readonly uncertainty: readonly ReviewUncertainty[];
  readonly changedFiles: readonly ReviewedFile[];
  readonly impact: ReviewImpactAnalysis;
  readonly evidence: readonly Evidence[];
  readonly limitations: readonly string[];
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
    readonly route: "project-knowledge" | "adaptive-orchestration";
    readonly requestedDepth: AnalysisDepth;
    readonly selectedDepth: SelectedAnalysisDepth;
    readonly assessment: QueryAssessment;
    readonly plan: ReasoningPlan;
    readonly deterministic: boolean;
    readonly reasonCodes: readonly string[];
  };
}

import type { GraphEdge } from "./code-index.js";
import type { RetrievalResult } from "./evidence.js";

export interface EvidenceBudget {
  readonly graphDepth: number;
  readonly graphNodes: number;
  readonly retrievalCandidates: number;
  readonly finalEvidence: number;
  readonly sourceBytes: number;
  readonly approximateTokens: number;
}

export const DEFAULT_EVIDENCE_BUDGET: EvidenceBudget = {
  graphDepth: 2,
  graphNodes: 30,
  retrievalCandidates: 50,
  finalEvidence: 10,
  sourceBytes: 24_000,
  approximateTokens: 6_000,
};

export type RetrievalOperationKind =
  | "exact-symbol"
  | "exact-path"
  | "exact-text"
  | "graph-callers"
  | "graph-callees"
  | "graph-imports"
  | "graph-exports"
  | "graph-references"
  | "graph-containing-symbol"
  | "graph-contained-symbols"
  | "graph-related-files"
  | "graph-shortest-path"
  | "graph-expansion"
  | "lexical"
  | "semantic-feature-vector"
  | "hybrid-fusion";

export interface RetrievalOperation {
  readonly kind: RetrievalOperationKind;
  readonly status: "executed" | "skipped";
  readonly reason: string;
  readonly resultCount: number;
}

export interface RetrievalPlan {
  readonly operations: readonly RetrievalOperation[];
  readonly reasons: readonly string[];
  readonly deterministicEvidenceSufficient: boolean;
}

export interface PlannedRetrieval {
  readonly query: string;
  readonly plan: RetrievalPlan;
  readonly results: readonly RetrievalResult[];
  readonly graphEdges: readonly GraphEdge[];
  readonly budget: EvidenceBudget;
}

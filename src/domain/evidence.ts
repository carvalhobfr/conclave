import type { CodeSymbolKind } from "./code-intelligence.js";

export type EvidenceOrigin = "structural-unit" | "text-match" | "file-range";

export interface EvidenceProvenance {
  readonly origin: EvidenceOrigin;
  readonly repositoryId: string;
  readonly sourceIdentity: string;
  readonly contentHash: string;
  readonly unitId?: string;
}

export interface Evidence {
  readonly id: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  readonly symbolKind?: CodeSymbolKind;
  readonly excerpt: string;
  readonly provenance: EvidenceProvenance;
}

export interface RetrievalSignals {
  readonly lexical?: number;
  readonly semantic?: number;
  readonly exactSymbol?: number;
  readonly partialSymbol?: number;
  readonly path?: number;
  readonly graph?: number;
}

export interface RetrievalReason {
  readonly strategy:
    | "lexical"
    | "semantic"
    | "exact-symbol"
    | "partial-symbol"
    | "path"
    | "graph";
  readonly detail: string;
}

export interface RetrievalResult {
  readonly evidence: Evidence;
  readonly rank: number;
  /** Retrieval score only. This is not a confidence estimate. */
  readonly score: number;
  readonly signals: RetrievalSignals;
  readonly reasons: readonly RetrievalReason[];
}

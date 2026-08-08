import type { GraphEdge } from "./code-index.js";
import type { CodeSymbolKind } from "./code-intelligence.js";
import type { EvidenceBudget } from "./retrieval-plan.js";

export interface PackedEvidenceUnit {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  readonly rank: number;
  readonly symbols: readonly {
    readonly name: string;
    readonly kind?: CodeSymbolKind;
  }[];
  readonly sourceEvidenceIds: readonly string[];
  readonly sourceUnitIds: readonly string[];
  readonly reasons: readonly string[];
  readonly contentHash: string;
}

export interface ContextBundleStats {
  readonly inputEvidenceCount: number;
  readonly selectedEvidenceCount: number;
  readonly packedEvidenceCount: number;
  readonly sourceBytes: number;
  readonly approximateTokens: number;
  readonly filesRepresented: number;
  readonly symbolsRepresented: number;
  readonly duplicateOrOverlappingUnitsRemoved: number;
  readonly truncated: boolean;
}

export interface ContextBundle {
  readonly evidence: readonly PackedEvidenceUnit[];
  readonly relationships: readonly GraphEdge[];
  readonly stats: ContextBundleStats;
  readonly budget: EvidenceBudget;
}

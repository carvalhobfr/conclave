import { createHash } from "node:crypto";

import type { GraphEdge, RepositoryCodeIndex } from "../domain/code-index.js";
import type { ContextBundle, PackedEvidenceUnit } from "../domain/context-bundle.js";
import type { RetrievalResult } from "../domain/evidence.js";
import type { EvidenceBudget } from "../domain/retrieval-plan.js";
import { NullRetrievalEventSink, type RetrievalEventSink } from "../domain/observability.js";

interface MutablePackedEvidence {
  path: string;
  startLine: number;
  endLine: number;
  rank: number;
  symbols: Map<string, PackedEvidenceUnit["symbols"][number]>;
  sourceEvidenceIds: Set<string>;
  sourceUnitIds: Set<string>;
  reasons: Set<string>;
  contentHash: string;
}

function sourceRange(source: string, startLine: number, endLine: number): string {
  return source.split("\n").slice(startLine - 1, endLine).join("\n");
}

export function approximateTokenCount(sourceBytes: number): number {
  return Math.ceil(sourceBytes / 4);
}

function packedId(unit: MutablePackedEvidence): string {
  return `packed_${createHash("sha256")
    .update(
      `${unit.path}\0${String(unit.startLine)}\0${String(unit.endLine)}\0${[...unit.sourceEvidenceIds].sort().join("\0")}`,
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function overlapsOrAdjacent(
  left: Pick<MutablePackedEvidence, "startLine" | "endLine">,
  right: Pick<MutablePackedEvidence, "startLine" | "endLine">,
): boolean {
  return left.startLine <= right.endLine + 1 && right.startLine <= left.endLine + 1;
}

function sortedValues<T>(values: ReadonlySet<T>): readonly T[] {
  return [...values].sort();
}

export class ContextPacker {
  readonly #index: RepositoryCodeIndex;
  readonly #events: RetrievalEventSink;

  public constructor(
    index: RepositoryCodeIndex,
    events: RetrievalEventSink = new NullRetrievalEventSink(),
  ) {
    this.#index = index;
    this.#events = events;
  }

  public pack(
    rankedEvidence: readonly RetrievalResult[],
    graphRelationships: readonly GraphEdge[],
    budget: EvidenceBudget,
  ): ContextBundle {
    const uniqueEvidenceById = new Map(rankedEvidence.map((result) => [result.evidence.id, result]));
    const duplicateEvidenceCount = rankedEvidence.length - uniqueEvidenceById.size;
    const uniqueRanked = [...uniqueEvidenceById.values()]
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          left.evidence.path.localeCompare(right.evidence.path) ||
          left.evidence.startLine - right.evidence.startLine,
      )
      .slice(0, budget.retrievalCandidates);
    const selected: MutablePackedEvidence[] = [];
    const selectedEvidenceIds = new Set<string>();
    let truncated = uniqueRanked.length < rankedEvidence.length;

    for (const result of uniqueRanked) {
      const evidence = result.evidence;
      const file = this.#index.files[evidence.path];
      if (file === undefined || file.contentHash !== evidence.provenance.contentHash) {
        continue;
      }
      const candidate = this.#candidate(result, file.contentHash);
      const merging = selected.filter(
        (existing) => existing.path === candidate.path && overlapsOrAdjacent(existing, candidate),
      );
      const remaining = selected.filter((existing) => !merging.includes(existing));
      const merged = this.#merge([candidate, ...merging]);
      const next = [...remaining, merged].sort(
        (left, right) => left.rank - right.rank || left.path.localeCompare(right.path) || left.startLine - right.startLine,
      );
      const totals = this.#totals(next);
      if (
        next.length > budget.finalEvidence ||
        totals.sourceBytes > budget.sourceBytes ||
        totals.approximateTokens > budget.approximateTokens
      ) {
        truncated = true;
        continue;
      }
      selected.splice(0, selected.length, ...next);
      selectedEvidenceIds.add(evidence.id);
    }

    const evidence = selected.map((unit) => this.#finalize(unit));
    const representedUnitIds = new Set(evidence.flatMap((unit) => unit.sourceUnitIds));
    const representedPaths = new Set(evidence.map((unit) => unit.path));
    const relationships = [...new Map(graphRelationships.map((edge) => [edge.id, edge])).values()]
      .filter(
        (edge) =>
          representedPaths.has(edge.provenance.path) ||
          (edge.from.kind === "symbol" && representedUnitIds.has(edge.from.id)) ||
          (edge.to.kind === "symbol" && representedUnitIds.has(edge.to.id)),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, budget.graphNodes * 2);
    const totals = this.#totals(selected);
    const symbols = new Set(evidence.flatMap((unit) => unit.symbols.map((symbol) => symbol.name)));
    const stats = {
      inputEvidenceCount: rankedEvidence.length,
      selectedEvidenceCount: selectedEvidenceIds.size,
      packedEvidenceCount: evidence.length,
      sourceBytes: totals.sourceBytes,
      approximateTokens: totals.approximateTokens,
      filesRepresented: representedPaths.size,
      symbolsRepresented: symbols.size,
      duplicateOrOverlappingUnitsRemoved:
        duplicateEvidenceCount + Math.max(0, selectedEvidenceIds.size - evidence.length),
      truncated,
    };
    this.#events.emit({
      type: "context_packed",
      occurredAt: new Date().toISOString(),
      repositoryId: this.#index.repository.id,
      data: {
        inputEvidence: stats.inputEvidenceCount,
        packedEvidence: stats.packedEvidenceCount,
        sourceBytes: stats.sourceBytes,
        approximateTokens: stats.approximateTokens,
        truncated: stats.truncated,
      },
    });
    return { evidence, relationships, stats, budget };
  }

  #candidate(result: RetrievalResult, contentHash: string): MutablePackedEvidence {
    const symbols = new Map<string, PackedEvidenceUnit["symbols"][number]>();
    if (result.evidence.symbol !== undefined) {
      symbols.set(result.evidence.symbol, {
        name: result.evidence.symbol,
        ...(result.evidence.symbolKind === undefined ? {} : { kind: result.evidence.symbolKind }),
      });
    }
    return {
      path: result.evidence.path,
      startLine: result.evidence.startLine,
      endLine: result.evidence.endLine,
      rank: result.rank,
      symbols,
      sourceEvidenceIds: new Set([result.evidence.id]),
      sourceUnitIds: new Set(
        result.evidence.provenance.unitId === undefined ? [] : [result.evidence.provenance.unitId],
      ),
      reasons: new Set(result.reasons.map((reason) => `${reason.strategy}: ${reason.detail}`)),
      contentHash,
    };
  }

  #merge(units: readonly MutablePackedEvidence[]): MutablePackedEvidence {
    const first = units[0];
    if (first === undefined) {
      throw new Error("Cannot merge an empty evidence collection");
    }
    return {
      path: first.path,
      startLine: Math.min(...units.map((unit) => unit.startLine)),
      endLine: Math.max(...units.map((unit) => unit.endLine)),
      rank: Math.min(...units.map((unit) => unit.rank)),
      symbols: new Map(units.flatMap((unit) => [...unit.symbols.entries()])),
      sourceEvidenceIds: new Set(units.flatMap((unit) => [...unit.sourceEvidenceIds])),
      sourceUnitIds: new Set(units.flatMap((unit) => [...unit.sourceUnitIds])),
      reasons: new Set(units.flatMap((unit) => [...unit.reasons])),
      contentHash: first.contentHash,
    };
  }

  #totals(units: readonly MutablePackedEvidence[]): {
    readonly sourceBytes: number;
    readonly approximateTokens: number;
  } {
    const sourceBytes = units.reduce((total, unit) => {
      const file = this.#index.files[unit.path];
      return total + (file === undefined ? 0 : Buffer.byteLength(sourceRange(file.sourceText, unit.startLine, unit.endLine)));
    }, 0);
    return { sourceBytes, approximateTokens: approximateTokenCount(sourceBytes) };
  }

  #finalize(unit: MutablePackedEvidence): PackedEvidenceUnit {
    const file = this.#index.files[unit.path];
    if (file === undefined) {
      throw new Error(`Packed evidence references a missing file: ${unit.path}`);
    }
    return {
      id: packedId(unit),
      path: unit.path,
      startLine: unit.startLine,
      endLine: unit.endLine,
      excerpt: sourceRange(file.sourceText, unit.startLine, unit.endLine),
      rank: unit.rank,
      symbols: [...unit.symbols.values()].sort((left, right) => left.name.localeCompare(right.name)),
      sourceEvidenceIds: sortedValues(unit.sourceEvidenceIds),
      sourceUnitIds: sortedValues(unit.sourceUnitIds),
      reasons: sortedValues(unit.reasons),
      contentHash: unit.contentHash,
    };
  }
}

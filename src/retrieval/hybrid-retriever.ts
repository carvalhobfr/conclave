import { createHash } from "node:crypto";

import type { Bm25Config } from "./bm25.js";
import { DEFAULT_BM25_CONFIG, searchBm25, type ScoredUnit } from "./bm25.js";
import type { IndexedCodeUnit, RepositoryCodeIndex } from "../domain/code-index.js";
import type { CodeSymbolKind } from "../domain/code-intelligence.js";
import type { EmbeddingProvider } from "../domain/embedding.js";
import type {
  RetrievalReason,
  RetrievalResult,
  RetrievalSignals,
} from "../domain/evidence.js";
import { NullRetrievalEventSink, type RetrievalEventSink } from "../domain/observability.js";
import { evidenceFromUnit } from "./evidence-factory.js";
import { normalizeIdentifier, tokenizeCode } from "./tokenizer.js";
import { CodeGraph } from "../graph/code-graph.js";

export type RetrievalStrategy = "lexical" | "semantic" | "hybrid";

export interface FusionWeights {
  readonly lexical: number;
  readonly semantic: number;
  readonly exactSymbol: number;
  readonly partialSymbol: number;
  readonly path: number;
  readonly graph: number;
}

export interface HybridRetrievalConfig {
  readonly reciprocalRankConstant: number;
  readonly candidateLimit: number;
  readonly defaultLimit: number;
  readonly weights: FusionWeights;
  readonly symbolKindWeights: Readonly<Record<CodeSymbolKind, number>>;
  readonly bm25: Bm25Config;
}

export const DEFAULT_HYBRID_RETRIEVAL_CONFIG: HybridRetrievalConfig = {
  reciprocalRankConstant: 60,
  candidateLimit: 100,
  defaultLimit: 10,
  weights: {
    lexical: 0.8,
    semantic: 1.2,
    exactSymbol: 8,
    partialSymbol: 0.25,
    path: 1.2,
    graph: 1,
  },
  symbolKindWeights: {
    function: 1,
    class: 0.9,
    method: 1,
    "react-component": 1,
    hook: 1,
    interface: 0.55,
    "type-alias": 0.55,
    enum: 0.7,
    "variable-function": 1,
  },
  bm25: DEFAULT_BM25_CONFIG,
};

export interface SearchOptions {
  readonly strategy?: RetrievalStrategy;
  readonly limit?: number;
  readonly expandGraph?: boolean;
  readonly graphDepth?: number;
  readonly graphEvidenceBudget?: number;
}

interface Candidate {
  readonly unit: IndexedCodeUnit;
  score: number;
  signals: {
    lexical?: number;
    semantic?: number;
    exactSymbol?: number;
    partialSymbol?: number;
    path?: number;
    graph?: number;
  };
  reasons: RetrievalReason[];
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }
  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dotProduct / Math.sqrt(leftMagnitude * rightMagnitude);
}

function rawQueryIdentifiers(query: string): readonly string[] {
  return query.match(/[A-Za-z_$][A-Za-z0-9_$-]*/g) ?? [];
}

function symbolSignals(
  units: readonly IndexedCodeUnit[],
  query: string,
): {
  readonly exact: readonly ScoredUnit[];
  readonly partial: readonly ScoredUnit[];
} {
  const identifiers = rawQueryIdentifiers(query);
  const normalizedIdentifiers = new Set(identifiers.map(normalizeIdentifier));
  const queryTokens = new Set(tokenizeCode(query));
  const lowInformationTokens = new Set(["data", "get", "main", "run", "set", "state", "use", "value"]);
  const exact: ScoredUnit[] = [];
  const partial: ScoredUnit[] = [];
  for (const unit of units) {
    const normalizedSymbol = normalizeIdentifier(unit.symbol);
    if (identifiers.includes(unit.symbol) || normalizedIdentifiers.has(normalizedSymbol)) {
      exact.push({ unit, score: 1 });
      continue;
    }
    const symbolTokens = tokenizeCode(unit.symbol);
    const matchingTokens = symbolTokens.filter(
      (token) => token.length >= 3 && !lowInformationTokens.has(token) && queryTokens.has(token),
    );
    if (matchingTokens.length > 0) {
      partial.push({ unit, score: matchingTokens.length / Math.max(symbolTokens.length, 1) });
    }
  }
  const deterministic = (left: ScoredUnit, right: ScoredUnit): number =>
    right.score - left.score ||
    left.unit.path.localeCompare(right.unit.path) ||
    left.unit.startLine - right.unit.startLine;
  return { exact: exact.sort(deterministic), partial: partial.sort(deterministic) };
}

function pathSignals(units: readonly IndexedCodeUnit[], query: string): readonly ScoredUnit[] {
  const queryTokens = new Set(tokenizeCode(query));
  return units
    .flatMap((unit) => {
      const pathTokens = new Set(tokenizeCode(unit.path));
      const matches = [...queryTokens].filter((token) =>
        [...pathTokens].some(
          (pathToken) =>
            pathToken === token ||
            (pathToken.length >= 3 && token.length >= 3 && token.startsWith(pathToken)),
        ),
      ).length;
      return matches === 0
        ? []
        : [{ unit, score: matches / Math.max(pathTokens.size, queryTokens.size, 1) }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.unit.path.localeCompare(right.unit.path) ||
        left.unit.startLine - right.unit.startLine,
    );
}

export class HybridRetriever {
  readonly #index: RepositoryCodeIndex;
  readonly #embeddingProvider: EmbeddingProvider;
  readonly #config: HybridRetrievalConfig;
  readonly #events: RetrievalEventSink;

  public constructor(
    index: RepositoryCodeIndex,
    embeddingProvider: EmbeddingProvider,
    config: HybridRetrievalConfig = DEFAULT_HYBRID_RETRIEVAL_CONFIG,
    events: RetrievalEventSink = new NullRetrievalEventSink(),
  ) {
    if (
      index.embedding.id !== embeddingProvider.id ||
      index.embedding.dimensions !== embeddingProvider.dimensions
    ) {
      throw new Error("Retrieval embedding provider does not match the persisted index");
    }
    this.#index = index;
    this.#embeddingProvider = embeddingProvider;
    this.#config = config;
    this.#events = events;
  }

  public async search(query: string, options: SearchOptions = {}): Promise<readonly RetrievalResult[]> {
    const strategy = options.strategy ?? "hybrid";
    const limit = options.limit ?? this.#config.defaultLimit;
    if (query.trim() === "" || limit <= 0) {
      return [];
    }
    const units = Object.values(this.#index.units);
    const lexical =
      strategy === "semantic"
        ? []
        : searchBm25(this.#index, query, this.#config.bm25).slice(0, this.#config.candidateLimit);
    if (strategy !== "semantic") {
      this.#events.emit({
        type: "lexical_search_completed",
        occurredAt: new Date().toISOString(),
        repositoryId: this.#index.repository.id,
        data: { candidates: lexical.length },
      });
    }

    let semantic: ScoredUnit[] = [];
    if (strategy !== "lexical") {
      const queryIdentity = createHash("sha256").update(query).digest("hex");
      const queryEmbedding = (await this.#embeddingProvider.embed([{ identity: queryIdentity, text: query }]))[0];
      if (queryEmbedding === undefined) {
        throw new Error("Embedding provider did not return a query vector");
      }
      semantic = units
        .flatMap((unit) => {
          const vector = this.#index.embeddingCache[unit.embeddingKey];
          if (vector === undefined) {
            return [];
          }
          const score = cosineSimilarity(queryEmbedding.vector, vector);
          return score > 0 ? [{ unit, score }] : [];
        })
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.unit.path.localeCompare(right.unit.path) ||
            left.unit.startLine - right.unit.startLine,
        )
        .slice(0, this.#config.candidateLimit);
      this.#events.emit({
        type: "semantic_search_completed",
        occurredAt: new Date().toISOString(),
        repositoryId: this.#index.repository.id,
        data: { candidates: semantic.length },
      });
    }

    const candidates = new Map<string, Candidate>();
    const weightedScore = (candidate: Candidate): number =>
      candidate.score * this.#config.symbolKindWeights[candidate.unit.symbolKind];
    const addRanking = (
      ranking: readonly ScoredUnit[],
      signal: keyof RetrievalSignals,
      weight: number,
      strategyName: RetrievalReason["strategy"],
    ): void => {
      ranking.forEach((entry, index) => {
        const candidate = candidates.get(entry.unit.id) ?? {
          unit: entry.unit,
          score: 0,
          signals: {},
          reasons: [],
        };
        candidate.score += weight / (this.#config.reciprocalRankConstant + index + 1);
        candidate.signals[signal] = entry.score;
        candidate.reasons.push({
          strategy: strategyName,
          detail: `${strategyName} rank ${String(index + 1)}`,
        });
        candidates.set(entry.unit.id, candidate);
      });
    };

    addRanking(lexical, "lexical", this.#config.weights.lexical, "lexical");
    addRanking(semantic, "semantic", this.#config.weights.semantic, "semantic");
    if (strategy === "hybrid") {
      const symbols = symbolSignals(units, query);
      addRanking(symbols.exact, "exactSymbol", this.#config.weights.exactSymbol, "exact-symbol");
      addRanking(symbols.partial, "partialSymbol", this.#config.weights.partialSymbol, "partial-symbol");
      addRanking(pathSignals(units, query), "path", this.#config.weights.path, "path");
      if (options.expandGraph !== false) {
        const seedIds = [...candidates.values()]
          .sort(
            (left, right) =>
              weightedScore(right) - weightedScore(left) ||
              left.unit.path.localeCompare(right.unit.path) ||
              left.unit.startLine - right.unit.startLine,
          )
          .slice(0, Math.min(limit, 5))
          .map((candidate) => candidate.unit.id);
        const graph = new CodeGraph(this.#index);
        const graphBudget = options.graphEvidenceBudget ?? 20;
        const expanded = seedIds
          .flatMap((seedId) =>
            graph.expand([seedId], {
              maxDepth: options.graphDepth ?? 2,
              maxEvidence: graphBudget,
            }),
          )
          .filter(
            (item, index, values) =>
              values.findIndex((candidate) => candidate.unit.id === item.unit.id) === index,
          )
          .slice(0, graphBudget);
        for (const related of expanded) {
          const candidate = candidates.get(related.unit.id) ?? {
            unit: related.unit,
            score: 0,
            signals: {},
            reasons: [],
          };
          const graphSignal = 1 / related.depth;
          candidate.score +=
            (this.#config.weights.graph * graphSignal) /
            (this.#config.reciprocalRankConstant + related.depth);
          candidate.signals.graph = Math.max(candidate.signals.graph ?? 0, graphSignal);
          candidate.reasons.push({
            strategy: "graph",
            detail: `${related.edge.relation}: ${related.edge.provenance.reason}`,
          });
          candidates.set(related.unit.id, candidate);
        }
        this.#events.emit({
          type: "graph_expansion_completed",
          occurredAt: new Date().toISOString(),
          repositoryId: this.#index.repository.id,
          data: { expanded: expanded.length, depth: options.graphDepth ?? 2 },
        });
      }
    }

    const results = [...candidates.values()]
      .sort(
        (left, right) =>
          weightedScore(right) - weightedScore(left) ||
          left.unit.path.localeCompare(right.unit.path) ||
          left.unit.startLine - right.unit.startLine ||
          left.unit.id.localeCompare(right.unit.id),
      )
      .slice(0, limit)
      .map<RetrievalResult>((candidate, index) => ({
        evidence: evidenceFromUnit(this.#index, candidate.unit),
        rank: index + 1,
        score: weightedScore(candidate),
        signals: candidate.signals,
        reasons: candidate.reasons,
      }));
    this.#events.emit({
      type: "hybrid_search_completed",
      occurredAt: new Date().toISOString(),
      repositoryId: this.#index.repository.id,
      data: { results: results.length, strategy },
    });
    for (const result of results) {
      this.#events.emit({
        type: "evidence_selected",
        occurredAt: new Date().toISOString(),
        repositoryId: this.#index.repository.id,
        path: result.evidence.path,
        data: { rank: result.rank },
      });
    }
    return results;
  }
}

import type { GraphEdge, GraphNodeReference, RepositoryCodeIndex } from "../domain/code-index.js";
import {
  DEFAULT_EVIDENCE_BUDGET,
  type EvidenceBudget,
  type PlannedRetrieval,
  type RetrievalOperation,
  type RetrievalOperationKind,
} from "../domain/retrieval-plan.js";
import type { EmbeddingProvider } from "../domain/embedding.js";
import type { Evidence, RetrievalResult } from "../domain/evidence.js";
import { NullRetrievalEventSink, type RetrievalEventSink } from "../domain/observability.js";
import {
  GraphQueryService,
  type GraphPathResult,
  type GraphRelationResult,
} from "../graph/graph-query.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { CodeIndexReader } from "./index-reader.js";

export interface RetrievalPlannerOptions {
  readonly budget?: Partial<EvidenceBudget>;
  readonly allowBroadFallback?: boolean;
  readonly graphAwareHybrid?: boolean;
}

type GraphIntent =
  | "callers"
  | "callees"
  | "imports"
  | "exports"
  | "references"
  | "containing-symbol"
  | "contained-symbols"
  | "related-files"
  | "shortest-path";

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(1, Math.min(Math.floor(value ?? fallback), maximum));
}

function normalizeBudget(budget: Partial<EvidenceBudget> = {}): EvidenceBudget {
  return {
    graphDepth: boundedPositiveInteger(budget.graphDepth, DEFAULT_EVIDENCE_BUDGET.graphDepth, 10),
    graphNodes: boundedPositiveInteger(budget.graphNodes, DEFAULT_EVIDENCE_BUDGET.graphNodes, 500),
    retrievalCandidates: boundedPositiveInteger(
      budget.retrievalCandidates,
      DEFAULT_EVIDENCE_BUDGET.retrievalCandidates,
      500,
    ),
    finalEvidence: boundedPositiveInteger(
      budget.finalEvidence,
      DEFAULT_EVIDENCE_BUDGET.finalEvidence,
      100,
    ),
    sourceBytes: boundedPositiveInteger(budget.sourceBytes, DEFAULT_EVIDENCE_BUDGET.sourceBytes, 5_000_000),
    approximateTokens: boundedPositiveInteger(
      budget.approximateTokens,
      DEFAULT_EVIDENCE_BUDGET.approximateTokens,
      1_000_000,
    ),
  };
}

function graphIntent(query: string): GraphIntent | undefined {
  const normalized = query.toLowerCase();
  if (/\b(path|route|connects?|connection)\b/.test(normalized) && /\b(to|between)\b/.test(normalized)) {
    return "shortest-path";
  }
  if (/\b(callers?|where\s+is\s+.+\s+called|what\s+(?:code\s+)?calls)\b/.test(normalized)) {
    return "callers";
  }
  if (/\b(callees?|what\s+does\s+.+\s+call)\b/.test(normalized)) {
    return "callees";
  }
  if (/\b(imports?|imported\s+by)\b/.test(normalized)) {
    return "imports";
  }
  if (/\b(exports?|exported\s+by)\b/.test(normalized)) {
    return "exports";
  }
  if (/\b(references?|usages?|used\s+by|depends?\s+on)\b/.test(normalized)) {
    return "references";
  }
  if (/\b(containing|parent)\s+(symbol|declaration)\b/.test(normalized)) {
    return "containing-symbol";
  }
  if (/\b(contained|nested|children|child)\s+(symbols?|declarations?)\b/.test(normalized)) {
    return "contained-symbols";
  }
  if (/\brelated\s+files?\b/.test(normalized)) {
    return "related-files";
  }
  return undefined;
}

function mentionedSymbols(index: RepositoryCodeIndex, query: string): readonly string[] {
  const names = [...new Set(Object.values(index.units).map((unit) => unit.symbol))].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
  return names.flatMap((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).exec(query);
    return match === null ? [] : [{ name, index: match.index }];
  })
    .sort((left, right) => left.index - right.index || right.name.length - left.name.length)
    .map((entry) => entry.name);
}

function mentionedPaths(index: RepositoryCodeIndex, query: string): readonly string[] {
  return Object.keys(index.files)
    .filter((path) => query.includes(path))
    .sort((left, right) => left.localeCompare(right));
}

function quotedText(query: string): string | undefined {
  const match = query.match(/["'`]([^"'`]+)["'`]/);
  return match?.[1];
}

function isExactSymbolQuery(query: string, symbols: readonly string[]): boolean {
  const normalized = query.trim().replace(/[?.!]+$/, "").trim();
  return symbols.some((symbol) => normalized === symbol);
}

const LOW_INFORMATION_SYMBOLS = new Set([
  "config", "data", "name", "result", "session", "source", "state", "summarize", "value",
]);

function broadQueryFacets(query: string): readonly string[] {
  const separator = query.indexOf(":");
  if (separator < 0) return [query];
  const list = query
    .slice(separator + 1)
    .replace(/[.?!]\s+(?:cite|include|provide|show)\b[\s\S]*$/i, "")
    .trim();
  const facets = list
    .split(/,|\band\b/i)
    .map((part) => part.replace(/^[\s:;-]+|[\s.?!;:-]+$/g, "").trim())
    .filter((part) => part.length > 1 && part.length <= 100);
  if (facets.length < 2 || facets.length > 6) return [query];
  return [...new Set(facets)];
}

function expandPortfolioFacet(query: string): string {
  const normalized = query.toLowerCase();
  if (/\btechnolog(?:y|ies)\b|\btech stack\b/.test(normalized)) {
    return `${query} stack framework library React Next TypeScript Node dependency package`;
  }
  if (/\bprojects?\b/.test(normalized)) {
    return `${query} product professional freelance personal contribution outcome`;
  }
  if (/\bwork experience\b|\bemployment\b|\bcareer\b/.test(normalized)) {
    return `${query} employment employer company role career professional experience`;
  }
  if (/\bcontact\b/.test(normalized)) {
    return `${query} email github linkedin mailto`;
  }
  return query;
}

function interleaveRankings(
  rankings: readonly (readonly RetrievalResult[])[],
  limit: number,
): readonly RetrievalResult[] {
  const results: RetrievalResult[] = [];
  const seen = new Set<string>();
  const maximumLength = Math.max(0, ...rankings.map((ranking) => ranking.length));
  for (let rank = 0; rank < maximumLength && results.length < limit; rank += 1) {
    for (const ranking of rankings) {
      const result = ranking[rank];
      if (result === undefined || seen.has(result.evidence.id)) continue;
      seen.add(result.evidence.id);
      results.push({ ...result, rank: results.length + 1 });
      if (results.length >= limit) break;
    }
  }
  return results;
}

function operation(
  kind: RetrievalOperationKind,
  status: RetrievalOperation["status"],
  reason: string,
  resultCount = 0,
): RetrievalOperation {
  return { kind, status, reason, resultCount };
}

function relationOperation(intent: Exclude<GraphIntent, "shortest-path">): RetrievalOperationKind {
  const operations: Readonly<Record<Exclude<GraphIntent, "shortest-path">, RetrievalOperationKind>> = {
    callers: "graph-callers",
    callees: "graph-callees",
    imports: "graph-imports",
    exports: "graph-exports",
    references: "graph-references",
    "containing-symbol": "graph-containing-symbol",
    "contained-symbols": "graph-contained-symbols",
    "related-files": "graph-related-files",
  };
  return operations[intent];
}

function dedupeEdges(edges: readonly GraphEdge[]): readonly GraphEdge[] {
  const unique = new Map(edges.map((edge) => [edge.id, edge]));
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export class RetrievalPlanner {
  readonly #index: RepositoryCodeIndex;
  readonly #reader: CodeIndexReader;
  readonly #graph: GraphQueryService;
  readonly #retriever: HybridRetriever;
  readonly #events: RetrievalEventSink;

  public constructor(
    index: RepositoryCodeIndex,
    embeddingProvider: EmbeddingProvider,
    events: RetrievalEventSink = new NullRetrievalEventSink(),
  ) {
    this.#index = index;
    this.#reader = new CodeIndexReader(index);
    this.#graph = new GraphQueryService(index);
    this.#retriever = new HybridRetriever(index, embeddingProvider, undefined, events);
    this.#events = events;
  }

  public async retrieve(query: string, options: RetrievalPlannerOptions = {}): Promise<PlannedRetrieval> {
    const budget = normalizeBudget(options.budget);
    const operations: RetrievalOperation[] = [];
    const reasons: string[] = [];
    const deterministicResults: RetrievalResult[] = [];
    const graphEdges: GraphEdge[] = [];
    const mentioned = mentionedSymbols(this.#index, query);
    const paths = mentionedPaths(this.#index, query);
    const intent = graphIntent(query);
    const standaloneSymbol = isExactSymbolQuery(query, mentioned);
    const symbols = intent !== undefined || standaloneSymbol
      ? mentioned
      : mentioned.filter((symbol) => !LOW_INFORMATION_SYMBOLS.has(symbol.toLowerCase()));
    const explicitSymbolTarget = symbols.length > 0;

    const text = quotedText(query);
    if (text !== undefined) {
      const evidence = this.#reader.searchText(text, { limit: budget.finalEvidence });
      operations.push(operation("exact-text", "executed", `quoted text detected: ${text}`, evidence.length));
      reasons.push(`exact text detected: ${text}`);
      deterministicResults.push(...evidence.map((item, index) => this.#result(item, index, "exact text match")));
    }

    if (paths.length > 0) {
      const path = paths[0];
      if (path !== undefined) {
        operations.push(operation("exact-path", "executed", `exact indexed path detected: ${path}`, paths.length));
        reasons.push(`exact indexed path detected: ${path}`);
        const fileEvidence = this.#reader.findSymbolsInFile(path);
        if (fileEvidence.length === 0) {
          deterministicResults.push(
            this.#result(this.#reader.readFile(path, { startLine: 1, endLine: 1 }), deterministicResults.length, `exact path ${path}`),
          );
        } else {
          deterministicResults.push(
            ...fileEvidence.map((evidence) =>
              this.#result(evidence, deterministicResults.length, `symbol declared in exact path ${path}`),
            ),
          );
        }
      }
    }

    const disambiguatingPath = paths.length === 1 ? paths[0] : undefined;
    const resolutions = symbols.map((symbol) => ({
      symbol,
      resolution: this.#graph.getNodeBySymbol(symbol, disambiguatingPath),
    }));
    if (resolutions.length > 0) {
      const ambiguous = resolutions.filter((entry) => entry.resolution.status === "ambiguous");
      operations.push(
        operation(
          "exact-symbol",
          "executed",
          ambiguous.length === 0
            ? `exact symbol detected: ${symbols.join(", ")}`
            : `exact symbol is ambiguous: ${ambiguous.map((entry) => entry.symbol).join(", ")}`,
          resolutions.filter((entry) => entry.resolution.status === "resolved").length,
        ),
      );
      reasons.push(
        ambiguous.length === 0
          ? `exact symbol detected: ${symbols.join(", ")}`
          : `ambiguous symbol requires broader retrieval: ${ambiguous.map((entry) => entry.symbol).join(", ")}`,
      );
      for (const entry of resolutions) {
        if (entry.resolution.status === "resolved") {
          const evidence = this.#evidenceForNode(entry.resolution.node.reference);
          if (evidence !== undefined) {
            deterministicResults.push(
              this.#result(evidence, deterministicResults.length, `exact symbol ${entry.symbol}`, true),
            );
          }
        }
      }
    }

    const resolved = resolutions.flatMap((entry) =>
      entry.resolution.status === "resolved"
        ? [{ symbol: entry.symbol, node: entry.resolution.node }]
        : [],
    );
    const resolvedFiles = paths.flatMap((path) => {
      const resolution = this.#graph.getNodeByFile(path);
      return resolution.status === "resolved" ? [{ symbol: path, node: resolution.node }] : [];
    });
    const preferFileEntity = (intent === "imports" || intent === "exports") && resolvedFiles.length > 0;
    const graphEntities = preferFileEntity ? resolvedFiles : resolved.length > 0 ? resolved : resolvedFiles;
    let graphResultCount = 0;
    const firstResolved = graphEntities[0];
    const secondResolved = graphEntities[1];
    if (intent === "shortest-path" && firstResolved !== undefined && secondResolved !== undefined) {
      const path = this.#graph.shortestPath(
        firstResolved.node.reference,
        secondResolved.node.reference,
        { maxDepth: budget.graphDepth, maxNodes: budget.graphNodes },
      );
      graphResultCount = this.#appendPath(path, deterministicResults, graphEdges);
      operations.push(
        operation(
          "graph-shortest-path",
          "executed",
          `bounded path requested between ${firstResolved.symbol} and ${secondResolved.symbol}`,
          graphResultCount,
        ),
      );
      reasons.push(`graph operation: shortest path, depth <= ${String(budget.graphDepth)}`);
    } else if (
      intent !== undefined &&
      intent !== "shortest-path" &&
      firstResolved !== undefined &&
      secondResolved === undefined
    ) {
      const relationResults = this.#relationResults(intent, firstResolved.node.reference, budget);
      graphResultCount = relationResults.length;
      graphEdges.push(...relationResults.map((result) => result.edge));
      for (const result of relationResults) {
        const evidence = this.#evidenceForNode(result.node.reference);
        if (evidence !== undefined) {
          deterministicResults.push(
            this.#result(
              evidence,
              deterministicResults.length,
              `${result.edge.relation}: ${result.edge.provenance.reason}`,
            ),
          );
        }
      }
      operations.push(
        operation(
          relationOperation(intent),
          "executed",
          `graph operation ${intent} for ${firstResolved.symbol}`,
          graphResultCount,
        ),
      );
      reasons.push(`graph operation: ${intent}`);
    }

    const anyAmbiguous = resolutions.some((entry) => entry.resolution.status === "ambiguous");
    // A symbol name appearing in prose is not necessarily the user's target. Common
    // identifiers such as `source`, `name`, or `config` must not suppress broad
    // retrieval for summary and causal questions.
    const hasExplicitDeterministicTarget = text !== undefined || paths.length > 0 || explicitSymbolTarget;
    const deterministicEvidenceSufficient =
      !anyAmbiguous &&
      hasExplicitDeterministicTarget &&
      (deterministicResults.length > 0 && (intent === undefined || graphResultCount > 0));
    const allowBroadFallback = options.allowBroadFallback ?? true;
    let results = this.#dedupeResults(deterministicResults).slice(0, budget.finalEvidence);

    if (deterministicEvidenceSufficient || !allowBroadFallback) {
      const reason = deterministicEvidenceSufficient
        ? "deterministic evidence sufficient"
        : "broad fallback disabled";
      operations.push(operation("lexical", "skipped", reason));
      operations.push(operation("semantic-feature-vector", "skipped", reason));
      operations.push(operation("hybrid-fusion", "skipped", reason));
      reasons.push(`semantic feature-vector retrieval skipped: ${reason}`);
    } else {
      const graphAware = options.graphAwareHybrid ?? true;
      const facets = broadQueryFacets(query);
      const perFacetLimit = Math.max(
        budget.finalEvidence,
        Math.ceil(budget.retrievalCandidates / facets.length),
      );
      const expandedFacets = facets.map(expandPortfolioFacet);
      const structuralRankings = await Promise.all(expandedFacets.map((facet) => this.#retriever.search(facet, {
        strategy: "hybrid",
        limit: perFacetLimit,
        expandGraph: graphAware,
        includeExactSymbolSignals: explicitSymbolTarget,
        graphDepth: budget.graphDepth,
        graphEvidenceBudget: budget.graphNodes,
      })));
      const facetRankings = structuralRankings.map((ranking, index) => {
        if (facets.length === 1) return ranking;
        const fileResults = this.#reader.searchFileText(expandedFacets[index] ?? facets[index] ?? query, {
          limit: Math.min(4, perFacetLimit),
          contextLines: 12,
        }).map((evidence, resultIndex): RetrievalResult => ({
          evidence,
          rank: resultIndex + 1,
          score: 1 / (resultIndex + 1),
          signals: { lexical: 1 / (resultIndex + 1) },
          reasons: [{ strategy: "lexical", detail: `file-content rank ${String(resultIndex + 1)}` }],
        }));
        return this.#dedupeResults([...fileResults, ...ranking]).slice(0, perFacetLimit);
      });
      const broad = interleaveRankings(
        facetRankings,
        budget.retrievalCandidates,
      );
      operations.push(operation("lexical", "executed", "deterministic evidence was insufficient", broad.length));
      operations.push(
        operation(
          "semantic-feature-vector",
          "executed",
          "broader concept matching was required",
          broad.filter((result) => result.signals.semantic !== undefined).length,
        ),
      );
      operations.push(operation("hybrid-fusion", "executed", "combined heterogeneous rankings", broad.length));
      operations.push(
        operation(
          "graph-expansion",
          graphAware ? "executed" : "skipped",
          graphAware ? "expanded around high-ranked resolved symbols" : "graph expansion disabled",
          broad.filter((result) => result.signals.graph !== undefined).length,
        ),
      );
      reasons.push("broader lexical and feature-vector retrieval required");
      if (facets.length > 1) reasons.push(`compound query diversified across ${String(facets.length)} facets`);
      results = this.#dedupeResults([...deterministicResults, ...broad]).slice(0, budget.finalEvidence);
      const representedUnits = new Set(
        results
          .map((result) => result.evidence.provenance.unitId)
          .filter((id): id is string => id !== undefined),
      );
      graphEdges.push(
        ...this.#index.graphEdges.filter(
          (edge) =>
            edge.from.kind === "symbol" &&
            edge.to.kind === "symbol" &&
            representedUnits.has(edge.from.id) &&
            representedUnits.has(edge.to.id),
        ),
      );
    }

    const plan = { operations, reasons, deterministicEvidenceSufficient };
    this.#events.emit({
      type: "retrieval_plan_completed",
      occurredAt: new Date().toISOString(),
      repositoryId: this.#index.repository.id,
      data: {
        operationsExecuted: operations.filter((entry) => entry.status === "executed").length,
        semanticSkipped: operations.some(
          (entry) => entry.kind === "semantic-feature-vector" && entry.status === "skipped",
        ),
        results: results.length,
      },
    });
    return { query, plan, results, graphEdges: dedupeEdges(graphEdges), budget };
  }

  #relationResults(
    intent: Exclude<GraphIntent, "shortest-path">,
    node: GraphNodeReference,
    budget: EvidenceBudget,
  ): readonly GraphRelationResult[] {
    const limits = { maxDepth: budget.graphDepth, maxNodes: budget.graphNodes };
    switch (intent) {
      case "callers":
        return this.#graph.callers(node, limits);
      case "callees":
        return this.#graph.callees(node, limits);
      case "imports":
        return this.#graph.imports(node, limits);
      case "exports":
        return this.#graph.exports(node, limits);
      case "references":
        return this.#graph.references(node, limits);
      case "containing-symbol":
        return this.#graph.containingSymbol(node, limits);
      case "contained-symbols":
        return this.#graph.containedSymbols(node, limits);
      case "related-files":
        return this.#graph.relatedFiles(node, limits);
    }
  }

  #appendPath(
    path: GraphPathResult,
    results: RetrievalResult[],
    edges: GraphEdge[],
  ): number {
    if (path.status !== "found") {
      return 0;
    }
    edges.push(...path.edges);
    for (const node of path.nodes) {
      const evidence = this.#evidenceForNode(node.reference);
      if (evidence !== undefined) {
        results.push(this.#result(evidence, results.length, "member of bounded shortest path"));
      }
    }
    return path.nodes.length;
  }

  #evidenceForNode(node: GraphNodeReference): Evidence | undefined {
    if (node.kind === "symbol") {
      return this.#reader.readUnit(node.id);
    }
    const file = this.#index.files[node.id];
    return file === undefined ? undefined : this.#reader.readFile(node.id, { startLine: 1, endLine: 1 });
  }

  #result(evidence: Evidence, index: number, detail: string, exact = false): RetrievalResult {
    return {
      evidence,
      rank: index + 1,
      score: exact ? 1 : 1 / (index + 1),
      signals: exact ? { exactSymbol: 1 } : { graph: 1 },
      reasons: [{ strategy: exact ? "exact-symbol" : "graph", detail }],
    };
  }

  #dedupeResults(results: readonly RetrievalResult[]): readonly RetrievalResult[] {
    const unique = new Map<string, RetrievalResult>();
    for (const result of results) {
      if (!unique.has(result.evidence.id)) {
        unique.set(result.evidence.id, result);
      }
    }
    return [...unique.values()].map((result, index) => ({ ...result, rank: index + 1 }));
  }
}

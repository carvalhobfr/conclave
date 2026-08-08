import type { GraphEdge, RepositoryCodeIndex } from "../domain/code-index.js";
import type { EmbeddingProvider } from "../domain/embedding.js";
import type { Evidence, RetrievalResult } from "../domain/evidence.js";
import { CodeGraph } from "../graph/code-graph.js";
import { GraphQueryService } from "../graph/graph-query.js";
import { HybridRetriever, type SearchOptions } from "./hybrid-retriever.js";
import { CodeIndexReader, type FileRange, type TextSearchOptions } from "./index-reader.js";
import { RetrievalPlanner, type RetrievalPlannerOptions } from "./retrieval-planner.js";
import {
  DEFAULT_EVIDENCE_BUDGET,
  type EvidenceBudget,
  type PlannedRetrieval,
} from "../domain/retrieval-plan.js";
import type { ContextBundle } from "../domain/context-bundle.js";
import { ContextPacker } from "./context-packer.js";

export interface RelatedEvidence {
  readonly evidence: Evidence;
  readonly edge: GraphEdge;
  readonly direction: "outgoing" | "incoming";
}

export class CodeRetrievalService {
  readonly #index: RepositoryCodeIndex;
  readonly #reader: CodeIndexReader;
  readonly #retriever: HybridRetriever;
  readonly #graph: CodeGraph;
  readonly #graphQueries: GraphQueryService;
  readonly #planner: RetrievalPlanner;
  readonly #contextPacker: ContextPacker;

  public constructor(index: RepositoryCodeIndex, embeddingProvider: EmbeddingProvider) {
    this.#index = index;
    this.#reader = new CodeIndexReader(index);
    this.#retriever = new HybridRetriever(index, embeddingProvider);
    this.#graph = new CodeGraph(index);
    this.#graphQueries = new GraphQueryService(index);
    this.#planner = new RetrievalPlanner(index, embeddingProvider);
    this.#contextPacker = new ContextPacker(index);
  }

  public get graph(): GraphQueryService {
    return this.#graphQueries;
  }

  public get embedding(): RepositoryCodeIndex["embedding"] {
    return this.#index.embedding;
  }

  public search(query: string, options?: SearchOptions): Promise<readonly RetrievalResult[]> {
    return this.#retriever.search(query, options);
  }

  public retrieve(query: string, options?: RetrievalPlannerOptions): Promise<PlannedRetrieval> {
    return this.#planner.retrieve(query, options);
  }

  public packContext(retrieval: PlannedRetrieval): ContextBundle {
    return this.#contextPacker.pack(retrieval.results, retrieval.graphEdges, retrieval.budget);
  }

  public packResults(
    results: readonly RetrievalResult[],
    graphEdges: readonly GraphEdge[] = [],
    budget: EvidenceBudget = DEFAULT_EVIDENCE_BUDGET,
  ): ContextBundle {
    return this.#contextPacker.pack(results, graphEdges, budget);
  }

  public searchText(text: string, options?: TextSearchOptions): readonly Evidence[] {
    return this.#reader.searchText(text, options);
  }

  public findSymbol(name: string, path?: string): readonly Evidence[] {
    return this.#reader.findSymbol(name, path);
  }

  public findSymbolsInFile(path: string): readonly Evidence[] {
    return this.#reader.findSymbolsInFile(path);
  }

  public findReferences(symbol: string): readonly RelatedEvidence[] {
    const targets = new Set(
      this.#reader
        .findSymbol(symbol)
        .map((evidence) => evidence.provenance.unitId)
        .filter((id): id is string => id !== undefined),
    );
    return this.#index.graphEdges.flatMap((edge): RelatedEvidence[] => {
      if (
        edge.to.kind !== "symbol" ||
        !targets.has(edge.to.id) ||
        (edge.relation !== "references-symbol" && edge.relation !== "calls-symbol") ||
        edge.from.kind !== "symbol"
      ) {
        return [];
      }
      const evidence = this.#reader.readUnit(edge.from.id);
      return evidence === undefined ? [] : [{ evidence, edge, direction: "incoming" }];
    });
  }

  public findImports(pathOrSymbol: string): readonly RelatedEvidence[] {
    const fileExists = this.#index.files[pathOrSymbol] !== undefined;
    const targetUnitIds = new Set(
      fileExists
        ? []
        : this.#reader
            .findSymbol(pathOrSymbol)
            .map((evidence) => evidence.provenance.unitId)
            .filter((id): id is string => id !== undefined),
    );
    return this.#index.graphEdges.flatMap((edge): RelatedEvidence[] => {
      if (edge.relation !== "imports-symbol" || edge.to.kind !== "symbol") {
        return [];
      }
      if (fileExists && (edge.from.kind !== "file" || edge.from.id !== pathOrSymbol)) {
        return [];
      }
      if (!fileExists && !targetUnitIds.has(edge.to.id)) {
        return [];
      }
      if (fileExists) {
        const evidence = this.#reader.readUnit(edge.to.id);
        return evidence === undefined ? [] : [{ evidence, edge, direction: "outgoing" }];
      }
      const sourceLine = edge.provenance.line ?? 1;
      const evidence = this.#reader.readFile(edge.provenance.path, {
        startLine: sourceLine,
        endLine: sourceLine,
      });
      return [{ evidence, edge, direction: "incoming" }];
    });
  }

  public findRelated(symbol: string, maxDepth = 2, maxEvidence = 20): readonly RelatedEvidence[] {
    const startIds = this.#reader
      .findSymbol(symbol)
      .map((evidence) => evidence.provenance.unitId)
      .filter((id): id is string => id !== undefined);
    return this.#graph.expand(startIds, { maxDepth, maxEvidence }).flatMap((expanded) => {
      const evidence = this.#reader.readUnit(expanded.unit.id);
      return evidence === undefined
        ? []
        : [{ evidence, edge: expanded.edge, direction: expanded.direction }];
    });
  }

  public readEvidence(id: string): Evidence | undefined {
    return this.#reader.readEvidence(id);
  }

  public readUnit(id: string): Evidence | undefined {
    return this.#reader.readUnit(id);
  }

  public readFile(path: string, range?: FileRange): Evidence {
    return this.#reader.readFile(path, range);
  }
}

import type { GraphEdge, GraphNodeReference } from "../domain/code-index.js";
import type { Evidence } from "../domain/evidence.js";
import type {
  FollowUpRetrievalResult,
  ReasoningRetrievalRequest,
  RetrievalRequest,
} from "../domain/reasoning.js";
import { approximateTokenCount } from "../retrieval/context-packer.js";
import type { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import type { GraphRelationResult } from "../graph/graph-query.js";

export function retrievalRequestKey(request: RetrievalRequest): string {
  switch (request.kind) {
    case "symbol":
      return `symbol:${request.name}`;
    case "references":
    case "callers":
    case "callees":
      return `${request.kind}:${request.symbol}`;
    case "path":
      return `path:${request.from}:${request.to}:${String(request.maxDepth ?? "default")}`;
    case "text":
      return `text:${request.text}`;
    case "search":
      return `search:${request.query}`;
  }
}

function dedupeEvidence(evidence: readonly Evidence[], limit: number): readonly Evidence[] {
  return [...new Map(evidence.map((item) => [item.id, item])).values()].slice(0, limit);
}

function dedupeEdges(edges: readonly GraphEdge[]): readonly GraphEdge[] {
  return [...new Map(edges.map((edge) => [edge.id, edge])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export class FollowUpRetrievalExecutor {
  readonly #service: CodeRetrievalService;
  readonly #maxEvidence: number;
  readonly #maxGraphDepth: number;

  public constructor(service: CodeRetrievalService, maxEvidence: number, maxGraphDepth: number) {
    this.#service = service;
    this.#maxEvidence = maxEvidence;
    this.#maxGraphDepth = maxGraphDepth;
  }

  public async execute(record: ReasoningRetrievalRequest): Promise<FollowUpRetrievalResult> {
    const evidence: Evidence[] = [];
    const graphEdges: GraphEdge[] = [];
    const deterministicOperations: string[] = [];
    const request = record.request;
    switch (request.kind) {
      case "symbol":
        evidence.push(...this.#service.findSymbol(request.name));
        deterministicOperations.push("exact-symbol");
        break;
      case "references":
      case "callers":
      case "callees": {
        const resolution = this.#service.graph.getNodeBySymbol(request.symbol, undefined, this.#maxEvidence);
        deterministicOperations.push(`graph-${request.kind}`);
        if (resolution.status === "ambiguous") {
          deterministicOperations.push("ambiguous-symbol");
          break;
        }
        if (resolution.status === "resolved") {
          const limits = { maxDepth: 1, maxNodes: this.#maxEvidence };
          const relations =
            request.kind === "references"
              ? this.#service.graph.references(resolution.node.reference, limits)
              : request.kind === "callers"
                ? this.#service.graph.callers(resolution.node.reference, limits)
                : this.#service.graph.callees(resolution.node.reference, limits);
          this.#appendRelations(relations, evidence, graphEdges);
        }
        break;
      }
      case "path": {
        const maxDepth = Math.min(request.maxDepth ?? this.#maxGraphDepth, this.#maxGraphDepth);
        const path = this.#service.graph.shortestPathBetweenSymbols(request.from, request.to, {
          maxDepth,
          maxNodes: this.#maxEvidence * 4,
        });
        deterministicOperations.push("graph-shortest-path");
        if (path.status === "found") {
          graphEdges.push(...path.edges);
          for (const node of path.nodes) {
            const item = this.#evidenceForNode(node.reference);
            if (item !== undefined) evidence.push(item);
          }
        } else if (path.status === "ambiguous") {
          deterministicOperations.push("ambiguous-symbol");
        }
        break;
      }
      case "text":
        evidence.push(...this.#service.searchText(request.text, { limit: this.#maxEvidence }));
        deterministicOperations.push("exact-text");
        break;
      case "search": {
        const retrieval = await this.#service.retrieve(request.query, {
          budget: {
            graphDepth: this.#maxGraphDepth,
            graphNodes: this.#maxEvidence * 2,
            retrievalCandidates: this.#maxEvidence * 3,
            finalEvidence: this.#maxEvidence,
          },
        });
        evidence.push(...retrieval.results.map((result) => result.evidence));
        graphEdges.push(...retrieval.graphEdges);
        deterministicOperations.push(
          ...retrieval.plan.operations
            .filter((operation) => operation.status === "executed")
            .map((operation) => operation.kind),
        );
        break;
      }
    }
    const boundedEvidence = dedupeEvidence(evidence, this.#maxEvidence);
    const sourceBytes = boundedEvidence.reduce((total, item) => total + Buffer.byteLength(item.excerpt), 0);
    return {
      requestId: record.id,
      evidence: boundedEvidence,
      graphEdges: dedupeEdges(graphEdges),
      deterministicOperations: [...new Set(deterministicOperations)],
      approximateTokens: approximateTokenCount(sourceBytes),
    };
  }

  #appendRelations(
    relations: readonly GraphRelationResult[],
    evidence: Evidence[],
    graphEdges: GraphEdge[],
  ): void {
    for (const relation of relations) {
      graphEdges.push(relation.edge);
      const item = this.#evidenceForNode(relation.node.reference);
      if (item !== undefined) evidence.push(item);
    }
  }

  #evidenceForNode(reference: GraphNodeReference): Evidence | undefined {
    return reference.kind === "symbol"
      ? this.#service.readUnit(reference.id)
      : this.#service.readFile(reference.id, { startLine: 1, endLine: 1 });
  }
}

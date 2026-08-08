import type {
  GraphEdge,
  GraphNodeReference,
  GraphRelation,
  IndexedCodeUnit,
  RepositoryCodeIndex,
} from "../domain/code-index.js";

export interface GraphNode {
  readonly reference: GraphNodeReference;
  readonly path: string;
  readonly symbol?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface GraphQueryLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
}

export const DEFAULT_GRAPH_QUERY_LIMITS: GraphQueryLimits = {
  maxDepth: 2,
  maxNodes: 50,
  maxEdges: 100,
};

export type GraphNodeResolution =
  | { readonly status: "resolved"; readonly node: GraphNode }
  | { readonly status: "not-found"; readonly query: string }
  | {
      readonly status: "ambiguous";
      readonly query: string;
      readonly candidates: readonly GraphNode[];
    };

export interface GraphRelationResult {
  readonly node: GraphNode;
  readonly edge: GraphEdge;
  readonly direction: "incoming" | "outgoing";
}

export interface GraphSubgraph {
  readonly center: GraphNode;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly truncated: boolean;
  readonly limits: GraphQueryLimits;
}

export type GraphPathResult =
  | {
      readonly status: "found";
      readonly nodes: readonly GraphNode[];
      readonly edges: readonly GraphEdge[];
      readonly limits: GraphQueryLimits;
    }
  | {
      readonly status: "no-path";
      readonly from: GraphNode;
      readonly to: GraphNode;
      readonly limits: GraphQueryLimits;
    }
  | {
      readonly status: "not-found";
      readonly endpoint: "from" | "to";
      readonly query: string;
    }
  | {
      readonly status: "ambiguous";
      readonly endpoint: "from" | "to";
      readonly query: string;
      readonly candidates: readonly GraphNode[];
    };

interface AdjacentEdge {
  readonly edge: GraphEdge;
  readonly next: GraphNodeReference;
  readonly direction: GraphRelationResult["direction"];
}

const SYMBOL_PATH_RELATIONS = new Set<GraphRelation>([
  "calls-symbol",
  "references-symbol",
  "contains-symbol",
  "extends-symbol",
  "implements-symbol",
]);

function relationPriority(relation: GraphRelation): number {
  switch (relation) {
    case "calls-symbol":
      return 0;
    case "extends-symbol":
    case "implements-symbol":
      return 1;
    case "contains-symbol":
      return 2;
    case "references-symbol":
      return 3;
    default:
      return 4;
  }
}

function nodeKey(node: GraphNodeReference): string {
  return `${node.kind}:${node.id}`;
}

function normalizeLimits(limits: Partial<GraphQueryLimits> = {}): GraphQueryLimits {
  const integer = (value: number | undefined, fallback: number, maximum: number): number =>
    Math.max(0, Math.min(Math.floor(value ?? fallback), maximum));
  const maxNodes = integer(limits.maxNodes, DEFAULT_GRAPH_QUERY_LIMITS.maxNodes, 500);
  return {
    maxDepth: integer(limits.maxDepth, DEFAULT_GRAPH_QUERY_LIMITS.maxDepth, 10),
    maxNodes,
    maxEdges: integer(limits.maxEdges, Math.max(maxNodes * 2, 1), 1_000),
  };
}

function deterministicUnits(units: readonly IndexedCodeUnit[]): readonly IndexedCodeUnit[] {
  return [...units].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      left.id.localeCompare(right.id),
  );
}

export class GraphQueryService {
  readonly #index: RepositoryCodeIndex;
  readonly #adjacency = new Map<string, AdjacentEdge[]>();

  public constructor(index: RepositoryCodeIndex) {
    this.#index = index;
    for (const edge of index.graphEdges) {
      const outgoing = this.#adjacency.get(nodeKey(edge.from)) ?? [];
      outgoing.push({ edge, next: edge.to, direction: "outgoing" });
      this.#adjacency.set(nodeKey(edge.from), outgoing);
      const incoming = this.#adjacency.get(nodeKey(edge.to)) ?? [];
      incoming.push({ edge, next: edge.from, direction: "incoming" });
      this.#adjacency.set(nodeKey(edge.to), incoming);
    }
    for (const adjacent of this.#adjacency.values()) {
      adjacent.sort(
        (left, right) =>
          relationPriority(left.edge.relation) - relationPriority(right.edge.relation) ||
          left.edge.id.localeCompare(right.edge.id),
      );
    }
  }

  public getNodeBySymbol(symbol: string, path?: string, maxResults = 50): GraphNodeResolution {
    const candidates = deterministicUnits(
      Object.values(this.#index.units).filter(
        (unit) => unit.symbol === symbol && (path === undefined || unit.path === path),
      ),
    )
      .slice(0, Math.max(0, Math.min(Math.floor(maxResults), 500)))
      .map((unit) => this.#node({ kind: "symbol", id: unit.id }))
      .filter((node): node is GraphNode => node !== undefined);
    const query = path === undefined ? symbol : `${path}::${symbol}`;
    if (candidates.length === 0) {
      return { status: "not-found", query };
    }
    if (candidates.length > 1) {
      return { status: "ambiguous", query, candidates };
    }
    const node = candidates[0];
    return node === undefined ? { status: "not-found", query } : { status: "resolved", node };
  }

  public getNodeByFile(path: string): GraphNodeResolution {
    const node = this.#node({ kind: "file", id: path });
    return node === undefined ? { status: "not-found", query: path } : { status: "resolved", node };
  }

  public neighbors(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    return this.#relations(node, undefined, undefined, limits);
  }

  public incomingEdges(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    return this.#relations(node, "incoming", undefined, limits);
  }

  public outgoingEdges(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    return this.#relations(node, "outgoing", undefined, limits);
  }

  public callers(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    return this.#relations(node, "incoming", new Set<GraphRelation>(["calls-symbol"]), limits);
  }

  public callees(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    return this.#relations(node, "outgoing", new Set<GraphRelation>(["calls-symbol"]), limits);
  }

  public imports(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    return this.#relations(
      node,
      node.kind === "file" ? "outgoing" : "incoming",
      new Set<GraphRelation>(["imports-file", "imports-symbol"]),
      limits,
    );
  }

  public exports(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    return this.#relations(
      node,
      node.kind === "file" ? "outgoing" : "incoming",
      new Set<GraphRelation>(["exports-symbol"]),
      limits,
    );
  }

  public references(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    return this.#relations(
      node,
      "incoming",
      new Set<GraphRelation>(["references-symbol"]),
      limits,
    );
  }

  public containingSymbol(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    return this.#relations(node, "incoming", new Set<GraphRelation>(["contains-symbol"]), limits);
  }

  public containedSymbols(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    const normalized = normalizeLimits(limits);
    const subgraph = this.boundedSubgraph(node, normalized, "outgoing", new Set(["contains-symbol"]));
    return subgraph.edges.flatMap((edge): GraphRelationResult[] => {
      const related = this.#node(edge.to);
      return related === undefined ? [] : [{ node: related, edge, direction: "outgoing" }];
    });
  }

  public relatedFiles(
    node: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
  ): readonly GraphRelationResult[] {
    const normalized = normalizeLimits(limits);
    const subgraph = this.boundedSubgraph(node, normalized);
    const seen = new Set<string>();
    const results: GraphRelationResult[] = [];
    for (const edge of subgraph.edges) {
      for (const [reference, direction] of [
        [edge.from, "incoming"],
        [edge.to, "outgoing"],
      ] as const) {
        if (reference.kind !== "file" || seen.has(reference.id)) {
          continue;
        }
        const related = this.#node(reference);
        if (related !== undefined) {
          seen.add(reference.id);
          results.push({ node: related, edge, direction });
        }
      }
    }
    return results.slice(0, normalized.maxNodes);
  }

  public boundedSubgraph(
    center: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
    direction: "incoming" | "outgoing" | "both" = "both",
    relations?: ReadonlySet<GraphRelation>,
  ): GraphSubgraph {
    const normalized = normalizeLimits(limits);
    const centerNode = this.#node(center);
    if (centerNode === undefined) {
      throw new Error(`Graph node does not exist: ${nodeKey(center)}`);
    }
    if (normalized.maxNodes === 0) {
      return { center: centerNode, nodes: [], edges: [], truncated: true, limits: normalized };
    }
    const visited = new Map<string, GraphNode>([[nodeKey(center), centerNode]]);
    const queued: { readonly reference: GraphNodeReference; readonly depth: number }[] = [
      { reference: center, depth: 0 },
    ];
    let truncated = false;
    while (queued.length > 0) {
      const current = queued.shift();
      if (current === undefined) {
        break;
      }
      if (current.depth >= normalized.maxDepth) {
        continue;
      }
      for (const adjacent of this.#adjacent(current.reference, direction, relations)) {
        const key = nodeKey(adjacent.next);
        if (visited.has(key)) {
          continue;
        }
        if (visited.size >= normalized.maxNodes) {
          truncated = true;
          break;
        }
        const next = this.#node(adjacent.next);
        if (next !== undefined) {
          visited.set(key, next);
          queued.push({ reference: adjacent.next, depth: current.depth + 1 });
        }
      }
      if (truncated) {
        break;
      }
    }
    const included = new Set(visited.keys());
    const edges = this.#index.graphEdges
      .filter(
        (edge) =>
          included.has(nodeKey(edge.from)) &&
          included.has(nodeKey(edge.to)) &&
          (relations === undefined || relations.has(edge.relation)),
      )
      .slice(0, normalized.maxEdges);
    if (edges.length >= normalized.maxEdges && this.#index.graphEdges.length > edges.length) {
      truncated = true;
    }
    return { center: centerNode, nodes: [...visited.values()], edges, truncated, limits: normalized };
  }

  public shortestPath(
    from: GraphNodeReference,
    to: GraphNodeReference,
    limits: Partial<GraphQueryLimits> = {},
    direction: "outgoing" | "both" = "outgoing",
    relations?: ReadonlySet<GraphRelation>,
  ): GraphPathResult {
    const normalized = normalizeLimits(limits);
    const fromNode = this.#node(from);
    const toNode = this.#node(to);
    if (fromNode === undefined || toNode === undefined) {
      throw new Error("Shortest path requires existing graph nodes");
    }
    const fromKey = nodeKey(from);
    const toKey = nodeKey(to);
    const allowedRelations =
      relations ?? (from.kind === "symbol" && to.kind === "symbol" ? SYMBOL_PATH_RELATIONS : undefined);
    if (fromKey === toKey) {
      return { status: "found", nodes: [fromNode], edges: [], limits: normalized };
    }
    const visited = new Set<string>([fromKey]);
    const previous = new Map<string, { readonly key: string; readonly edge: GraphEdge }>();
    const references = new Map<string, GraphNodeReference>([[fromKey, from], [toKey, to]]);
    const queued: { readonly reference: GraphNodeReference; readonly depth: number }[] = [
      { reference: from, depth: 0 },
    ];
    let found = false;
    while (queued.length > 0 && visited.size < normalized.maxNodes) {
      const current = queued.shift();
      if (current === undefined) {
        break;
      }
      if (current.depth >= normalized.maxDepth) {
        continue;
      }
      for (const adjacent of this.#adjacent(current.reference, direction, allowedRelations)) {
        const key = nodeKey(adjacent.next);
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        references.set(key, adjacent.next);
        previous.set(key, { key: nodeKey(current.reference), edge: adjacent.edge });
        if (key === toKey) {
          found = true;
          break;
        }
        if (visited.size >= normalized.maxNodes) {
          break;
        }
        queued.push({ reference: adjacent.next, depth: current.depth + 1 });
      }
      if (found) {
        break;
      }
    }
    if (!found) {
      return { status: "no-path", from: fromNode, to: toNode, limits: normalized };
    }
    const reversedNodes: GraphNode[] = [toNode];
    const reversedEdges: GraphEdge[] = [];
    let cursor = toKey;
    while (cursor !== fromKey) {
      const step = previous.get(cursor);
      if (step === undefined) {
        return { status: "no-path", from: fromNode, to: toNode, limits: normalized };
      }
      reversedEdges.push(step.edge);
      cursor = step.key;
      const reference = references.get(cursor);
      const node = reference === undefined ? undefined : this.#node(reference);
      if (node !== undefined) {
        reversedNodes.push(node);
      }
    }
    return {
      status: "found",
      nodes: reversedNodes.reverse(),
      edges: reversedEdges.reverse(),
      limits: normalized,
    };
  }

  public shortestPathBetweenSymbols(
    fromSymbol: string,
    toSymbol: string,
    limits: Partial<GraphQueryLimits> = {},
    fromPath?: string,
    toPath?: string,
  ): GraphPathResult {
    const from = this.getNodeBySymbol(fromSymbol, fromPath);
    if (from.status !== "resolved") {
      return from.status === "ambiguous"
        ? { status: "ambiguous", endpoint: "from", query: from.query, candidates: from.candidates }
        : { status: "not-found", endpoint: "from", query: from.query };
    }
    const to = this.getNodeBySymbol(toSymbol, toPath);
    if (to.status !== "resolved") {
      return to.status === "ambiguous"
        ? { status: "ambiguous", endpoint: "to", query: to.query, candidates: to.candidates }
        : { status: "not-found", endpoint: "to", query: to.query };
    }
    return this.shortestPath(
      from.node.reference,
      to.node.reference,
      limits,
      "outgoing",
      SYMBOL_PATH_RELATIONS,
    );
  }

  #relations(
    node: GraphNodeReference,
    direction: GraphRelationResult["direction"] | undefined,
    relations: ReadonlySet<GraphRelation> | undefined,
    limits: Partial<GraphQueryLimits>,
  ): readonly GraphRelationResult[] {
    const normalized = normalizeLimits(limits);
    const results: GraphRelationResult[] = [];
    const seen = new Set<string>();
    for (const adjacent of this.#adjacent(node, direction ?? "both", relations)) {
      const key = `${adjacent.edge.id}:${nodeKey(adjacent.next)}`;
      if (seen.has(key)) {
        continue;
      }
      const related = this.#node(adjacent.next);
      if (related !== undefined) {
        seen.add(key);
        results.push({ node: related, edge: adjacent.edge, direction: adjacent.direction });
      }
      if (results.length >= Math.min(normalized.maxNodes, normalized.maxEdges)) {
        break;
      }
    }
    return results;
  }

  #adjacent(
    node: GraphNodeReference,
    direction: "incoming" | "outgoing" | "both",
    relations?: ReadonlySet<GraphRelation>,
  ): readonly AdjacentEdge[] {
    return (this.#adjacency.get(nodeKey(node)) ?? []).filter(
      (adjacent) =>
        (direction === "both" || adjacent.direction === direction) &&
        (relations === undefined || relations.has(adjacent.edge.relation)),
    );
  }

  #node(reference: GraphNodeReference): GraphNode | undefined {
    if (reference.kind === "file") {
      return this.#index.files[reference.id] === undefined
        ? undefined
        : { reference, path: reference.id };
    }
    const unit = this.#index.units[reference.id];
    return unit === undefined
      ? undefined
      : {
          reference,
          path: unit.path,
          symbol: unit.symbol,
          startLine: unit.startLine,
          endLine: unit.endLine,
        };
  }
}

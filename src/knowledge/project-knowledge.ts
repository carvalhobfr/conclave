import type { GraphEdge, RepositoryCodeIndex } from "../domain/code-index.js";
import type { QueryAssessment, QueryKind } from "../domain/adaptive-reasoning.js";
import type { Evidence, RetrievalResult } from "../domain/evidence.js";
import type { RetrievalOperationKind } from "../domain/retrieval-plan.js";
import { GraphQueryService, type GraphNode, type GraphRelationResult } from "../graph/graph-query.js";
import { CodeIndexReader } from "../retrieval/index-reader.js";

export interface ProjectKnowledgeStats {
  readonly files: number;
  readonly symbols: number;
  readonly graphNodes: number;
  readonly graphEdges: number;
}

export interface DeterministicAnswer {
  readonly queryKind: Extract<QueryKind, "exact-lookup" | "relationship">;
  readonly answer: string;
  readonly evidence: readonly Evidence[];
  readonly graphEdges: readonly GraphEdge[];
  readonly operations: readonly RetrievalOperationKind[];
  readonly resolvedEntities: readonly string[];
  readonly ambiguity: "low" | "medium" | "high";
  readonly limitations: readonly string[];
}

interface ParsedQuery {
  readonly kind: "definition" | "callers" | "callees" | "references" | "imports" | "exports" | "path";
  readonly entities: readonly string[];
  readonly rawTarget?: string;
}

const IDENTIFIER = "([A-Za-z_$][A-Za-z0-9_$]*)";

function cleanEntity(value: string): string {
  return value.trim().replace(/^[`'"]|[`'"]$/g, "").replace(/\(\)$/u, "");
}

function parseQuery(question: string): ParsedQuery | undefined {
  const value = question.trim().replace(/[?.!]+$/u, "");
  const patterns: readonly [RegExp, ParsedQuery["kind"], (match: RegExpExecArray) => readonly string[]][] = [
    [new RegExp(`^where\\s+(?:is|are)\\s+${IDENTIFIER}\\s*(?:\\(\\))?\\s+(?:defined|declared|implemented)$`, "i"), "definition", (match) => [match[1] ?? ""]],
    [new RegExp(`^where\\s+(?:is|are)\\s+${IDENTIFIER}\\s*(?:\\(\\))?\\s+called$`, "i"), "callers", (match) => [match[1] ?? ""]],
    [new RegExp(`^(?:who|what)\\s+calls\\s+${IDENTIFIER}\\s*(?:\\(\\))?$`, "i"), "callers", (match) => [match[1] ?? ""]],
    [new RegExp(`^what\\s+does\\s+${IDENTIFIER}\\s*(?:\\(\\))?\\s+call$`, "i"), "callees", (match) => [match[1] ?? ""]],
    [new RegExp(`^where\\s+(?:is|are)\\s+${IDENTIFIER}\\s*(?:\\(\\))?\\s+referenced$`, "i"), "references", (match) => [match[1] ?? ""]],
    [new RegExp(`^what\\s+imports\\s+${IDENTIFIER}\\s*(?:\\(\\))?$`, "i"), "imports", (match) => [match[1] ?? ""]],
    [new RegExp(`^(?:which|what)\\s+file\\s+exports\\s+${IDENTIFIER}\\s*(?:\\(\\))?$`, "i"), "exports", (match) => [match[1] ?? ""]],
    [new RegExp(`^(?:what\\s+does|what)\\s+(.+?)\\s+import$`, "i"), "imports", (match) => [match[1] ?? ""]],
    [new RegExp(`^(?:what\\s+is\\s+the\\s+)?path\\s+(between|from)\\s+${IDENTIFIER}\\s+(and|to)\\s+${IDENTIFIER}$`, "i"), "path", (match) => [match[2] ?? "", match[4] ?? ""]],
  ];
  for (const [pattern, kind, entities] of patterns) {
    const match = pattern.exec(value);
    if (match !== null) {
      const parsed = entities(match).map(cleanEntity).filter(Boolean);
      return { kind, entities: parsed, ...(kind === "imports" ? { rawTarget: parsed[0] } : {}) };
    }
  }
  return undefined;
}

function evidenceLine(item: Evidence): string {
  return `${item.path}:${String(item.startLine)}${item.symbol === undefined ? "" : ` — ${item.symbol}()`}`;
}

function nodeLabel(node: GraphNode): string {
  return node.symbol ?? node.path;
}

function dedupe<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export class ProjectKnowledge {
  public readonly repositoryId: string;
  public readonly version: string;
  public readonly stats: ProjectKnowledgeStats;
  readonly #index: RepositoryCodeIndex;
  readonly #reader: CodeIndexReader;
  readonly #graph: GraphQueryService;

  public constructor(index: RepositoryCodeIndex) {
    this.#index = index;
    this.#reader = new CodeIndexReader(index);
    this.#graph = new GraphQueryService(index);
    this.repositoryId = index.repository.id;
    this.version = `${String(index.schemaVersion)}:${String(index.indexingVersion)}:${index.updatedAt}`;
    this.stats = {
      files: Object.keys(index.files).length,
      symbols: Object.keys(index.units).length,
      graphNodes: Object.keys(index.files).length + Object.keys(index.units).length,
      graphEdges: index.graphEdges.length,
    };
  }

  public assess(question: string, intent: "ask" | "investigate" | "task" = "ask"): QueryAssessment {
    const parsed = parseQuery(question);
    const causal = /\b(why|cause|causal|might|disappear|race|lifecycle|refresh|initiali[sz]|cleanup)\b/iu.test(question);
    const comparison = /\b(compare|difference|versus|vs\.?|better)\b/iu.test(question);
    const locationQuestion = /\b(where|which\s+file|find|locate)\b/iu.test(question);
    const securitySensitive = /\b(auth(?:entication|orization)?|credential|token|crypto(?:graphy)?|permission|secret)\b/iu.test(question);
    const explicitFiles = Object.keys(this.#index.files).filter((path) => question.includes(path)).slice(0, 20);
    const mentioned = [...new Set(Object.values(this.#index.units)
      .filter((unit) => new RegExp(`(^|[^A-Za-z0-9_$])${unit.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_$]|$)`, "u").test(question))
      .map((unit) => unit.symbol))];
    const entities = [...new Set([...(parsed?.entities ?? []), ...mentioned])];
    const entityFiles = [...new Set(entities.flatMap((entity) => this.#reader.findSymbol(entity).map((item) => item.path)))];
    const relevantFiles = [...new Set([...explicitFiles, ...entityFiles])].slice(0, 20);
    const ambiguousEntities = entities.filter((entity) => this.#reader.findSymbol(entity).length > 1);
    const kind: QueryKind = intent === "task"
      ? "task"
      : parsed === undefined
        ? causal
          ? "causal"
          : comparison
            ? "comparison"
            : entities.length > 0 || explicitFiles.length > 0
              ? "explanation"
              : locationQuestion ? "explanation" : "ambiguous"
        : parsed.kind === "definition" ? "exact-lookup" : "relationship";
    const deterministic = parsed === undefined ? undefined : this.answer(question);
    const coverage = deterministic === undefined ? entities.length > 0 ? "partial" : "none" : "strong";
    const ambiguity = ambiguousEntities.length > 0
      ? "high"
      : kind === "ambiguous" || (causal && entities.length === 0)
        ? "high"
        : relevantFiles.length > 3 || entities.length > 2
          ? "medium"
          : "low";
    const signals = [
      ...(parsed === undefined ? [] : [`pattern:${parsed.kind}`]),
      ...(entities.length === 0 ? [] : [`resolved-entities:${String(entities.length)}`]),
      ...(explicitFiles.length === 0 ? [] : [`explicit-paths:${String(explicitFiles.length)}`]),
      ...(causal ? ["causal-language"] : []),
      ...(locationQuestion ? ["location-language"] : []),
      ...(securitySensitive ? ["security-sensitive-language"] : []),
      ...(relevantFiles.length > 1 ? ["cross-module"] : []),
      ...(ambiguousEntities.length > 0 ? ["ambiguous-symbol"] : []),
      ...(deterministic === undefined ? [] : ["deterministic-answer-available"]),
    ];
    return {
      queryKind: kind,
      resolvedEntities: entities,
      relevantFiles,
      crossModule: relevantFiles.length > 1,
      ambiguity,
      deterministicCoverage: coverage,
      requiresModelReasoning: deterministic === undefined,
      signals,
    };
  }

  public answer(question: string): DeterministicAnswer | undefined {
    const parsed = parseQuery(question);
    if (parsed === undefined) return undefined;
    if (parsed.kind === "path") return this.#pathAnswer(parsed.entities[0] ?? "", parsed.entities[1] ?? "");
    const entity = parsed.entities[0];
    if (entity === undefined) return undefined;
    if (parsed.kind === "definition") return this.#definitionAnswer(entity);
    return this.#relationshipAnswer(parsed.kind, entity, parsed.rawTarget);
  }

  public asRetrievalResults(answer: DeterministicAnswer): readonly RetrievalResult[] {
    return answer.evidence.map((evidence, index) => ({
      evidence,
      rank: index + 1,
      score: 1,
      signals: { exactSymbol: 1, graph: answer.graphEdges.length > 0 ? 1 : 0 },
      reasons: [{ strategy: answer.graphEdges.length > 0 ? "graph" : "exact-symbol", detail: "Project Knowledge deterministic answer" }],
    }));
  }

  #definitionAnswer(symbol: string): DeterministicAnswer {
    const evidence = this.#reader.findSymbol(symbol);
    const ambiguous = evidence.length > 1;
    const answer = evidence.length === 0
      ? `No statically indexed definition named ${symbol} was found.`
      : ambiguous
        ? `${symbol} has ${String(evidence.length)} indexed definitions:\n${evidence.map((item) => `- ${evidenceLine(item)}`).join("\n")}\n\nThe symbol name is ambiguous; qualify it with a file path.`
        : `${symbol} is defined at ${evidenceLine(evidence[0] as Evidence)}.`;
    return {
      queryKind: "exact-lookup",
      answer,
      evidence,
      graphEdges: [],
      operations: ["exact-symbol"],
      resolvedEntities: evidence.length === 0 ? [] : [symbol],
      ambiguity: ambiguous ? "high" : "low",
      limitations: ["Definitions come from the safely indexed structural parser."],
    };
  }

  #relationshipAnswer(
    kind: Exclude<ParsedQuery["kind"], "definition" | "path">,
    entity: string,
    rawTarget?: string,
  ): DeterministicAnswer {
    const fileResolution = rawTarget === undefined ? undefined : this.#graph.getNodeByFile(rawTarget);
    const resolution = fileResolution?.status === "resolved" ? fileResolution : this.#graph.getNodeBySymbol(entity);
    const operation: RetrievalOperationKind = kind === "callers" ? "graph-callers"
      : kind === "callees" ? "graph-callees"
        : kind === "references" ? "graph-references"
          : kind === "imports" ? "graph-imports"
            : "graph-exports";
    if (resolution.status === "not-found") {
      return {
        queryKind: "relationship",
        answer: `No statically indexed symbol or file named ${entity} was found.`,
        evidence: [], graphEdges: [], operations: ["exact-symbol", operation], resolvedEntities: [], ambiguity: "low",
        limitations: ["Only safely indexed source files are searched."],
      };
    }
    if (resolution.status === "ambiguous") {
      const evidence = resolution.candidates.flatMap((node) => this.#evidenceForNode(node));
      return {
        queryKind: "relationship",
        answer: `${entity} resolves to ${String(resolution.candidates.length)} symbols:\n${resolution.candidates.map((node) => `- ${node.path}:${String(node.startLine ?? 1)} — ${nodeLabel(node)}`).join("\n")}\n\nQualify the symbol with a path before treating relationships as unique.`,
        evidence, graphEdges: [], operations: ["exact-symbol", operation], resolvedEntities: [entity], ambiguity: "high",
        limitations: ["Ambiguous symbols are never merged into a supposedly unique relationship."],
      };
    }
    const relations: readonly GraphRelationResult[] = kind === "callers" ? this.#graph.callers(resolution.node.reference)
      : kind === "callees" ? this.#graph.callees(resolution.node.reference)
        : kind === "references" ? this.#graph.references(resolution.node.reference)
          : kind === "imports" ? this.#graph.imports(resolution.node.reference)
            : this.#graph.exports(resolution.node.reference);
    const relationLabel = kind === "callers" ? "statically resolved caller"
      : kind === "callees" ? "statically resolved callee"
        : kind === "references" ? "statically resolved reference"
          : kind === "imports" ? "resolved importer/import"
            : "resolved exporting file";
    const targetEvidence = this.#evidenceForNode(resolution.node);
    const relationEvidence = relations.flatMap((relation) => {
      const nodeEvidence = this.#evidenceForNode(relation.node);
      if (nodeEvidence.length > 0) return nodeEvidence;
      const line = relation.edge.provenance.line ?? 1;
      return [this.#reader.readFile(relation.edge.provenance.path, { startLine: line, endLine: line })];
    });
    const evidence = dedupe([...targetEvidence, ...relationEvidence]);
    const relationshipLines = relations.map((relation) => {
      const source = relation.direction === "incoming" ? nodeLabel(relation.node) : nodeLabel(resolution.node);
      const target = relation.direction === "incoming" ? nodeLabel(resolution.node) : nodeLabel(relation.node);
      return `- ${source} → ${target}\n  ${relation.node.path}:${String(relation.node.startLine ?? relation.edge.provenance.line ?? 1)}`;
    });
    const answer = relations.length === 0
      ? `${entity} has no ${relationLabel}s in the bounded static graph.`
      : `${entity} has ${String(relations.length)} ${relationLabel}${relations.length === 1 ? "" : "s"}:\n${relationshipLines.join("\n")}\n\nRelationship provenance: ${[...new Set(relations.map((item) => item.edge.provenance.kind))].join(" and ")} static code analysis.`;
    return {
      queryKind: "relationship",
      answer,
      evidence,
      graphEdges: relations.map((relation) => relation.edge),
      operations: [resolution.node.reference.kind === "file" ? "exact-path" : "exact-symbol", operation],
      resolvedEntities: [entity],
      ambiguity: "low",
      limitations: ["Dynamic dispatch, runtime reflection, and unresolved external imports may not appear in the static graph."],
    };
  }

  #pathAnswer(from: string, to: string): DeterministicAnswer {
    const path = this.#graph.shortestPathBetweenSymbols(from, to, { maxDepth: 6, maxNodes: 100, maxEdges: 200 });
    if (path.status === "ambiguous") {
      const evidence = path.candidates.flatMap((node) => this.#evidenceForNode(node));
      return {
        queryKind: "relationship", answer: `${path.endpoint} endpoint ${path.query} is ambiguous; qualify it with a file path.`, evidence,
        graphEdges: [], operations: ["exact-symbol", "graph-shortest-path"], resolvedEntities: [from, to], ambiguity: "high",
        limitations: ["No path is asserted across ambiguous symbol identities."],
      };
    }
    if (path.status === "not-found") {
      return {
        queryKind: "relationship", answer: `${path.endpoint} endpoint ${path.query} was not found in Project Knowledge.`, evidence: [],
        graphEdges: [], operations: ["exact-symbol", "graph-shortest-path"], resolvedEntities: [], ambiguity: "low",
        limitations: ["Only safely indexed structural symbols are available."],
      };
    }
    if (path.status === "no-path") {
      const evidence = dedupe([...this.#evidenceForNode(path.from), ...this.#evidenceForNode(path.to)]);
      return {
        queryKind: "relationship", answer: `No bounded static path from ${from} to ${to} was found within depth ${String(path.limits.maxDepth)}.`, evidence,
        graphEdges: [], operations: ["exact-symbol", "graph-shortest-path"], resolvedEntities: [from, to], ambiguity: "low",
        limitations: ["Absence of a static path does not rule out runtime or unresolved external behavior."],
      };
    }
    const evidence = dedupe(path.nodes.flatMap((node) => this.#evidenceForNode(node)));
    return {
      queryKind: "relationship",
      answer: `Static path:\n${path.nodes.map(nodeLabel).join(" → ")}\n\n${path.edges.map((edge) => `${edge.relation} · ${edge.provenance.path}:${String(edge.provenance.line ?? 1)} · ${edge.provenance.kind}`).join("\n")}`,
      evidence,
      graphEdges: path.edges,
      operations: ["exact-symbol", "graph-shortest-path"],
      resolvedEntities: [from, to],
      ambiguity: "low",
      limitations: ["The path contains only extracted or resolved deterministic graph edges."],
    };
  }

  #evidenceForNode(node: GraphNode): readonly Evidence[] {
    if (node.reference.kind === "symbol") {
      const evidence = this.#reader.readUnit(node.reference.id);
      return evidence === undefined ? [] : [evidence];
    }
    return [this.#reader.readFile(node.path, { startLine: 1, endLine: 1 })];
  }
}

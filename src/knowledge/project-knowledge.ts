import { createHash } from "node:crypto";

import type { GraphEdge, RepositoryCodeIndex } from "../domain/code-index.js";
import type { QueryAssessment, QueryKind } from "../domain/adaptive-reasoning.js";
import type { DecisionClaim, DecisionClaimKind } from "../domain/decision.js";
import type { Evidence, RetrievalResult } from "../domain/evidence.js";
import type {
  ChangedSymbol,
  ConfirmedProperty,
  ImpactedSymbol,
  ReviewedFile,
  ReviewImpactAnalysis,
  ReviewUncertainty,
  ReviewVerdictFinding,
  ReviewVerdictStatus,
} from "../domain/review.js";
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

export interface DiffKnowledgeReview {
  readonly assessment: QueryAssessment;
  readonly changedFiles: readonly ReviewedFile[];
  readonly findings: readonly ReviewVerdictFinding[];
  readonly confirmedProperties: readonly ConfirmedProperty[];
  readonly uncertainty: readonly ReviewUncertainty[];
  readonly impact: ReviewImpactAnalysis;
  readonly evidence: readonly Evidence[];
  readonly deterministicStatus?: ReviewVerdictStatus;
  readonly reasonCodes: readonly string[];
  readonly limitations: readonly string[];
}

export interface ProposalKnowledgeValidation {
  readonly assessment: QueryAssessment;
  readonly claims: readonly DecisionClaim[];
  readonly evidence: readonly Evidence[];
  readonly deterministicComplete: boolean;
  readonly reasonCodes: readonly string[];
}

interface DiffRange {
  readonly startLine: number;
  readonly endLine: number;
}

interface AddedDiffLine {
  readonly line: number;
  readonly text: string;
}

interface ParsedDiffFile {
  readonly path: string;
  changeType: ReviewedFile["changeType"];
  additions: number;
  deletions: number;
  hunks: number;
  readonly ranges: DiffRange[];
  readonly addedLines: AddedDiffLine[];
}

interface ParsedDiff {
  readonly files: readonly ParsedDiffFile[];
  readonly errors: readonly string[];
}

interface ParsedQuery {
  readonly kind: "definition" | "callers" | "callees" | "references" | "imports" | "exports" | "path";
  readonly entities: readonly string[];
  readonly rawTarget?: string;
}

const IDENTIFIER = "([A-Za-z_$][A-Za-z0-9_$]*)";
const DOCUMENTATION_PATH = /(?:^|\/)(?:docs?\/.*|[^/]+\.(?:md|mdx|rst|adoc|txt))$/iu;
const SECURITY_PATH = /(?:^|\/)(?:auth|security|crypto|credentials?|permissions?|secrets?)(?:\/|\.|$)/iu;
const TYPE_ONLY_SYMBOLS = new Set(["interface", "type-alias"]);
const IMPACT_LIMITS = { maxChangedSymbols: 100, maxImpactedSymbols: 100, maxGraphEdges: 250 } as const;

function secretType(value: string): ReviewVerdictFinding["secretType"] | undefined {
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u.test(value)) return "private-key";
  if (/\bAKIA[0-9A-Z]{16}\b/u.test(value)) return "aws-access-key";
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/u.test(value)) return "github-token";
  if (/\b(?:sk|rk)-(?:live|test)-[A-Za-z0-9_-]{16,}\b/u.test(value)) return "provider-token";
  const assigned = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["'`]([^"'`\s]{20,})["'`]/iu.exec(value)?.[1];
  if (assigned !== undefined && /[A-Za-z]/u.test(assigned) && /[0-9]/u.test(assigned) && !/(?:example|placeholder|redacted|process\.env)/iu.test(assigned)) return "credential-assignment";
  return undefined;
}

function reviewId(category: ReviewVerdictFinding["category"], path: string, line: number, statement: string): string {
  return `review_${createHash("sha256").update(`${category}\0${path}\0${String(line)}\0${statement}`).digest("hex").slice(0, 24)}`;
}

function knowledgeId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

function safeDiffPath(path: string): boolean {
  return path.length > 0
    && path.length <= 500
    && !path.startsWith("/")
    && !/[\0\r\n]/u.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function parseUnifiedDiff(unifiedDiff: string): ParsedDiff {
  if (unifiedDiff.trim() === "") return { files: [], errors: [] };
  const files: ParsedDiffFile[] = [];
  const errors: string[] = [];
  let current: ParsedDiffFile | undefined;
  let nextNewLine: number | undefined;

  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      const path = match?.[2];
      if (path === undefined || !safeDiffPath(path)) {
        errors.push("The diff contains an unsupported or unsafe file path.");
        current = undefined;
        nextNewLine = undefined;
        continue;
      }
      current = { path, changeType: "modified", additions: 0, deletions: 0, hunks: 0, ranges: [], addedLines: [] };
      files.push(current);
      nextNewLine = undefined;
      continue;
    }
    if (current === undefined) {
      if (line.startsWith("@@ ")) errors.push("A diff hunk appeared without a file header.");
      continue;
    }
    if (line.startsWith("new file mode ")) current.changeType = "added";
    if (line.startsWith("deleted file mode ")) current.changeType = "deleted";
    if (line === "+++ /dev/null") current.changeType = "deleted";
    if (line.startsWith("@@ ")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (hunk === null) {
        errors.push(`The diff contains a malformed hunk header for ${current.path}.`);
        nextNewLine = undefined;
        continue;
      }
      const startLine = Number(hunk[1]);
      const lineCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current.hunks += 1;
      current.ranges.push({ startLine: Math.max(1, startLine), endLine: Math.max(1, startLine + Math.max(1, lineCount) - 1) });
      nextNewLine = Math.max(1, startLine);
      continue;
    }
    if (nextNewLine === undefined) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
      current.addedLines.push({ line: nextNewLine, text: line.slice(1) });
      nextNewLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
    } else if (line.startsWith(" ")) {
      nextNewLine += 1;
    } else if (line !== "\\ No newline at end of file") {
      nextNewLine = undefined;
    }
  }
  if (files.length === 0 && errors.length === 0) errors.push("The supplied text is not a supported unified diff.");
  for (const file of files) {
    if (file.hunks === 0 || file.additions + file.deletions === 0) errors.push(`The diff for ${file.path} contains no complete changed hunk.`);
  }
  return { files, errors: [...new Set(errors)] };
}

function cleanEntity(value: string): string {
  return value.trim().replace(/^[`'"]|[`'"]$/g, "").replace(/\(\)$/u, "");
}

function proposalStatements(proposal: string): readonly string[] {
  const lines = proposal.split("\n")
    .map((line) => line.trim().replace(/^(?:[-*]|\d+[.)])\s+/u, ""))
    .filter(Boolean);
  const candidates = lines.flatMap((line) => line.split(/(?<=[.!?])\s+/u).map((item) => item.trim()).filter(Boolean));
  return [...new Set(candidates.map((item) => item.replace(/[.!?]+$/u, "").trim()).filter(Boolean))].slice(0, 20);
}

function decisionKind(statement: string): DecisionClaimKind {
  if (/\b(assume|assumption|because|currently|already|exists?|calls?|depends?)\b/iu.test(statement)) return "assumption";
  if (/\b(must|should|cannot|without|constraint|require)\b/iu.test(statement)) return "constraint";
  if (/\b(will|therefore|so that|result|consequence|reduce|prevent|improve)\b/iu.test(statement)) return "consequence";
  return "goal";
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

  public assess(question: string, intent: "ask" | "investigate" | "task" | "review" | "decide" = "ask"): QueryAssessment {
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
    const kind: QueryKind = intent === "task" || intent === "review" || intent === "decide"
      ? intent === "decide" ? "decision" : intent
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
      : (intent === "review" || intent === "decide") && (securitySensitive || relevantFiles.length >= 5)
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

  public inspectDiff(unifiedDiff: string, objective?: string): DiffKnowledgeReview {
    const parsed = parseUnifiedDiff(unifiedDiff);
    const noChanges = unifiedDiff.trim() === "";
    const changedFiles: ReviewedFile[] = parsed.files.map((file) => ({
      path: file.path, changeType: file.changeType, additions: file.additions, deletions: file.deletions,
      hunks: file.hunks, indexed: this.#index.files[file.path] !== undefined,
    }));
    let evidence = dedupe(parsed.files.flatMap((file) => {
      const indexed = this.#index.files[file.path];
      if (indexed === undefined || file.changeType === "deleted") return [];
      const lineCount = indexed.sourceText.split("\n").length;
      const ranges = file.ranges.length === 0 ? [{ startLine: 1, endLine: Math.min(lineCount, 20) }] : file.ranges;
      return ranges.slice(0, 4).map((range) => this.#reader.readFile(file.path, {
        startLine: Math.max(1, Math.min(range.startLine, lineCount)),
        endLine: Math.max(1, Math.min(range.endLine, lineCount)),
      }));
    }));
    const evidenceIds = (path: string, line: number): readonly string[] => evidence
      .filter((item) => item.path === path && item.startLine <= line && item.endLine >= line)
      .map((item) => item.id);
    const findings: ReviewVerdictFinding[] = parsed.errors.map((statement) => ({
      id: reviewId("invalid-diff", "(diff)", 0, statement), category: "invalid-diff", severity: "warning",
      statement, consequence: "The requested change cannot be reviewed reliably until a complete unified diff is supplied.",
      evidenceIds: [], deterministic: true,
    }));
    const secretLines = new Map<string, Map<number, NonNullable<ReviewVerdictFinding["secretType"]>>>();
    for (const file of parsed.files) {
      for (const added of file.addedLines) {
        if (/^(?:<{7}|={7}|>{7})(?:\s|$)/u.test(added.text)) {
          const statement = "An unresolved merge-conflict marker is added by the diff.";
          findings.push({
            id: reviewId("merge-conflict", file.path, added.line, statement), category: "merge-conflict", severity: "blocking",
            statement, consequence: "The changed file is syntactically ambiguous and cannot be safely merged or executed.",
            path: file.path, line: added.line, evidenceIds: evidenceIds(file.path, added.line), deterministic: true,
          });
        }
        const detected = secretType(added.text);
        if (detected !== undefined) {
          const statement = `The diff introduces content matching a ${detected} format; the value is redacted.`;
          findings.push({
            id: reviewId("secret-exposure", file.path, added.line, statement), category: "secret-exposure", severity: "blocking",
            statement, consequence: "Committing the value could expose repository or provider access and requires credential rotation.",
            path: file.path, line: added.line, evidenceIds: evidenceIds(file.path, added.line), deterministic: true, secretType: detected,
          });
          const lines = secretLines.get(file.path) ?? new Map<number, NonNullable<ReviewVerdictFinding["secretType"]>>();
          lines.set(added.line, detected);
          secretLines.set(file.path, lines);
        }
      }
    }
    if (secretLines.size > 0) {
      evidence = evidence.map((item) => {
        const lines = secretLines.get(item.path);
        if (lines === undefined) return item;
        return {
          ...item,
          excerpt: item.excerpt.split("\n").map((line, index) => {
            const detected = lines.get(item.startLine + index);
            return detected === undefined ? line : `[REDACTED ${detected}]`;
          }).join("\n"),
        };
      });
    }

    const parsedFiles = new Map(parsed.files.map((file) => [file.path, file]));
    const candidateUnits = Object.values(this.#index.units).filter((unit) => {
      const file = parsedFiles.get(unit.path);
      if (file === undefined || file.changeType === "deleted") return false;
      return file.changeType === "added" || file.ranges.length === 0 || file.ranges.some((range) => unit.endLine >= range.startLine && unit.startLine <= range.endLine);
    });
    const changedUnits = candidateUnits.slice(0, IMPACT_LIMITS.maxChangedSymbols);
    const changedSymbols: ChangedSymbol[] = changedUnits.map((unit) => {
      const item = this.#reader.readUnit(unit.id);
      if (item !== undefined) evidence = dedupe([...evidence, item]);
      return {
        id: unit.id, path: unit.path, symbol: unit.symbol, symbolKind: unit.symbolKind, language: unit.language,
        startLine: unit.startLine, endLine: unit.endLine,
        changeType: parsedFiles.get(unit.path)?.changeType ?? "modified",
        evidenceIds: item === undefined ? [] : [item.id],
      };
    });
    const changedIds = new Set(changedSymbols.map((symbol) => symbol.id));
    const relevantEdges = this.#index.graphEdges.filter((edge) =>
      (edge.from.kind === "symbol" && changedIds.has(edge.from.id)) || (edge.to.kind === "symbol" && changedIds.has(edge.to.id)),
    );
    const inspectedEdges = relevantEdges.slice(0, IMPACT_LIMITS.maxGraphEdges);
    const impactedById = new Map<string, ImpactedSymbol>();
    for (const edge of inspectedEdges) {
      const changedFrom = edge.from.kind === "symbol" && changedIds.has(edge.from.id);
      const neighbor = changedFrom ? edge.to : edge.from;
      if (neighbor.kind !== "symbol" || changedIds.has(neighbor.id)) continue;
      const unit = this.#index.units[neighbor.id];
      const item = this.#reader.readUnit(neighbor.id);
      if (unit === undefined || item === undefined) continue;
      evidence = dedupe([...evidence, item]);
      impactedById.set(neighbor.id, {
        id: neighbor.id, path: unit.path, symbol: unit.symbol, relation: edge.relation,
        direction: changedFrom ? "outgoing" : "incoming", evidenceIds: [item.id],
      });
      if (impactedById.size >= IMPACT_LIMITS.maxImpactedSymbols) break;
    }
    const impactedSymbols = [...impactedById.values()];
    const impact: ReviewImpactAnalysis = {
      changedSymbols,
      impactedSymbols,
      affectedFiles: [...new Set([...changedFiles.map((file) => file.path), ...impactedSymbols.map((symbol) => symbol.path)])],
      graphEdgesInspected: inspectedEdges.length,
      truncated: candidateUnits.length > changedUnits.length || relevantEdges.length > inspectedEdges.length || impactedById.size >= IMPACT_LIMITS.maxImpactedSymbols,
      limits: IMPACT_LIMITS,
    };
    const confirmedProperties: ConfirmedProperty[] = [];
    if (!noChanges && parsed.errors.length === 0) confirmedProperties.push({
      id: knowledgeId("property", "diff-parse", unifiedDiff), statement: "The supplied change is a structurally valid bounded unified diff.",
      method: "diff", evidenceIds: [],
    });
    if (findings.every((finding) => finding.category !== "merge-conflict")) confirmedProperties.push({
      id: knowledgeId("property", "no-conflict", unifiedDiff), statement: "No added merge-conflict marker was detected.", method: "safety-scan", evidenceIds: [],
    });
    if (findings.every((finding) => finding.category !== "secret-exposure")) confirmedProperties.push({
      id: knowledgeId("property", "no-secret", unifiedDiff), statement: "No concrete private-key or provider-token format was detected in added lines.", method: "safety-scan", evidenceIds: [],
    });
    const indexedChangedFiles = changedFiles.filter((file) => file.indexed && file.changeType !== "deleted");
    if (indexedChangedFiles.length > 0 && indexedChangedFiles.every((file) => (this.#index.files[file.path]?.diagnostics.length ?? 1) === 0)) confirmedProperties.push({
      id: knowledgeId("property", "parser", ...indexedChangedFiles.map((file) => file.path)),
      statement: "Changed indexed source files have no structural parser diagnostics.", method: "parser",
      evidenceIds: evidence.filter((item) => indexedChangedFiles.some((file) => file.path === item.path)).map((item) => item.id),
    });

    const documentationOnly = changedFiles.length > 0 && changedFiles.every((file) => DOCUMENTATION_PATH.test(file.path));
    const isolatedTypeAddition = changedFiles.length > 0
      && changedFiles.every((file) => file.changeType === "added" && file.indexed)
      && changedSymbols.length > 0
      && changedSymbols.every((symbol) => TYPE_ONLY_SYMBOLS.has(symbol.symbolKind))
      && indexedChangedFiles.every((file) => (this.#index.files[file.path]?.diagnostics.length ?? 1) === 0)
      && relevantEdges.every((edge) => new Set(["belongs-to-file", "contains-symbol", "exports-symbol"]).has(edge.relation));
    const normalizedObjective = objective?.trim().toLowerCase() ?? "";
    const documentationObjective = normalizedObjective === "" || /\b(doc|docs|document|documented|documentation|readme|guide|explain|copy)\b/u.test(normalizedObjective);
    const typeObjective = normalizedObjective === "" || /\b(type|types|typing|interface|contract|schema|compile-time)\b/u.test(normalizedObjective);
    if (isolatedTypeAddition) confirmedProperties.push({
      id: knowledgeId("property", "isolated-type-addition", ...changedSymbols.map((symbol) => symbol.id)),
      statement: "The code change adds only parser-resolved type declarations with no runtime graph relationships.", method: "graph",
      evidenceIds: changedSymbols.flatMap((symbol) => symbol.evidenceIds),
    });
    const objectiveMismatch = (documentationOnly && !documentationObjective) || (isolatedTypeAddition && !typeObjective);
    if (objectiveMismatch) {
      const statement = "The changed artifacts do not structurally implement the stated runtime objective.";
      findings.push({
        id: reviewId("objective-gap", "(objective)", 0, statement), category: "objective-gap", severity: "blocking",
        statement, consequence: "Merging this ChangeSet would leave the requested runtime behavior unchanged.", evidenceIds: [], deterministic: true,
      });
    }
    const uncertainty: ReviewUncertainty[] = [
      ...changedFiles.filter((file) => !file.indexed && !DOCUMENTATION_PATH.test(file.path)).map((file) => ({
        id: knowledgeId("uncertainty", "unindexed", file.path), statement: `${file.path} is not represented in Project Knowledge.`,
        reason: "unindexed-file" as const, paths: [file.path],
      })),
      ...changedFiles.filter((file) => file.changeType === "deleted").map((file) => ({
        id: knowledgeId("uncertainty", "deleted", file.path), statement: `Post-change Project Knowledge cannot resolve symbols removed from ${file.path}.`,
        reason: "deleted-source" as const, paths: [file.path],
      })),
      ...(impact.truncated ? [{ id: knowledgeId("uncertainty", "impact-truncated"), statement: "Impact traversal reached its deterministic bound.", reason: "dynamic-dispatch" as const, paths: impact.affectedFiles }] : []),
    ];
    const blocking = findings.some((finding) => finding.severity === "blocking");
    const deterministicStatus: ReviewVerdictStatus | undefined = noChanges
      ? "nothing-to-review"
      : parsed.errors.length > 0 ? "invalid"
        : blocking ? "changes-requested"
          : documentationOnly && documentationObjective ? "approved"
            : isolatedTypeAddition && typeObjective ? "approved" : undefined;
    const securitySensitive = changedFiles.some((file) => SECURITY_PATH.test(file.path));
    const deletions = changedFiles.some((file) => file.changeType === "deleted");
    const changedLines = changedFiles.reduce((total, file) => total + file.additions + file.deletions, 0);
    const relevantFiles = changedFiles.filter((file) => file.indexed).map((file) => file.path).slice(0, 20);
    const resolvedEntities = changedSymbols.map((symbol) => symbol.symbol).slice(0, 20);
    const ambiguity: QueryAssessment["ambiguity"] = deterministicStatus !== undefined
      ? "low" : securitySensitive || deletions || changedFiles.length >= 5 || changedLines >= 300 ? "high" : "medium";
    const reasonCodes = [
      "consumer:review", ...(noChanges ? ["diff:no-changes"] : []), ...(parsed.errors.length > 0 ? ["diff:invalid"] : []),
      ...(documentationOnly ? ["diff:documentation-only"] : []), ...(isolatedTypeAddition ? ["diff:isolated-type-only"] : []),
      ...(blocking ? ["diff:deterministic-blocker"] : []), ...(securitySensitive ? ["diff:security-sensitive"] : []),
      ...(deletions ? ["diff:deletion"] : []), ...(changedFiles.length > 1 ? ["diff:cross-module"] : []),
      ...(deterministicStatus === undefined ? ["diff:semantic-review-required"] : ["diff:deterministic-review-sufficient"]),
    ];
    return {
      assessment: {
        queryKind: "review", resolvedEntities, relevantFiles, crossModule: impact.affectedFiles.length > 1,
        ambiguity, deterministicCoverage: deterministicStatus === undefined ? changedFiles.length === 0 ? "none" : "partial" : "strong",
        requiresModelReasoning: deterministicStatus === undefined, signals: reasonCodes,
      },
      changedFiles, findings, confirmedProperties, uncertainty, impact, evidence,
      ...(deterministicStatus === undefined ? {} : { deterministicStatus }), reasonCodes,
      limitations: deterministicStatus === "approved" && documentationOnly
        ? ["Documentation validation confirms bounded diff safety, not factual prose accuracy."]
        : deterministicStatus === "approved"
          ? ["Deterministic approval is limited to structurally isolated type-only code with no runtime graph effect."]
          : deterministicStatus === "nothing-to-review"
            ? ["No substantive changed lines were available for validation."]
            : deterministicStatus === "invalid"
              ? ["No implementation conclusion is valid until a complete unified diff is supplied."]
              : deterministicStatus === "changes-requested"
                ? ["Review stopped on deterministic blocking evidence; additional semantic defects may still exist."]
                : ["Runtime behavior and intent require adaptive repository-grounded reasoning."],
    };
  }

  public inspectProposal(proposal: string): ProposalKnowledgeValidation {
    const statements = proposalStatements(proposal);
    const evidence: Evidence[] = [];
    const claims = statements.map((statement, index): DecisionClaim => {
      let status: DecisionClaim["status"] = "uncertain";
      let explanation = "This proposal claim requires repository-grounded challenge and validation.";
      let deterministic = false;
      const claimEvidence: Evidence[] = [];
      const exists = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+exists(?:\s+in\s+the\s+repository)?$/iu.exec(statement);
      const calls = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+calls\s+([A-Za-z_$][A-Za-z0-9_$]*)$/iu.exec(statement);
      const noCallers = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+has\s+no\s+callers$/iu.exec(statement);
      if (exists !== null) {
        const symbol = exists[1] ?? "";
        claimEvidence.push(...this.#reader.findSymbol(symbol));
        status = claimEvidence.length > 0 ? "supported" : "rejected";
        explanation = claimEvidence.length > 0 ? `${symbol} is present in the structural index.` : `${symbol} was not found in Project Knowledge.`;
        deterministic = true;
      } else if (calls !== null) {
        const from = calls[1] ?? "";
        const to = calls[2] ?? "";
        const resolution = this.#graph.getNodeBySymbol(from);
        const target = this.#graph.getNodeBySymbol(to);
        if (resolution.status === "resolved" && target.status === "resolved") {
          const relations = this.#graph.callees(resolution.node.reference);
          const relation = relations.find((item) => item.node.reference.id === target.node.reference.id);
          claimEvidence.push(...this.#evidenceForNode(resolution.node), ...this.#evidenceForNode(target.node));
          status = relation === undefined ? "rejected" : "supported";
          explanation = relation === undefined ? `No resolved call edge from ${from} to ${to} exists.` : `A resolved static call edge from ${from} to ${to} exists.`;
          deterministic = true;
        }
      } else if (noCallers !== null) {
        const symbol = noCallers[1] ?? "";
        const resolution = this.#graph.getNodeBySymbol(symbol);
        if (resolution.status === "resolved") {
          const callers = this.#graph.callers(resolution.node.reference);
          claimEvidence.push(...this.#evidenceForNode(resolution.node), ...callers.flatMap((item) => this.#evidenceForNode(item.node)));
          status = callers.length === 0 ? "supported" : "rejected";
          explanation = callers.length === 0 ? `${symbol} has no resolved static callers.` : `${symbol} has ${String(callers.length)} resolved static caller${callers.length === 1 ? "" : "s"}.`;
          deterministic = true;
        }
      }
      evidence.push(...claimEvidence);
      return {
        id: knowledgeId("decision-claim", String(index), statement), statement, kind: decisionKind(statement), status,
        evidenceIds: dedupe(claimEvidence).map((item) => item.id), explanation, deterministic,
      };
    });
    const uniqueEvidence = dedupe(evidence);
    const relevantFiles = [...new Set(uniqueEvidence.map((item) => item.path))].slice(0, 20);
    const entities = [...new Set(uniqueEvidence.map((item) => item.symbol).filter((symbol): symbol is string => symbol !== undefined))].slice(0, 20);
    const unresolved = claims.filter((claim) => claim.status === "uncertain").length;
    const deterministicComplete = claims.length > 0 && unresolved === 0;
    const ambiguity: QueryAssessment["ambiguity"] = claims.length === 0 || unresolved > 3 ? "high" : unresolved > 0 ? "medium" : "low";
    const reasonCodes = [
      "consumer:decision", `claims:${String(claims.length)}`, `unresolved:${String(unresolved)}`,
      ...(relevantFiles.length > 1 ? ["proposal:cross-module"] : []),
      ...(deterministicComplete ? ["proposal:deterministic-validation-sufficient"] : ["proposal:adaptive-validation-required"]),
    ];
    return {
      assessment: {
        queryKind: "decision", resolvedEntities: entities, relevantFiles, crossModule: relevantFiles.length > 1,
        ambiguity, deterministicCoverage: deterministicComplete ? "strong" : uniqueEvidence.length > 0 ? "partial" : "none",
        requiresModelReasoning: !deterministicComplete, signals: reasonCodes,
      },
      claims,
      evidence: uniqueEvidence,
      deterministicComplete,
      reasonCodes,
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

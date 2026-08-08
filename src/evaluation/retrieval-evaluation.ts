import { readFile } from "node:fs/promises";

import type { RetrievalResult } from "../domain/evidence.js";
import type { ContextBundle } from "../domain/context-bundle.js";
import type { EmbeddingKind } from "../domain/embedding.js";
import type { RetrievalStrategy } from "../retrieval/hybrid-retriever.js";
import type { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";

export interface RetrievalEvaluationCase {
  readonly id: string;
  readonly question: string;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
  readonly graphResolvable?: boolean;
}

export interface EvaluationMetrics {
  readonly fileRecallAt1: number;
  readonly fileRecallAt3: number;
  readonly fileRecallAt5: number;
  readonly symbolRecallAt1: number;
  readonly symbolRecallAt3: number;
  readonly symbolRecallAt5: number;
  readonly meanReciprocalRank: number;
}

export interface EvaluationCaseResult {
  readonly id: string;
  readonly firstRelevantRank?: number;
  readonly topResults: readonly {
    readonly rank: number;
    readonly path: string;
    readonly symbol?: string;
  }[];
}

export interface StrategyEvaluation {
  readonly strategy: RetrievalStrategy;
  readonly metrics: EvaluationMetrics;
  readonly cases: readonly EvaluationCaseResult[];
}

export interface RetrievalEvaluationReport {
  readonly caseCount: number;
  readonly strategies: readonly StrategyEvaluation[];
}

export type GraphAwareEvaluationStrategy =
  | "lexical"
  | "feature-vector"
  | "hybrid-no-graph"
  | "graph-only"
  | "graph-aware-hybrid";

export interface ContextEfficiencyMetrics {
  readonly meanEvidenceCount: number;
  readonly meanSourceBytes: number;
  readonly meanApproximateTokens: number;
  readonly meanStrategiesExecuted: number;
  readonly relevantEvidencePer1kTokens: number;
}

export interface GraphAwareStrategyEvaluation {
  readonly strategy: GraphAwareEvaluationStrategy;
  readonly caseCount: number;
  readonly metrics: EvaluationMetrics & ContextEfficiencyMetrics;
  readonly cases: readonly EvaluationCaseResult[];
}

export interface GraphAwareEvaluationReport {
  readonly caseCount: number;
  readonly embedding: {
    readonly terminology: EmbeddingKind;
    readonly learnedSemanticModel: boolean;
  };
  readonly strategies: readonly GraphAwareStrategyEvaluation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export async function loadEvaluationCases(path: string): Promise<readonly RetrievalEvaluationCase[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Evaluation cases must be a JSON array");
  }
  return parsed.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["id"] !== "string" ||
      typeof entry["question"] !== "string" ||
      !isStringArray(entry["expectedFiles"]) ||
      !isStringArray(entry["expectedSymbols"]) ||
      (entry["graphResolvable"] !== undefined && typeof entry["graphResolvable"] !== "boolean")
    ) {
      throw new Error("Evaluation case is invalid");
    }
    return {
      id: entry["id"],
      question: entry["question"],
      expectedFiles: entry["expectedFiles"],
      expectedSymbols: entry["expectedSymbols"],
      ...(entry["graphResolvable"] === undefined
        ? {}
        : { graphResolvable: entry["graphResolvable"] }),
    };
  });
}

function recallAt(
  results: readonly RetrievalResult[],
  expected: readonly string[],
  k: number,
  select: (result: RetrievalResult) => string | undefined,
  eligible: (result: RetrievalResult) => boolean = () => true,
): number {
  if (expected.length === 0) {
    return 1;
  }
  const expectedSet = new Set(expected);
  const found = new Set(
    results
      .slice(0, k)
      .filter(eligible)
      .map(select)
      .filter((value): value is string => value !== undefined && expectedSet.has(value)),
  );
  return found.size / expectedSet.size;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function evaluateStrategy(
  service: CodeRetrievalService,
  cases: readonly RetrievalEvaluationCase[],
  strategy: RetrievalStrategy,
): Promise<StrategyEvaluation> {
  const fileRecall1: number[] = [];
  const fileRecall3: number[] = [];
  const fileRecall5: number[] = [];
  const symbolRecall1: number[] = [];
  const symbolRecall3: number[] = [];
  const symbolRecall5: number[] = [];
  const reciprocalRanks: number[] = [];
  const caseResults: EvaluationCaseResult[] = [];

  for (const evaluationCase of cases) {
    const results = await service.search(evaluationCase.question, {
      strategy,
      limit: 10,
      expandGraph: strategy === "hybrid",
    });
    const expectedFiles = new Set(evaluationCase.expectedFiles);
    const expectedSymbols = new Set(evaluationCase.expectedSymbols);
    const symbolEligibility = (result: RetrievalResult): boolean =>
      expectedFiles.has(result.evidence.path);
    fileRecall1.push(recallAt(results, evaluationCase.expectedFiles, 1, (result) => result.evidence.path));
    fileRecall3.push(recallAt(results, evaluationCase.expectedFiles, 3, (result) => result.evidence.path));
    fileRecall5.push(recallAt(results, evaluationCase.expectedFiles, 5, (result) => result.evidence.path));
    symbolRecall1.push(
      recallAt(results, evaluationCase.expectedSymbols, 1, (result) => result.evidence.symbol, symbolEligibility),
    );
    symbolRecall3.push(
      recallAt(results, evaluationCase.expectedSymbols, 3, (result) => result.evidence.symbol, symbolEligibility),
    );
    symbolRecall5.push(
      recallAt(results, evaluationCase.expectedSymbols, 5, (result) => result.evidence.symbol, symbolEligibility),
    );
    const firstRelevantIndex = results.findIndex(
      (result) =>
        expectedFiles.has(result.evidence.path) &&
        (result.evidence.symbol === undefined || expectedSymbols.has(result.evidence.symbol)),
    );
    const firstRelevantRank = firstRelevantIndex < 0 ? undefined : firstRelevantIndex + 1;
    reciprocalRanks.push(firstRelevantRank === undefined ? 0 : 1 / firstRelevantRank);
    caseResults.push({
      id: evaluationCase.id,
      ...(firstRelevantRank === undefined ? {} : { firstRelevantRank }),
      topResults: results.slice(0, 5).map((result) => ({
        rank: result.rank,
        path: result.evidence.path,
        ...(result.evidence.symbol === undefined ? {} : { symbol: result.evidence.symbol }),
      })),
    });
  }

  return {
    strategy,
    metrics: {
      fileRecallAt1: rounded(average(fileRecall1)),
      fileRecallAt3: rounded(average(fileRecall3)),
      fileRecallAt5: rounded(average(fileRecall5)),
      symbolRecallAt1: rounded(average(symbolRecall1)),
      symbolRecallAt3: rounded(average(symbolRecall3)),
      symbolRecallAt5: rounded(average(symbolRecall5)),
      meanReciprocalRank: rounded(average(reciprocalRanks)),
    },
    cases: caseResults,
  };
}

export async function runRetrievalEvaluation(
  service: CodeRetrievalService,
  cases: readonly RetrievalEvaluationCase[],
): Promise<RetrievalEvaluationReport> {
  const strategies: RetrievalStrategy[] = ["lexical", "semantic", "hybrid"];
  const evaluations: StrategyEvaluation[] = [];
  for (const strategy of strategies) {
    evaluations.push(await evaluateStrategy(service, cases, strategy));
  }
  return { caseCount: cases.length, strategies: evaluations };
}

interface EvaluatedExecution {
  readonly results: readonly RetrievalResult[];
  readonly context: ContextBundle;
  readonly strategiesExecuted: number;
}

async function executeGraphAwareStrategy(
  service: CodeRetrievalService,
  evaluationCase: RetrievalEvaluationCase,
  strategy: GraphAwareEvaluationStrategy,
): Promise<EvaluatedExecution> {
  if (strategy === "graph-only" || strategy === "graph-aware-hybrid") {
    const retrieval = await service.retrieve(evaluationCase.question, {
      allowBroadFallback: strategy === "graph-aware-hybrid",
      graphAwareHybrid: true,
    });
    return {
      results: retrieval.results,
      context: service.packContext(retrieval),
      strategiesExecuted: retrieval.plan.operations.filter((entry) => entry.status === "executed").length,
    };
  }
  const searchStrategy: RetrievalStrategy =
    strategy === "lexical" ? "lexical" : strategy === "feature-vector" ? "semantic" : "hybrid";
  const results = await service.search(evaluationCase.question, {
    strategy: searchStrategy,
    limit: 10,
    expandGraph: false,
  });
  return {
    results,
    context: service.packResults(results),
    strategiesExecuted: strategy === "hybrid-no-graph" ? 3 : 1,
  };
}

async function evaluateGraphAwareStrategy(
  service: CodeRetrievalService,
  cases: readonly RetrievalEvaluationCase[],
  strategy: GraphAwareEvaluationStrategy,
): Promise<GraphAwareStrategyEvaluation> {
  const eligibleCases =
    strategy === "graph-only" ? cases.filter((evaluationCase) => evaluationCase.graphResolvable === true) : cases;
  const fileRecall1: number[] = [];
  const fileRecall3: number[] = [];
  const fileRecall5: number[] = [];
  const symbolRecall1: number[] = [];
  const symbolRecall3: number[] = [];
  const symbolRecall5: number[] = [];
  const reciprocalRanks: number[] = [];
  const evidenceCounts: number[] = [];
  const sourceBytes: number[] = [];
  const approximateTokens: number[] = [];
  const strategyCounts: number[] = [];
  const caseResults: EvaluationCaseResult[] = [];
  let relevantEvidence = 0;
  let totalTokens = 0;

  for (const evaluationCase of eligibleCases) {
    const execution = await executeGraphAwareStrategy(service, evaluationCase, strategy);
    const expectedFiles = new Set(evaluationCase.expectedFiles);
    const expectedSymbols = new Set(evaluationCase.expectedSymbols);
    const symbolEligibility = (result: RetrievalResult): boolean => expectedFiles.has(result.evidence.path);
    fileRecall1.push(recallAt(execution.results, evaluationCase.expectedFiles, 1, (result) => result.evidence.path));
    fileRecall3.push(recallAt(execution.results, evaluationCase.expectedFiles, 3, (result) => result.evidence.path));
    fileRecall5.push(recallAt(execution.results, evaluationCase.expectedFiles, 5, (result) => result.evidence.path));
    symbolRecall1.push(recallAt(execution.results, evaluationCase.expectedSymbols, 1, (result) => result.evidence.symbol, symbolEligibility));
    symbolRecall3.push(recallAt(execution.results, evaluationCase.expectedSymbols, 3, (result) => result.evidence.symbol, symbolEligibility));
    symbolRecall5.push(recallAt(execution.results, evaluationCase.expectedSymbols, 5, (result) => result.evidence.symbol, symbolEligibility));
    const firstRelevantIndex = execution.results.findIndex(
      (result) =>
        expectedFiles.has(result.evidence.path) &&
        (result.evidence.symbol === undefined || expectedSymbols.has(result.evidence.symbol)),
    );
    const firstRelevantRank = firstRelevantIndex < 0 ? undefined : firstRelevantIndex + 1;
    reciprocalRanks.push(firstRelevantRank === undefined ? 0 : 1 / firstRelevantRank);
    evidenceCounts.push(execution.context.stats.packedEvidenceCount);
    sourceBytes.push(execution.context.stats.sourceBytes);
    approximateTokens.push(execution.context.stats.approximateTokens);
    strategyCounts.push(execution.strategiesExecuted);
    totalTokens += execution.context.stats.approximateTokens;
    relevantEvidence += execution.results.filter(
      (result) =>
        expectedFiles.has(result.evidence.path) &&
        (result.evidence.symbol === undefined || expectedSymbols.has(result.evidence.symbol)),
    ).length;
    caseResults.push({
      id: evaluationCase.id,
      ...(firstRelevantRank === undefined ? {} : { firstRelevantRank }),
      topResults: execution.results.slice(0, 5).map((result) => ({
        rank: result.rank,
        path: result.evidence.path,
        ...(result.evidence.symbol === undefined ? {} : { symbol: result.evidence.symbol }),
      })),
    });
  }

  return {
    strategy,
    caseCount: eligibleCases.length,
    metrics: {
      fileRecallAt1: rounded(average(fileRecall1)),
      fileRecallAt3: rounded(average(fileRecall3)),
      fileRecallAt5: rounded(average(fileRecall5)),
      symbolRecallAt1: rounded(average(symbolRecall1)),
      symbolRecallAt3: rounded(average(symbolRecall3)),
      symbolRecallAt5: rounded(average(symbolRecall5)),
      meanReciprocalRank: rounded(average(reciprocalRanks)),
      meanEvidenceCount: rounded(average(evidenceCounts)),
      meanSourceBytes: rounded(average(sourceBytes)),
      meanApproximateTokens: rounded(average(approximateTokens)),
      meanStrategiesExecuted: rounded(average(strategyCounts)),
      relevantEvidencePer1kTokens: totalTokens === 0 ? 0 : rounded((relevantEvidence * 1_000) / totalTokens),
    },
    cases: caseResults,
  };
}

export async function runGraphAwareRetrievalEvaluation(
  service: CodeRetrievalService,
  cases: readonly RetrievalEvaluationCase[],
): Promise<GraphAwareEvaluationReport> {
  const strategies: GraphAwareEvaluationStrategy[] = [
    "lexical",
    "feature-vector",
    "hybrid-no-graph",
    "graph-only",
    "graph-aware-hybrid",
  ];
  const evaluations: GraphAwareStrategyEvaluation[] = [];
  for (const strategy of strategies) {
    evaluations.push(await evaluateGraphAwareStrategy(service, cases, strategy));
  }
  return {
    caseCount: cases.length,
    embedding: {
      terminology: service.embedding.kind,
      learnedSemanticModel: service.embedding.kind === "learned-semantic",
    },
    strategies: evaluations,
  };
}

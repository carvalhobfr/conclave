import { readFile } from "node:fs/promises";

import type { ReasoningResult } from "../domain/reasoning.js";
import type { ReasoningEngine, ReasoningMode } from "../reasoning/reasoning-engine.js";

export interface ReasoningEvaluationCase {
  readonly id: string;
  readonly question: string;
  readonly expectedSupportedClaims: readonly string[];
  readonly expectedRejectedClaims: readonly string[];
  readonly expectedEvidencePaths: readonly string[];
}

export type ReasoningEvaluationStrategy = "single-model" | "investigator-judge" | "conclave";

export interface ReasoningCaseEvaluation {
  readonly id: string;
  readonly answerCorrect: boolean;
  readonly supportedClaimPrecision: number;
  readonly unsupportedClaimRate: number;
  readonly expectedEvidenceRecall: number;
  readonly incorrectClaimRejectionRate: number;
  readonly modelCalls: number;
  readonly retrievalRounds: number;
  readonly approximateContextTokens: number;
  readonly providerInputTokens: number;
  readonly providerOutputTokens: number;
  readonly latencyMs: number;
}

export interface ReasoningStrategyEvaluation {
  readonly strategy: ReasoningEvaluationStrategy;
  readonly metrics: Omit<ReasoningCaseEvaluation, "id" | "answerCorrect"> & {
    readonly answerAccuracy: number;
  };
  readonly cases: readonly ReasoningCaseEvaluation[];
}

export interface ReasoningEvaluationReport {
  readonly caseCount: number;
  readonly strategies: readonly ReasoningStrategyEvaluation[];
}

export type ReasoningEngineFactory = () => Promise<Pick<ReasoningEngine, "ask">>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export async function loadReasoningEvaluationCases(
  path: string,
): Promise<readonly ReasoningEvaluationCase[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Reasoning evaluation cases must be a JSON array");
  return parsed.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["id"] !== "string" ||
      typeof entry["question"] !== "string" ||
      !isStringArray(entry["expectedSupportedClaims"]) ||
      !isStringArray(entry["expectedRejectedClaims"]) ||
      !isStringArray(entry["expectedEvidencePaths"])
    ) {
      throw new Error("Reasoning evaluation case is invalid");
    }
    return {
      id: entry["id"],
      question: entry["question"],
      expectedSupportedClaims: entry["expectedSupportedClaims"],
      expectedRejectedClaims: entry["expectedRejectedClaims"],
      expectedEvidencePaths: entry["expectedEvidencePaths"],
    };
  });
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function ratio(found: number, total: number): number {
  return total === 0 ? 1 : found / total;
}

function evaluateCase(
  evaluationCase: ReasoningEvaluationCase,
  result: ReasoningResult,
): ReasoningCaseEvaluation {
  const expectedSupported = new Set(evaluationCase.expectedSupportedClaims);
  const expectedRejected = new Set(evaluationCase.expectedRejectedClaims);
  const supported = result.verdict.claims.supported.map((claim) => claim.statement);
  const rejected = new Set(result.verdict.claims.rejected.map((claim) => claim.statement));
  const supportedCorrect = supported.filter((statement) => expectedSupported.has(statement)).length;
  const unsupported = supported.filter((statement) => expectedRejected.has(statement)).length;
  const expectedEvidence = new Set(evaluationCase.expectedEvidencePaths);
  const foundEvidence = new Set(
    result.verdict.evidence
      .map((evidence) => evidence.path)
      .filter((path) => expectedEvidence.has(path)),
  );
  const answerCorrect =
    evaluationCase.expectedSupportedClaims.every((statement) => result.verdict.answer.includes(statement)) &&
    evaluationCase.expectedRejectedClaims.every((statement) => !result.verdict.answer.includes(statement));
  return {
    id: evaluationCase.id,
    answerCorrect,
    supportedClaimPrecision: rounded(ratio(supportedCorrect, supported.length)),
    unsupportedClaimRate: rounded(ratio(unsupported, Math.max(1, supported.length))),
    expectedEvidenceRecall: rounded(ratio(foundEvidence.size, expectedEvidence.size)),
    incorrectClaimRejectionRate: rounded(
      ratio(
        evaluationCase.expectedRejectedClaims.filter((statement) => rejected.has(statement)).length,
        expectedRejected.size,
      ),
    ),
    modelCalls: result.metrics.modelCalls,
    retrievalRounds: result.metrics.retrievalRounds,
    approximateContextTokens: result.metrics.approximateInputTokens,
    providerInputTokens: result.metrics.providerReportedInputTokens,
    providerOutputTokens: result.metrics.providerReportedOutputTokens,
    latencyMs: result.metrics.latencyMs,
  };
}

function modeFor(strategy: ReasoningEvaluationStrategy): ReasoningMode {
  switch (strategy) {
    case "single-model":
      return "single-pass";
    case "investigator-judge":
      return "investigator-judge";
    case "conclave":
      // Preserve the Phase 3 benchmark's robust fixed workflow unchanged. Phase 8
      // evaluates adaptive Auto separately in eval:adaptive.
      return "full-style";
  }
}

export async function runReasoningEvaluation(
  cases: readonly ReasoningEvaluationCase[],
  createEngine: ReasoningEngineFactory,
): Promise<ReasoningEvaluationReport> {
  const strategies: readonly ReasoningEvaluationStrategy[] = [
    "single-model",
    "investigator-judge",
    "conclave",
  ];
  const evaluations: ReasoningStrategyEvaluation[] = [];
  for (const strategy of strategies) {
    const results: ReasoningCaseEvaluation[] = [];
    for (const evaluationCase of cases) {
      const engine = await createEngine();
      results.push(evaluateCase(evaluationCase, await engine.ask(evaluationCase.question, modeFor(strategy))));
    }
    evaluations.push({
      strategy,
      metrics: {
        answerAccuracy: rounded(average(results.map((result) => (result.answerCorrect ? 1 : 0)))),
        supportedClaimPrecision: rounded(average(results.map((result) => result.supportedClaimPrecision))),
        unsupportedClaimRate: rounded(average(results.map((result) => result.unsupportedClaimRate))),
        expectedEvidenceRecall: rounded(average(results.map((result) => result.expectedEvidenceRecall))),
        incorrectClaimRejectionRate: rounded(
          average(results.map((result) => result.incorrectClaimRejectionRate)),
        ),
        modelCalls: rounded(average(results.map((result) => result.modelCalls))),
        retrievalRounds: rounded(average(results.map((result) => result.retrievalRounds))),
        approximateContextTokens: rounded(
          average(results.map((result) => result.approximateContextTokens)),
        ),
        providerInputTokens: rounded(average(results.map((result) => result.providerInputTokens))),
        providerOutputTokens: rounded(average(results.map((result) => result.providerOutputTokens))),
        latencyMs: rounded(average(results.map((result) => result.latencyMs))),
      },
      cases: results,
    });
  }
  return { caseCount: cases.length, strategies: evaluations };
}

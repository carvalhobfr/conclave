import type { DecisionRequest, DecisionVerdict } from "../domain/decision.js";
import type { ReviewRequest, ReviewVerdictStatus } from "../domain/review.js";
import type { ReasoningEngine } from "../reasoning/reasoning-engine.js";

export interface ReviewEvaluationCase {
  readonly id: string;
  readonly request: ReviewRequest;
  readonly expectedStatus: ReviewVerdictStatus;
  readonly expectedBlockingCategories?: readonly string[];
  /** A known-good change used to measure annoying-reviewer false positives. */
  readonly goodChange: boolean;
  /** A known regression used to measure missed blockers. */
  readonly regression: boolean;
}

export interface ReviewEvaluationCaseResult {
  readonly id: string;
  readonly expectedStatus: ReviewVerdictStatus;
  readonly actualStatus: ReviewVerdictStatus;
  readonly statusCorrect: boolean;
  readonly falsePositive: boolean;
  readonly missedRegression: boolean;
  readonly genericFindingCount: number;
  readonly modelCalls: number;
  readonly adaptive: boolean;
}

export interface ReviewEvaluationReport {
  readonly caseCount: number;
  readonly statusAccuracy: number;
  readonly falsePositiveRate: number;
  readonly missedRegressionRate: number;
  readonly zeroModelApprovedChanges: number;
  readonly adaptiveCases: number;
  readonly genericFindingCount: number;
  readonly cases: readonly ReviewEvaluationCaseResult[];
}

export interface DecisionEvaluationCase {
  readonly id: string;
  readonly request: DecisionRequest;
  readonly expectedStatus: DecisionVerdict["status"];
}

export interface DecisionEvaluationReport {
  readonly caseCount: number;
  readonly statusAccuracy: number;
  readonly claimAccuracy: number;
  readonly zeroModelCases: number;
  readonly adaptiveCases: number;
  readonly implementationHandoffRate: number;
  readonly revisionHandoffRate: number;
}

type ReviewEngineFactory = (evaluationCase: ReviewEvaluationCase) => Promise<Pick<ReasoningEngine, "review">>;
type DecisionEngineFactory = (evaluationCase: DecisionEvaluationCase) => Promise<Pick<ReasoningEngine, "decide">>;

const GENERIC_SLOGAN = /\b(?:dry|kiss|solid|clean architecture|single responsibility)\b/iu;

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export async function runReviewEvaluation(
  cases: readonly ReviewEvaluationCase[],
  createEngine: ReviewEngineFactory,
): Promise<ReviewEvaluationReport> {
  const results: ReviewEvaluationCaseResult[] = [];
  for (const evaluationCase of cases) {
    const verdict = await (await createEngine(evaluationCase)).review(evaluationCase.request);
    const blockingCategories = new Set<string>(verdict.findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.category));
    const expectedCategories = evaluationCase.expectedBlockingCategories ?? [];
    const statusCorrect = verdict.status === evaluationCase.expectedStatus
      && expectedCategories.every((category) => blockingCategories.has(category));
    const concreteFindings = verdict.findings.filter((finding) => finding.severity !== "suggestion");
    results.push({
      id: evaluationCase.id,
      expectedStatus: evaluationCase.expectedStatus,
      actualStatus: verdict.status,
      statusCorrect,
      falsePositive: evaluationCase.goodChange && (verdict.status !== "approved" || concreteFindings.length > 0),
      missedRegression: evaluationCase.regression && !verdict.findings.some((finding) => finding.severity === "blocking"),
      genericFindingCount: verdict.findings.filter((finding) => GENERIC_SLOGAN.test(`${finding.statement} ${finding.consequence}`)).length,
      modelCalls: verdict.metrics.modelCalls,
      adaptive: verdict.analysis.route === "adaptive-orchestration",
    });
  }
  const good = results.filter((_, index) => cases[index]?.goodChange === true);
  const regressions = results.filter((_, index) => cases[index]?.regression === true);
  return {
    caseCount: results.length,
    statusAccuracy: ratio(results.filter((result) => result.statusCorrect).length, results.length),
    falsePositiveRate: ratio(good.filter((result) => result.falsePositive).length, good.length),
    missedRegressionRate: ratio(regressions.filter((result) => result.missedRegression).length, regressions.length),
    zeroModelApprovedChanges: results.filter((result) => result.actualStatus === "approved" && result.modelCalls === 0).length,
    adaptiveCases: results.filter((result) => result.adaptive).length,
    genericFindingCount: results.reduce((total, result) => total + result.genericFindingCount, 0),
    cases: results,
  };
}

export async function runDecisionEvaluation(
  cases: readonly DecisionEvaluationCase[],
  createEngine: DecisionEngineFactory,
): Promise<DecisionEvaluationReport> {
  const verdicts: DecisionVerdict[] = [];
  for (const evaluationCase of cases) verdicts.push(await (await createEngine(evaluationCase)).decide(evaluationCase.request));
  const proceed = verdicts.filter((verdict) => verdict.status === "proceed");
  const revise = verdicts.filter((verdict) => verdict.status === "revise");
  return {
    caseCount: verdicts.length,
    statusAccuracy: ratio(verdicts.filter((verdict, index) => verdict.status === cases[index]?.expectedStatus).length, verdicts.length),
    claimAccuracy: ratio(verdicts.reduce((total, verdict) => total + verdict.claims.filter((claim) => claim.status !== "uncertain").length, 0), verdicts.reduce((total, verdict) => total + verdict.claims.length, 0)),
    zeroModelCases: verdicts.filter((verdict) => verdict.metrics.modelCalls === 0).length,
    adaptiveCases: verdicts.filter((verdict) => !verdict.analysis.deterministic).length,
    implementationHandoffRate: ratio(proceed.filter((verdict) => verdict.implementationHandoff !== undefined).length, proceed.length),
    revisionHandoffRate: ratio(revise.filter((verdict) => verdict.revisionHandoff !== undefined).length, revise.length),
  };
}

import type {
  AnalysisDepth,
  DepthBudget,
  QueryAssessment,
  ReasoningPlan,
  ReviewRecommendation,
  SelectedAnalysisDepth,
} from "../domain/adaptive-reasoning.js";
import type { Claim, ReasoningLimits, VerificationResult } from "../domain/reasoning.js";
import type { GraphEdge } from "../domain/code-index.js";

const DEPTH_LIMITS: Readonly<Record<SelectedAnalysisDepth, Partial<ReasoningLimits>>> = {
  fast: {
    maxRounds: 1,
    maxFollowUpRequests: 2,
    maxAgentCalls: 2,
    maxEvidenceUnits: 16,
    maxApproximateInputTokens: 6_000,
    maxOutputTokensPerCall: 800,
  },
  balanced: {
    maxRounds: 2,
    maxFollowUpRequests: 6,
    maxAgentCalls: 6,
    maxEvidenceUnits: 24,
    maxApproximateInputTokens: 12_000,
    maxOutputTokensPerCall: 1_000,
  },
  deep: {},
};

const DEPTH_TIMEOUTS: Readonly<Record<SelectedAnalysisDepth, number>> = {
  fast: 12_000,
  balanced: 35_000,
  deep: 60_000,
};

function bound(value: number, hard: number): number {
  return Math.min(value, hard);
}

export function selectAnalysisDepth(
  requested: AnalysisDepth,
  assessment: QueryAssessment,
): SelectedAnalysisDepth {
  if (requested !== "auto") return requested;
  if (assessment.deterministicCoverage === "strong" && !assessment.requiresModelReasoning) return "fast";
  if (assessment.queryKind === "exact-lookup" || assessment.queryKind === "relationship") return "fast";
  if (
    assessment.queryKind === "task" ||
    (assessment.queryKind === "causal" && assessment.ambiguity === "high" && assessment.crossModule) ||
    (assessment.ambiguity === "high" && assessment.resolvedEntities.length > 1)
  ) return "deep";
  if (assessment.queryKind === "causal" || assessment.crossModule || assessment.ambiguity === "high") return "balanced";
  return "fast";
}

export function budgetForDepth(
  depth: SelectedAnalysisDepth,
  hardLimits: ReasoningLimits,
): DepthBudget {
  const preset = DEPTH_LIMITS[depth];
  return {
    depth,
    providerTimeoutMs: DEPTH_TIMEOUTS[depth],
    limits: {
      maxRounds: bound(preset.maxRounds ?? hardLimits.maxRounds, hardLimits.maxRounds),
      maxFollowUpRequests: bound(preset.maxFollowUpRequests ?? hardLimits.maxFollowUpRequests, hardLimits.maxFollowUpRequests),
      maxAgentCalls: bound(preset.maxAgentCalls ?? hardLimits.maxAgentCalls, hardLimits.maxAgentCalls),
      maxEvidenceUnits: bound(preset.maxEvidenceUnits ?? hardLimits.maxEvidenceUnits, hardLimits.maxEvidenceUnits),
      maxApproximateInputTokens: bound(preset.maxApproximateInputTokens ?? hardLimits.maxApproximateInputTokens, hardLimits.maxApproximateInputTokens),
      maxRepeatedRequestCount: hardLimits.maxRepeatedRequestCount,
      structuredOutputRepairAttempts: hardLimits.structuredOutputRepairAttempts,
      maxOutputTokensPerCall: bound(preset.maxOutputTokensPerCall ?? hardLimits.maxOutputTokensPerCall, hardLimits.maxOutputTokensPerCall),
    },
  };
}

export function deterministicReasoningPlan(
  assessment: QueryAssessment,
  depth: SelectedAnalysisDepth,
): ReasoningPlan {
  const causal = assessment.queryKind === "causal";
  const deep = depth === "deep";
  const architect = assessment.crossModule || causal || deep;
  const skeptic = causal || assessment.ambiguity !== "low" || deep;
  return {
    depth,
    strategy: assessment.deterministicCoverage === "strong"
      ? "deterministic"
      : causal ? "causal-investigation" : assessment.resolvedEntities.length > 0 ? "graph-first" : "retrieval-first",
    roles: [
      { role: "investigator", requirement: "required" },
      ...(skeptic ? [{ role: "skeptic" as const, requirement: deep ? "required" as const : "conditional" as const }] : []),
      ...(architect ? [{ role: "architect" as const, requirement: deep ? "required" as const : "conditional" as const }] : []),
      { role: "verifier", requirement: "conditional" },
      ...(deep ? [{ role: "judge" as const, requirement: "conditional" as const }] : []),
    ],
    modelRequirements: {
      investigator: { reasoning: depth === "fast" ? "low" : "medium", coding: "medium", speed: depth === "fast" ? "interactive" : "normal", context: depth === "deep" ? "large" : "medium" },
      skeptic: { reasoning: deep ? "high" : "medium", speed: "normal", context: "medium", independencePreferred: true },
      architect: { reasoning: deep ? "high" : "medium", coding: "high", speed: depth === "fast" ? "interactive" : "normal", context: "large" },
      verifier: { reasoning: "medium", coding: "high", speed: "normal", context: "medium", independencePreferred: true },
      judge: { reasoning: "high", speed: "slow-ok", context: "medium", independencePreferred: true },
    },
    finalReview: deep ? "recommended" : causal ? "conditional" : "none",
    reasonCodes: [
      `depth:${depth}`,
      `query:${assessment.queryKind}`,
      `coverage:${assessment.deterministicCoverage}`,
      `ambiguity:${assessment.ambiguity}`,
      ...(assessment.crossModule ? ["cross-module"] : []),
    ],
  };
}

export interface SufficiencyResult {
  readonly sufficient: boolean;
  readonly reason: string;
  readonly unresolvedClaimIds: readonly string[];
}

export function evaluateReasoningSufficiency(
  claims: readonly Claim[],
  verifications: readonly VerificationResult[],
  unresolvedCriticalRetrievals: number,
): SufficiencyResult {
  if (claims.length === 0) return { sufficient: false, reason: "no material claims were produced", unresolvedClaimIds: [] };
  const unresolved = claims.filter((claim) => {
    const decisions = verifications.filter((verification) => verification.claimId === claim.id);
    return !decisions.some((verification) => verification.deterministic && verification.outcome !== "uncertain");
  });
  if (unresolvedCriticalRetrievals > 0) {
    return { sufficient: false, reason: "critical retrieval requests remain unresolved", unresolvedClaimIds: unresolved.map((claim) => claim.id) };
  }
  if (unresolved.length > 0) {
    return { sufficient: false, reason: "material claims remain without deterministic resolution", unresolvedClaimIds: unresolved.map((claim) => claim.id) };
  }
  return { sufficient: true, reason: "all material claims were resolved by deterministic verification", unresolvedClaimIds: [] };
}

export function reviewRecommendation(
  assessment: QueryAssessment,
  claims: readonly Claim[],
  affectedFiles: number,
): ReviewRecommendation {
  const uncertain = claims.filter((claim) => claim.status === "uncertain");
  const securitySensitive = assessment.signals.includes("security-sensitive-language")
    || assessment.relevantFiles.some((path) => /(?:auth|crypto|security|permission|credential)/iu.test(path));
  const highImpact = assessment.queryKind === "causal" || assessment.queryKind === "task" || assessment.crossModule;
  const reasons = [
    ...(securitySensitive && highImpact && affectedFiles >= 3 ? ["Security-sensitive behavior spans multiple files."] : []),
    ...(affectedFiles >= 6 ? [`The conclusion spans ${String(affectedFiles)} files.`] : []),
    ...(uncertain.length > 0 ? [`${String(uncertain.length)} material claim${uncertain.length === 1 ? " remains" : "s remain"} uncertain.`] : []),
  ];
  return { recommended: reasons.length > 0, reasons };
}

export function createReviewHandoff(
  question: string,
  conclusion: string,
  claims: readonly Claim[],
  evidence: readonly { readonly id: string; readonly path: string; readonly startLine: number; readonly endLine: number }[],
  graphEdges: readonly GraphEdge[] = [],
): string {
  return [
    "Independent review objective: challenge Conclave's conclusion and identify unsupported or missing alternatives.",
    `Original request: ${question}`,
    `Conclave conclusion: ${conclusion}`,
    "Claims:",
    ...claims.map((claim) => `- [${claim.status}] ${claim.statement} (evidence: ${claim.evidenceIds.join(", ") || "none"})`),
    "Evidence:",
    ...evidence.map((item) => `- ${item.id}: ${item.path}:${String(item.startLine)}-${String(item.endLine)}`),
    "Graph relationships:",
    ...(graphEdges.length === 0
      ? ["- none resolved for this conclusion"]
      : graphEdges.map((edge) => `- ${edge.from.id} -[${edge.relation}]-> ${edge.to.id} (${edge.provenance.kind}: ${edge.provenance.path}${edge.provenance.line === undefined ? "" : `:${String(edge.provenance.line)}`})`)),
    "Do not assume Conclave is correct. Check the cited source and explicitly report contradictions, missing runtime verification, and alternative explanations.",
  ].join("\n");
}

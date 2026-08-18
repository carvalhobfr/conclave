import type {
  ValidationChallenge,
  ValidationChallengeStrategy,
  ValidationClaimResult,
  ValidationFinding,
  ValidationFindingKind,
} from "../domain/validation.js";

/**
 * Which deterministic findings can evidence a risk dimension. A dimension absent from this
 * map has no deterministic check at all, so selecting it states an open question the
 * structural layer is unable to answer.
 */
const DIMENSION_EVIDENCE: Partial<Readonly<Record<ValidationChallengeStrategy, readonly ValidationFindingKind[]>>> = {
  "data-integrity": ["inconsistent-key"],
  "lifecycle-state": ["unreleased-resource", "discarded-error"],
  "test-gap": ["exported-change-without-tests"],
  "blast-radius": ["impact-outside-diff"],
  "public-api-compatibility": ["exported-change-without-tests", "impact-outside-diff"],
};

export type DimensionCoverage = "evidenced" | "checked-clean" | "unchecked";

export interface DimensionStatus {
  readonly dimension: ValidationChallengeStrategy;
  readonly coverage: DimensionCoverage;
  readonly reason: string;
}

export interface EscalationAssessment {
  /** True when a model pass can still answer something the structural layer cannot. */
  readonly recommended: boolean;
  readonly dimensions: readonly DimensionStatus[];
  /** Plain reasons a reviewer or agent can act on, ordered as they were derived. */
  readonly reasons: readonly string[];
}

function statusFor(
  dimension: ValidationChallengeStrategy,
  findingKinds: ReadonlySet<ValidationFindingKind>,
): DimensionStatus {
  const evidence = DIMENSION_EVIDENCE[dimension];
  if (evidence === undefined) {
    return {
      dimension,
      coverage: "unchecked",
      reason: `The change trips the ${dimension} dimension and no deterministic check covers that class, so nothing here was examined.`,
    };
  }
  if (evidence.some((kind) => findingKinds.has(kind))) {
    return {
      dimension,
      coverage: "evidenced",
      reason: `The ${dimension} dimension produced a deterministic finding.`,
    };
  }
  return {
    dimension,
    coverage: "checked-clean",
    reason: `The ${dimension} dimension was checked deterministically and produced nothing.`,
  };
}

/**
 * Decides whether a model pass is worth its cost, using only signals the structural review
 * already computed. The challenge plan names the risks the diff carries; the findings name
 * what the deterministic layer could actually prove. What the first names and the second
 * cannot reach is the work left for a model.
 */
export function assessEscalation(
  challengePlan: readonly ValidationChallenge[],
  findings: readonly ValidationFinding[],
  claims: readonly ValidationClaimResult[],
): EscalationAssessment {
  const findingKinds = new Set(findings.map((item) => item.kind));
  const dimensions = challengePlan
    .filter((challenge) => challenge.strategy !== "baseline")
    .map((challenge) => statusFor(challenge.strategy, findingKinds));

  const reasons: string[] = [];
  for (const status of dimensions) {
    if (status.coverage === "unchecked") reasons.push(status.reason);
  }
  // Changed source the parser could not attach to any symbol leaves the graph blind, whatever
  // the dimensions say.
  if (findingKinds.has("claim-inconclusive")) {
    const inconclusive = claims.filter((claim) => claim.outcome === "inconclusive").length;
    reasons.push(
      inconclusive > 0
        ? `${String(inconclusive)} completion claim(s) could not be settled deterministically.`
        : "Changed source could not be mapped onto an indexed symbol, so structural impact is incomplete.",
    );
  }
  return { recommended: reasons.length > 0, dimensions, reasons };
}

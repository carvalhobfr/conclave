import type { IndexedCodeUnit } from "../domain/code-index.js";
import type {
  ChangeSet,
  ValidationChallenge,
  ValidationChallengeStrategy,
  ValidationContract,
  ValidationFinding,
} from "../domain/validation.js";

interface ChallengeCandidate extends ValidationChallenge {
  readonly priority: number;
}

function signalText(changeSet: ChangeSet, contract: ValidationContract, units: readonly IndexedCodeUnit[]): string {
  return [
    contract.objective,
    changeSet.patch.slice(0, 100_000),
    ...changeSet.files.map((file) => file.path),
    ...units.flatMap((unit) => [unit.path, unit.symbol]),
  ].join(" ").toLowerCase();
}

function matchingFindingIds(findings: readonly ValidationFinding[], kinds: readonly string[]): readonly string[] {
  const selected = new Set(kinds);
  return findings.filter((item) => selected.has(item.kind)).map((item) => item.id).slice(0, 8);
}

function candidate(
  strategy: ValidationChallengeStrategy,
  priority: number,
  reason: string,
  suggestedProbes: readonly string[],
  evidenceIds: readonly string[] = [],
): ChallengeCandidate {
  return { strategy, priority, reason, evidenceIds, suggestedProbes: suggestedProbes.slice(0, 3) };
}

export function createChallengePlan(
  changeSet: ChangeSet,
  contract: ValidationContract,
  changedUnits: readonly IndexedCodeUnit[],
  impactedFiles: ReadonlySet<string>,
  findings: readonly ValidationFinding[],
): readonly ValidationChallenge[] {
  const text = signalText(changeSet, contract, changedUnits);
  const candidates: ChallengeCandidate[] = [];
  if (/\b(?:auth|authorization|permission|credential|secret|token|crypto|password|session|input|sanitize|injection)\b/u.test(text)) {
    candidates.push(candidate(
      "security",
      100,
      "The change touches authentication, authorization, secrets, sessions, or untrusted-input boundaries.",
      ["Exercise unauthorized and malformed-input paths.", "Verify secrets and tokens cannot cross logs, client bundles, or tenant boundaries."],
    ));
  }
  if (/\b(?:migration|schema|database|storage|persist|repository|transaction|sql|record|column|table)\b/u.test(text)) {
    candidates.push(candidate(
      "data-integrity",
      90,
      "The change touches persistent state, schema, migration, or transactional behavior.",
      ["Test upgrade, rollback, partial-failure, and existing-data compatibility.", "Verify writes remain atomic and preserve required invariants."],
    ));
  }
  if (/\b(?:async|await|event|listener|session|cache|retry|queue|lifecycle|state|restore|bootstrap|timeout|race)\b/u.test(text)) {
    candidates.push(candidate(
      "lifecycle-state",
      85,
      "The change affects asynchronous, event-driven, cached, restored, or stateful behavior.",
      ["Probe repeated initialization, interruption, retry, and cleanup.", "Exercise stale, missing, expired, and concurrently updated state."],
    ));
  }
  const exported = changedUnits.filter((unit) => unit.exported);
  if (exported.length > 0) {
    candidates.push(candidate(
      "public-api-compatibility",
      80,
      String(exported.length) + " changed code unit(s) are exported public behavior.",
      ["Check existing callers against the previous signature and behavior.", "Verify serialization, error, and default-value compatibility."],
      matchingFindingIds(findings, ["exported-change-without-tests", "impact-outside-diff"]),
    ));
  }
  const unchangedImpact = [...impactedFiles].filter((path) => !changeSet.files.some((file) => file.path === path));
  if (unchangedImpact.length >= 3) {
    candidates.push(candidate(
      "blast-radius",
      75,
      "The graph reaches " + String(unchangedImpact.length) + " unchanged files outside the diff.",
      ["Sample the highest fan-in callers and cross-module contracts.", "Test one unchanged consumer from each affected module."],
      matchingFindingIds(findings, ["impact-outside-diff"]),
    ));
  }
  if (/\b(?:performance|latency|throughput|memory|cpu|batch|stream|render|query|index|cache)\b/u.test(text)) {
    candidates.push(candidate(
      "performance",
      65,
      "The change touches performance-sensitive execution, rendering, querying, batching, or caching.",
      ["Compare latency and resource use on a matched baseline workload.", "Probe worst-case input size and repeated execution."],
    ));
  }
  if (/\b(?:ui|ux|component|css|style|aria|accessibility|screen|form|button|dialog|modal|responsive)\b/u.test(text)) {
    candidates.push(candidate(
      "ux-accessibility",
      60,
      "The change touches a user interface or accessibility-sensitive artifact.",
      ["Check keyboard, focus, screen-reader labels, error, loading, and empty states.", "Inspect representative responsive viewports and high-content states."],
    ));
  }
  const testGapIds = matchingFindingIds(findings, ["exported-change-without-tests"]);
  if (testGapIds.length > 0) {
    candidates.push(candidate(
      "test-gap",
      95,
      "Changed exported production behavior has no changed test evidence.",
      ["Identify an existing test that exercises the changed behavior or add a focused regression test.", "Include a failure-path or boundary-case assertion, not only the happy path."],
      testGapIds,
    ));
  }
  const baseline: ValidationChallenge = {
    strategy: "baseline",
    reason: "Every review preserves the deterministic Git, parser, graph, scope, and claim checks.",
    evidenceIds: findings.slice(0, 8).map((item) => item.id),
    suggestedProbes: ["Review the highest-severity deterministic finding and its cited evidence."],
  };
  const selected = candidates
    .sort((left, right) => right.priority - left.priority || left.strategy.localeCompare(right.strategy))
    .slice(0, 3)
    .map((item): ValidationChallenge => ({
      strategy: item.strategy,
      reason: item.reason,
      evidenceIds: item.evidenceIds,
      suggestedProbes: item.suggestedProbes,
    }));
  return [baseline, ...selected];
}

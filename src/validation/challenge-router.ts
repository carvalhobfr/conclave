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

/**
 * Git's own diff header vocabulary (`index <hash>..<hash> <mode>`, `--- a/...`, `similarity
 * index NN%`) matches several risk keywords by accident, notably "index" and "similarity"
 * inside "similarity index". Left in, the "performance" dimension fires on the mere presence
 * of a modified file rather than on anything the diff actually does. Only Git's own metadata
 * lines are removed; hunk headers keep their trailing source context, and unchanged
 * surrounding lines that unified diffs may include stay in.
 */
const GIT_HEADER_LINE = /^(?:diff --git |index [0-9a-f]|--- |\+\+\+ |(?:old|new) (?:file )?mode |similarity index |rename (?:from|to) |dissimilarity index |Binary files )/u;

function diffContent(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => !GIT_HEADER_LINE.test(line))
    .join("\n");
}

function signalText(changeSet: ChangeSet, contract: ValidationContract, units: readonly IndexedCodeUnit[]): string {
  return [
    contract.objective,
    diffContent(changeSet.patch.slice(0, 100_000)),
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
  // Test gaps and blast radius describe how the change was made, not a class of defect. Ranked
  // together they outrank probes like lifecycle-state and silently take their slots, so each
  // group keeps its own budget.
  const processStrategies = new Set<ValidationChallengeStrategy>(["test-gap", "blast-radius"]);
  const byPriority = (left: ChallengeCandidate, right: ChallengeCandidate): number =>
    right.priority - left.priority || left.strategy.localeCompare(right.strategy);
  const selected = [
    ...candidates.filter((item) => !processStrategies.has(item.strategy)).sort(byPriority).slice(0, 3),
    ...candidates.filter((item) => processStrategies.has(item.strategy)).sort(byPriority).slice(0, 2),
  ]
    .sort(byPriority)
    .map((item): ValidationChallenge => ({
      strategy: item.strategy,
      reason: item.reason,
      evidenceIds: item.evidenceIds,
      suggestedProbes: item.suggestedProbes,
    }));
  return [baseline, ...selected];
}

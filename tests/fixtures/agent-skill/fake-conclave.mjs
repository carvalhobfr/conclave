const objectiveIndex = process.argv.indexOf("--objective");
const objective = objectiveIndex < 0 ? "" : process.argv[objectiveIndex + 1] ?? "";
const verdict = objective.includes("BLOCK") ? "block" : objective.includes("INCONCLUSIVE") ? "inconclusive" : "pass";
const exit = { pass: 0, block: 1, inconclusive: 2 }[verdict];
const outcome = verdict === "block" ? "rejected" : verdict === "inconclusive" ? "inconclusive" : "supported";
const severity = verdict === "block" ? "blocking" : "warning";
const findings = verdict === "pass" ? [] : [{ id: "finding", kind: verdict === "block" ? "claim-contradicted" : "claim-inconclusive", severity, title: verdict, detail: verdict, evidence: [], remediation: "Fix or add evidence." }];
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  verdict,
  summary: verdict.toUpperCase(),
  objective,
  changeSet: { source: { kind: "working" }, headSha: "abc", files: [], collectedAt: new Date(0).toISOString(), patchBytes: 0 },
  findings,
  claims: [{ claim: { id: "claim", statement: "Claim", check: { kind: "symbol-exists", symbol: "value", expectation: "present" } }, outcome, explanation: outcome, evidence: [] }],
  impact: { changedSymbols: [], impactedFiles: [], impactedSymbols: [] },
  metrics: { filesChanged: 0, symbolsChanged: 0, impactedFiles: 0, impactedSymbols: 0, graphEdgesInspected: 0, deterministicChecks: 1, durationMs: 1 },
}));
process.exitCode = exit;

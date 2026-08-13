import type { ValidationReport } from "./validation.js";

export interface ReviewHandoff {
  readonly needsWork: boolean;
  readonly title: string;
  readonly prompt: string;
}

function evidenceLines(report: ValidationReport): readonly string[] {
  return report.findings.flatMap((finding) => finding.evidence.slice(0, 5).map((evidence) => {
    const location = evidence.startLine === undefined ? evidence.path : `${evidence.path}:${String(evidence.startLine)}`;
    return `  - ${location}: ${evidence.reason}`;
  }));
}

/** Builds a portable correction request for Codex, Claude Code, or another coding agent. */
export function createReviewHandoff(report: ValidationReport): ReviewHandoff {
  const needsWork = report.verdict === "block" || report.verdict === "inconclusive" || report.findings.some((finding) => finding.severity === "warning");
  const findings = report.findings.filter((finding) => finding.severity !== "info").slice(0, 8);
  const lines = [
    needsWork ? "Address the Conclave review findings below." : "Review the Conclave evidence below before merging.",
    "",
    `Objective: ${report.objective}`,
    `Verdict: ${report.verdict.toUpperCase()}`,
    `Comparison: ${report.changeSet.source.kind}`,
    "",
    ...(findings.length === 0 ? ["No deterministic blocker or warning was found."] : findings.flatMap((finding) => [
      `${finding.severity.toUpperCase()}: ${finding.title}`,
      finding.detail,
      `Requested correction: ${finding.remediation}`,
    ])),
    ...evidenceLines({ ...report, findings }),
    ...(report.findings.filter((finding) => finding.severity !== "info").length > findings.length
      ? [`\n${String(report.findings.filter((finding) => finding.severity !== "info").length - findings.length)} additional findings remain in the full report.`]
      : []),
    "",
    "Make only changes justified by this evidence. Run the repository's relevant tests, then run `conclave check .` again. Do not commit, push, or merge unless the user explicitly asks.",
  ];
  return {
    needsWork,
    title: needsWork ? "Correction handoff" : "Human review handoff",
    prompt: lines.join("\n"),
  };
}

import type { ValidationReport } from "./validation.js";

export interface PullRequestSummary {
  readonly title: string;
  readonly summary: string;
  readonly comparison: string;
  readonly verdict: ValidationReport["verdict"];
  readonly changedFiles: readonly {
    readonly path: string;
    readonly status: string;
    readonly hunks: number;
  }[];
  readonly changedCodeUnits: number;
  readonly impactedFiles: number;
  readonly risks: readonly string[];
  readonly nextSteps: readonly string[];
}

function comparison(report: ValidationReport): string {
  switch (report.changeSet.source.kind) {
    case "branch":
      return `HEAD compared with ${report.changeSet.source.base}`;
    case "commit":
      return `Commit ${report.changeSet.source.commit} compared with its parent`;
    case "staged":
      return "Staged changes compared with HEAD";
    case "working":
      return "Working tree compared with HEAD";
  }
}

function title(report: ValidationReport): string {
  const first = report.changeSet.files[0]?.path;
  if (report.changeSet.files.length === 0) return "Change summary";
  if (report.changeSet.files.length === 1 && first !== undefined) return `Update ${first}`;
  return `Update ${String(report.changeSet.files.length)} files`;
}

export function createPullRequestSummary(report: ValidationReport): PullRequestSummary {
  const fileCount = report.metrics.filesChanged;
  const impact = report.metrics.impactedFiles;
  const summary = fileCount === 0
    ? "No code change was collected for this comparison."
    : `This change updates ${String(fileCount)} ${fileCount === 1 ? "file" : "files"}, touches ${String(report.metrics.symbolsChanged)} code units, and may affect ${String(impact)} ${impact === 1 ? "file" : "files"} through local dependencies.`;
  const risks = report.findings
    .filter((finding) => finding.severity !== "info")
    .slice(0, 5)
    .map((finding) => `${finding.severity.toUpperCase()}: ${finding.title}`);
  const nextSteps = report.verdict === "pass"
    ? ["Review the evidence and run the repository's tests before merging."]
    : report.verdict === "warn"
      ? ["Inspect the warnings and affected code before requesting human approval."]
      : report.verdict === "block"
        ? ["Resolve the blocking findings, then run `conclave pr` again."]
        : ["Provide a clearer objective or baseline, then run `conclave pr` again."];
  return {
    title: title(report),
    summary,
    comparison: comparison(report),
    verdict: report.verdict,
    changedFiles: report.changeSet.files.map((file) => ({
      path: file.path,
      status: file.status,
      hunks: file.hunks.length,
    })),
    changedCodeUnits: report.metrics.symbolsChanged,
    impactedFiles: impact,
    risks,
    nextSteps,
  };
}

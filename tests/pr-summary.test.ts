import { describe, expect, it } from "vitest";

import { createPullRequestSummary } from "../src/domain/pr-summary.js";
import type { ValidationReport } from "../src/domain/validation.js";

function report(overrides: Partial<ValidationReport> = {}): ValidationReport {
  return {
    schemaVersion: 1,
    verdict: "pass",
    summary: "PASS",
    objective: "Restore the session",
    changeSet: {
      source: { kind: "branch", base: "origin/main" },
      headSha: "abc",
      files: [{ path: "src/session.ts", status: "modified", hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }] }],
      collectedAt: "2026-01-01T00:00:00.000Z",
      patchBytes: 20,
    },
    findings: [],
    claims: [],
    impact: { changedSymbols: ["restoreSession"], impactedFiles: ["src/session.ts"], impactedSymbols: ["restoreSession"] },
    metrics: { filesChanged: 1, symbolsChanged: 1, impactedFiles: 1, impactedSymbols: 1, graphEdgesInspected: 1, deterministicChecks: 0, durationMs: 1 },
    trustBoundary: {
      deterministic: true,
      reasoningModelCalls: 0,
      repositoryScriptsExecuted: false,
      knowledge: { parser: "test", graph: "syntax-aware", embedding: { id: "test", kind: "deterministic-feature-hash", remoteCalls: 0 } },
    },
    ...overrides,
  };
}

describe("pull request summaries", () => {
  it("turns a validation report into a human-readable change summary", () => {
    const result = createPullRequestSummary(report());
    expect(result.title).toBe("Update src/session.ts");
    expect(result.comparison).toBe("HEAD compared with origin/main");
    expect(result.summary).toContain("updates 1 file");
    expect(result.nextSteps[0]).toContain("tests");
  });

  it("prioritizes blocking findings as next steps", () => {
    const result = createPullRequestSummary(report({
      verdict: "block",
      findings: [{
        id: "finding-1",
        kind: "claim-contradicted",
        severity: "blocking",
        title: "Claim contradicted",
        detail: "The claim is not supported.",
        evidence: [],
        remediation: "Fix it.",
      }],
    }));
    expect(result.risks).toEqual(["BLOCKING: Claim contradicted"]);
    expect(result.nextSteps[0]).toContain("blocking findings");
  });
});

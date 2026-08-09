import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runReviewEvaluation, type ReviewEvaluationCase } from "../src/evaluation/validation-evaluation.js";
import { FakeProvider } from "../src/providers/fake-provider.js";
import { createReasoningFixtureEngine } from "./helpers/reasoning-fixture.js";

const cases: readonly ReviewEvaluationCase[] = [
  {
    id: "good-simple-code-choice",
    goodChange: true,
    regression: false,
    expectedStatus: "approved",
    request: {
      objective: "Normalize the persisted token before storing it.",
      unifiedDiff: [
        "diff --git a/src/auth/storage.ts b/src/auth/storage.ts",
        "--- a/src/auth/storage.ts",
        "+++ b/src/auth/storage.ts",
        "@@ -4,1 +4,1 @@",
        "-  token = nextToken;",
        "+  token = nextToken.trim();",
      ].join("\n"),
    },
  },
  {
    id: "good-type-contract",
    goodChange: true,
    regression: false,
    expectedStatus: "approved",
    request: {
      objective: "Add a compile-time validation result contract.",
      unifiedDiff: [
        "diff --git a/src/contracts.ts b/src/contracts.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/contracts.ts",
        "@@ -0,0 +1,6 @@",
        "+export interface ValidationSummary {",
        "+  readonly status: \"approved\" | \"uncertain\";",
        "+  readonly findingCount: number;",
        "+}",
        "+",
        "+export type ValidationMode = \"deterministic\" | \"adaptive\";",
      ].join("\n"),
    },
  },
  {
    id: "good-documentation",
    goodChange: true,
    regression: false,
    expectedStatus: "approved",
    request: {
      objective: "Document Review behavior.",
      unifiedDiff: [
        "diff --git a/docs/review.md b/docs/review.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/docs/review.md",
        "@@ -0,0 +1,1 @@",
        "+Review validates repository consequences.",
      ].join("\n"),
    },
  },
  {
    id: "merge-conflict-regression",
    goodChange: false,
    regression: true,
    expectedStatus: "changes-requested",
    expectedBlockingCategories: ["merge-conflict"],
    request: {
      unifiedDiff: [
        "diff --git a/src/auth/storage.ts b/src/auth/storage.ts",
        "--- a/src/auth/storage.ts",
        "+++ b/src/auth/storage.ts",
        "@@ -1 +1 @@",
        "+<<<<<<< HEAD",
      ].join("\n"),
    },
  },
  {
    id: "secret-regression",
    goodChange: false,
    regression: true,
    expectedStatus: "changes-requested",
    expectedBlockingCategories: ["secret-exposure"],
    request: {
      unifiedDiff: [
        "diff --git a/src/config.ts b/src/config.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/config.ts",
        "@@ -0,0 +1 @@",
        "+export const key = \"sk-live-example-review-token\";",
      ].join("\n"),
    },
  },
  {
    id: "adaptive-auth-regression",
    goodChange: false,
    regression: true,
    expectedStatus: "changes-requested",
    request: {
      objective: "Preserve authentication after refresh.",
      unifiedDiff: [
        "diff --git a/src/auth/AuthProvider.ts b/src/auth/AuthProvider.ts",
        "--- a/src/auth/AuthProvider.ts",
        "+++ b/src/auth/AuthProvider.ts",
        "@@ -4,2 +4,2 @@",
        "-  const restored = getStoredToken();",
        "+  setSession(null);",
      ].join("\n"),
    },
  },
];

describe("adaptive Review evaluation", () => {
  it("measures approvals, false positives, and missed regressions", async () => {
    const report = await runReviewEvaluation(cases, (evaluationCase) => createReasoningFixtureEngine(
      evaluationCase.id === "good-simple-code-choice" ? new FakeProvider((request) => ({
        provider: "fake",
        model: request.model,
        text: JSON.stringify({ summary: "No concrete defect is supported.", claims: [], retrievalRequests: [] }),
      })) : undefined,
      10,
      evaluationCase.id === "good-type-contract" ? resolve("tests/fixtures/review-positive") : undefined,
    ));

    expect(report.caseCount).toBe(6);
    expect(report.statusAccuracy, JSON.stringify(report.cases)).toBe(1);
    expect(report.falsePositiveRate).toBe(0);
    expect(report.missedRegressionRate).toBe(0);
    expect(report.zeroModelApprovedChanges).toBe(2);
    expect(report.adaptiveCases).toBeGreaterThan(0);
    expect(report.genericFindingCount).toBe(0);
  });
});

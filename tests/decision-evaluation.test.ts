import { describe, expect, it } from "vitest";

import { runDecisionEvaluation, type DecisionEvaluationCase } from "../src/evaluation/validation-evaluation.js";
import { createReasoningFixtureEngine } from "./helpers/reasoning-fixture.js";

const cases: readonly DecisionEvaluationCase[] = [
  { id: "known-symbol", request: { proposal: "bootstrapSession exists." }, expectedStatus: "proceed" },
  { id: "missing-symbol", request: { proposal: "missingBootstrap exists." }, expectedStatus: "revise" },
  {
    id: "adaptive-auth-proposal",
    request: {
      objective: "Preserve authentication after refresh.",
      proposal: "Use bootstrapSession to restore persisted authentication.\nThis will preserve login state after refresh.",
    },
    expectedStatus: "uncertain",
  },
];

describe("Decision Validation evaluation", () => {
  it("benchmarks claim accuracy, adaptive routing, and handoff generation", async () => {
    const report = await runDecisionEvaluation(cases, () => createReasoningFixtureEngine());

    expect(report.caseCount).toBe(3);
    expect(report.statusAccuracy).toBe(1);
    expect(report.claimAccuracy).toBeGreaterThan(0.5);
    expect(report.zeroModelCases).toBe(2);
    expect(report.adaptiveCases).toBe(1);
    expect(report.implementationHandoffRate).toBe(1);
    expect(report.revisionHandoffRate).toBe(1);
  });
});

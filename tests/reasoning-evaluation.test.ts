import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadReasoningEvaluationCases,
  runReasoningEvaluation,
} from "../src/evaluation/reasoning-evaluation.js";
import { createReasoningFixtureEngine } from "./helpers/reasoning-fixture.js";

describe("reasoning evaluation", () => {
  it("shows the Conclave pipeline outperforming both fixed baselines", async () => {
    const cases = await loadReasoningEvaluationCases(
      resolve("tests/fixtures/reasoning-auth/reasoning-eval-cases.json"),
    );
    const report = await runReasoningEvaluation(cases, createReasoningFixtureEngine);
    const single = report.strategies.find((strategy) => strategy.strategy === "single-model");
    const investigatorJudge = report.strategies.find(
      (strategy) => strategy.strategy === "investigator-judge",
    );
    const conclave = report.strategies.find((strategy) => strategy.strategy === "conclave");

    expect(report.caseCount).toBe(2);
    expect(conclave?.metrics.answerAccuracy).toBe(1);
    expect(conclave?.metrics.supportedClaimPrecision).toBe(1);
    expect(conclave?.metrics.unsupportedClaimRate).toBe(0);
    expect(conclave?.metrics.incorrectClaimRejectionRate).toBe(1);
    expect(conclave?.metrics.expectedEvidenceRecall).toBe(1);
    expect(conclave?.metrics.retrievalRounds).toBeGreaterThan(0);
    expect(conclave?.metrics.modelCalls).toBeGreaterThan(single?.metrics.modelCalls ?? 0);
    expect(single?.metrics.answerAccuracy).toBeLessThan(1);
    expect(investigatorJudge?.metrics.answerAccuracy).toBeLessThan(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  causalQuestion,
  createReasoningFixtureEngine,
  reasoningFixtureProvider,
} from "./helpers/reasoning-fixture.js";

describe("ReasoningEngine", () => {
  it("rejects a plausible wrong claim after graph retrieval and excludes it from the verdict", async () => {
    const result = await (await createReasoningFixtureEngine()).ask(causalQuestion);

    expect(result.verdict.claims.rejected.map((claim) => claim.statement)).toContain(
      "The token is never persisted.",
    );
    expect(result.verdict.claims.supported.map((claim) => claim.statement)).toContain(
      "The persisted token is not restored during bootstrapSession.",
    );
    expect(result.verdict.answer).toContain("The persisted token is not restored");
    expect(result.verdict.answer).not.toContain("The token is never persisted");
    expect(result.verdict.answer).toMatch(/src\/auth\/[^:]+:\d+-\d+/);
    expect(result.state.retrievalRequests.filter((request) => request.request.kind === "callers")).toHaveLength(1);
    expect(result.state.verifications.some((verification) => verification.deterministic)).toBe(true);
    expect(result.verdict.traceSummary.agentsExecuted).toEqual(
      expect.arrayContaining(["investigator", "skeptic", "architect", "verifier", "judge"]),
    );
  });

  it("skips unnecessary review agents for a simple lookup", async () => {
    const result = await (await createReasoningFixtureEngine()).ask("Where is bootstrapSession called?");

    expect(result.state.selections.find((selection) => selection.role === "skeptic")?.selected).toBe(false);
    expect(result.state.selections.find((selection) => selection.role === "architect")?.selected).toBe(false);
  });

  it("terminates gracefully when the model-call budget is exhausted", async () => {
    const result = await (
      await createReasoningFixtureEngine(reasoningFixtureProvider(), 1)
    ).ask(causalQuestion);

    expect(result.terminationReason).toBe("budget-exhausted");
    expect(result.metrics.modelCalls).toBe(1);
    expect(result.trace.some((event) => event.type === "reasoning_budget_exhausted")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { FakeProvider } from "../src/providers/fake-provider.js";
import { createReasoningFixtureEngine, reasoningFixtureProvider } from "./helpers/reasoning-fixture.js";

function delayedProvider(delayMs: number): FakeProvider {
  const fixture = reasoningFixtureProvider();
  return new FakeProvider(async (request) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fixture.generate(request);
  });
}

describe("adaptive orchestration evaluation", () => {
  it("preserves a correct graph answer while reducing total calls, context, roles, and simulated latency", async () => {
    const question = "Where is bootstrapSession called?";
    const auto = await (await createReasoningFixtureEngine(delayedProvider(10))).ask(question, "conclave", { depth: "auto", intent: "ask" });
    const full = await (await createReasoningFixtureEngine(delayedProvider(10))).ask(question, "full-style", { depth: "deep", intent: "ask" });

    expect(auto.verdict.answer).toContain("bootstrapSession");
    expect(auto.metrics.modelCalls).toBe(0);
    expect(full.metrics.modelCalls).toBeGreaterThanOrEqual(2);
    expect(auto.metrics.approximateInputTokens).toBe(0);
    expect(full.metrics.approximateInputTokens).toBeGreaterThan(0);
    expect(auto.metrics.latencyMs).toBeLessThan(full.metrics.latencyMs);
    expect(auto.verdict.traceSummary.agentsExecuted.length).toBeLessThan(full.verdict.traceSummary.agentsExecuted.length);
  });

  it("keeps full causal correctness properties while routing from knowledge first", async () => {
    const question = "Why might authentication disappear after refreshing across the auth modules?";
    const auto = await (await createReasoningFixtureEngine(delayedProvider(1))).ask(question, "conclave", { depth: "auto", intent: "investigate" });
    const full = await (await createReasoningFixtureEngine(delayedProvider(1))).ask(question, "full-style", { depth: "deep", intent: "investigate" });

    for (const result of [auto, full]) {
      expect(result.verdict.claims.supported.map((claim) => claim.statement)).toContain("The persisted token is not restored during bootstrapSession.");
      expect(result.verdict.claims.rejected.map((claim) => claim.statement)).toContain("The token is never persisted.");
    }
    expect(auto.metrics.modelCalls).toBeLessThanOrEqual(full.metrics.modelCalls);
    expect(auto.metrics.deterministicOperations).toBeGreaterThan(0);
  });
});

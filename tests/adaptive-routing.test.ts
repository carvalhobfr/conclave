import { describe, expect, it } from "vitest";

import { resolve } from "node:path";
import { createDemoReasoningEngine } from "../src/web/demo-runtime.js";
import { causalQuestion, createReasoningFixtureEngine, reasoningFixtureProvider } from "./helpers/reasoning-fixture.js";

describe("knowledge-first adaptive routing", () => {
  it("bypasses every model role for a graph-resolvable question", async () => {
    const provider = reasoningFixtureProvider();
    const result = await (await createReasoningFixtureEngine(provider)).ask(
      "Where is bootstrapSession called?",
      "conclave",
      { depth: "auto", intent: "ask" },
    );

    expect(result.metrics.modelCalls).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(result.analysis.deterministicAnswer).toBe(true);
    expect(result.analysis.conductorInvoked).toBe(false);
    expect(result.verdict.traceSummary.agentsExecuted).toHaveLength(0);
  });

  it("uses one Investigator call, deterministic verification, and early exit for a simple natural-language Ask", async () => {
    const result = await (await createReasoningFixtureEngine()).ask(
      "Where do we persist the login token?",
      "conclave",
      { depth: "auto", intent: "ask" },
    );

    expect(result.metrics.modelCalls).toBe(1);
    expect(result.metrics.roleUsage.find((usage) => usage.role === "investigator")?.calls).toBe(1);
    expect(result.metrics.roleUsage.find((usage) => usage.role === "judge")?.calls).toBe(0);
    expect(result.metrics.earlyExit).toBe(true);
    expect(result.verdict.claims.supported[0]?.statement).toContain("persistToken");
  });

  it("escalates causal cross-module work and invokes Judge only for a challenged claim", async () => {
    const result = await (await createReasoningFixtureEngine()).ask(causalQuestion, "conclave", {
      depth: "auto",
      intent: "investigate",
    });

    expect(result.analysis.selectedDepth).toBe("balanced");
    expect(result.verdict.traceSummary.agentsExecuted).toEqual(expect.arrayContaining(["investigator", "skeptic", "architect", "verifier", "judge"]));
    expect(result.state.challenges.length).toBeGreaterThan(0);
  });

  it("forces a stronger route in Deep while keeping hard limits authoritative", async () => {
    const result = await (await createReasoningFixtureEngine()).ask(
      "Where do we persist the login token?",
      "conclave",
      { depth: "deep", intent: "ask" },
    );

    expect(result.analysis.requestedDepth).toBe("deep");
    expect(result.analysis.selectedDepth).toBe("deep");
    expect(result.metrics.modelCalls).toBeGreaterThan(1);
    expect(result.metrics.modelCalls).toBeLessThanOrEqual(10);
    expect(result.metrics.roleUsage.find((usage) => usage.role === "judge")?.calls).toBe(1);
  });

  it.each(["fast", "balanced", "deep"] as const)("honors forced %s depth", async (depth) => {
    const result = await (await createReasoningFixtureEngine()).ask(
      "Where do we persist the login token?",
      "conclave",
      { depth, intent: "ask" },
    );

    expect(result.analysis.requestedDepth).toBe(depth);
    expect(result.analysis.selectedDepth).toBe(depth);
    expect(result.metrics.modelCalls).toBeLessThanOrEqual(depth === "fast" ? 2 : depth === "balanced" ? 6 : 10);
  });

  it("invokes the optional Conductor for a high-ambiguity causal demo route", async () => {
    const result = await (await createDemoReasoningEngine(resolve("demo/auth-repository"))).ask(
      "Why might authentication disappear after refresh?",
      "conclave",
      { depth: "auto", intent: "investigate" },
    );

    expect(result.analysis.conductorInvoked).toBe(true);
    expect(result.metrics.roleUsage.find((usage) => usage.role === "conductor")?.calls).toBe(1);
  });

  it("recommends and packages independent review for a multi-file authentication conclusion", async () => {
    const result = await (await createReasoningFixtureEngine()).ask(causalQuestion, "conclave", {
      depth: "auto",
      intent: "investigate",
    });

    expect(result.analysis.review.recommended).toBe(true);
    expect(result.analysis.review.reasons.join(" ")).toMatch(/Security-sensitive|uncertain/u);
    expect(result.analysis.review.handoff).toContain("Do not assume Conclave is correct");
    expect(result.analysis.review.handoff).toContain("Graph relationships:");
    expect(result.analysis.review.handoff).not.toContain("chain-of-thought");
  });

  it("keeps the previous full-style route available for unchanged comparison fixtures", async () => {
    const auto = await (await createReasoningFixtureEngine()).ask("Where is bootstrapSession called?", "conclave", { depth: "auto", intent: "ask" });
    const full = await (await createReasoningFixtureEngine()).ask("Where is bootstrapSession called?", "full-style", { depth: "deep", intent: "ask" });

    expect(auto.metrics.modelCalls).toBe(0);
    expect(full.metrics.modelCalls).toBeGreaterThan(auto.metrics.modelCalls);
    expect(full.metrics.approximateInputTokens).toBeGreaterThan(auto.metrics.approximateInputTokens);
  });
});

import { describe, expect, it } from "vitest";

import type { ModelProfile } from "../src/domain/adaptive-reasoning.js";
import { ProviderHealthTracker } from "../src/providers/provider-health.js";
import { ModelSelector } from "../src/reasoning/model-selector.js";

const profiles: readonly ModelProfile[] = [
  { providerId: "free", modelId: "fast", capabilities: { reasoning: "medium", coding: "medium", speed: "fast", context: "medium" }, costClass: "free" },
  { providerId: "paid", modelId: "reasoner", capabilities: { reasoning: "high", coding: "high", speed: "medium", context: "large" }, costClass: "standard" },
  { providerId: "paid", modelId: "reviewer", capabilities: { reasoning: "high", coding: "medium", speed: "slow", context: "large" }, costClass: "premium" },
];

describe("ModelSelector", () => {
  it("matches capabilities without binding reasoning policy to a named model", () => {
    const selected = new ModelSelector({ profiles }).select("architect", { reasoning: "high", coding: "high", context: "large" });
    expect(selected?.assignment).toMatchObject({ providerId: "paid", modelId: "reasoner" });
  });

  it("respects an available explicit role override", () => {
    const selected = new ModelSelector({ profiles, explicitAssignments: [{ role: "architect", providerId: "free", modelId: "fast" }] }).select("architect", { reasoning: "high" });
    expect(selected?.assignment.modelId).toBe("fast");
    expect(selected?.reason).toContain("explicit");
  });

  it("enforces free-only and returns no model when none is eligible", () => {
    const selector = new ModelSelector({ profiles });
    expect(selector.select("judge", { costPreference: "free-only", reasoning: "medium" })?.assignment.modelId).toBe("fast");
    expect(selector.select("judge", { costPreference: "free-only", reasoning: "high" })).toBeUndefined();
  });

  it("prefers an independent eligible model", () => {
    const selected = new ModelSelector({ profiles }).select("judge", { reasoning: "high", independencePreferred: true }, ["paid:reasoner"]);
    expect(selected?.assignment.modelId).toBe("reviewer");
  });

  it("uses only an explicitly configured fallback after failure", () => {
    const health = new ProviderHealthTracker(2);
    health.record("free", "fast", false, 10);
    health.record("free", "fast", false, 10);
    const explicit = [{ role: "investigator" as const, providerId: "free", modelId: "fast" }];
    expect(new ModelSelector({ profiles, explicitAssignments: explicit, health }).select("investigator")).toBeUndefined();
    const fallback = new ModelSelector({ profiles, explicitAssignments: explicit, health, fallbackPolicy: "configured" }).select("investigator", { reasoning: "high" });
    expect(fallback?.fallback).toBe(true);
    expect(fallback?.assignment.modelId).toBe("reasoner");
  });

  it("keeps provider and model identities separate", () => {
    const selected = new ModelSelector({ profiles }).select("investigator", { speed: "interactive" });
    expect(selected?.assignment.providerId).toBe("free");
    expect(selected?.assignment.modelId).toBe("fast");
  });
});

import { describe, expect, it } from "vitest";

import { DEFAULT_REASONING_LIMITS } from "../src/domain/reasoning.js";
import { parseConductorOutput, shouldInvokeConductor } from "../src/reasoning/conductor.js";

const valid = {
  depth: "balanced",
  strategy: "causal-investigation",
  roles: [
    { role: "investigator", requirement: "required" },
    { role: "skeptic", requirement: "conditional" },
    { role: "verifier", requirement: "conditional" },
  ],
  modelRequirements: { investigator: { reasoning: "medium", speed: "normal", context: "medium" } },
  finalReview: "conditional",
  reasonCodes: ["causal-language"],
};

describe("Conductor policy boundary", () => {
  it("accepts a compact structured plan", () => {
    expect(parseConductorOutput(JSON.stringify(valid), "balanced", DEFAULT_REASONING_LIMITS)).toEqual(valid);
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["forbidden role", JSON.stringify({ ...valid, roles: [{ role: "planner", requirement: "required" }] })],
    ["provider endpoint", JSON.stringify({ ...valid, providerId: "arbitrary", endpoint: "https://evil.test" })],
    ["Task permissions", JSON.stringify({ ...valid, allowFileEdits: true })],
    ["budget excess", JSON.stringify({ ...valid, roles: Array.from({ length: 11 }, (_, index) => ({ role: index % 2 === 0 ? "investigator" : "judge", requirement: "required" })) })],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseConductorOutput(raw, "balanced", DEFAULT_REASONING_LIMITS)).toThrow();
  });

  it("cannot override a forced depth", () => {
    expect(() => parseConductorOutput(JSON.stringify(valid), "fast", DEFAULT_REASONING_LIMITS)).toThrow("forced analysis depth");
  });

  it("runs only for high-ambiguity model reasoning", () => {
    const base = {
      queryKind: "causal" as const,
      resolvedEntities: [], relevantFiles: [], crossModule: false,
      ambiguity: "high" as const, deterministicCoverage: "none" as const,
      requiresModelReasoning: true, signals: ["causal-language"],
    };
    expect(shouldInvokeConductor(base, "balanced")).toBe(true);
    expect(shouldInvokeConductor({ ...base, deterministicCoverage: "strong", requiresModelReasoning: false }, "fast")).toBe(false);
  });
});

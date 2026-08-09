import { describe, expect, it } from "vitest";

import { createReasoningFixtureEngine } from "./helpers/reasoning-fixture.js";

describe("Decision Validation", () => {
  it("validates an explicit factual proposal with zero model calls", async () => {
    const engine = await createReasoningFixtureEngine();
    const verdict = await engine.decide({ proposal: "bootstrapSession exists." });

    expect(verdict.status).toBe("proceed");
    expect(verdict.claims).toEqual([expect.objectContaining({ statement: "bootstrapSession exists", status: "supported", deterministic: true })]);
    expect(verdict.metrics.modelCalls).toBe(0);
    expect(verdict.implementationHandoff).toContain("Re-run first-class Review");
  });

  it("rejects a contradicted explicit assumption without model inference", async () => {
    const engine = await createReasoningFixtureEngine();
    const verdict = await engine.decide({ proposal: "missingBootstrap exists." });

    expect(verdict.status).toBe("revise");
    expect(verdict.challengedAssumptions).toContain("missingBootstrap exists");
    expect(verdict.metrics.modelCalls).toBe(0);
    expect(verdict.revisionHandoff).toContain("missingBootstrap exists");
  });

  it("routes an architectural proposal through Phase 8 adaptive reasoning", async () => {
    const engine = await createReasoningFixtureEngine();
    const verdict = await engine.decide({
      objective: "Preserve authentication after refresh.",
      proposal: [
        "Use bootstrapSession to restore persisted authentication.",
        "This will preserve login state after refresh.",
      ].join("\n"),
    });

    expect(verdict.analysis.deterministic).toBe(false);
    expect(verdict.analysis.assessment.queryKind).toBe("decision");
    expect(verdict.analysis.plan.strategy).toBe("decision-validation");
    expect(verdict.metrics.modelCalls).toBeGreaterThan(0);
    expect(verdict.status).not.toBe("invalid");
  });
});

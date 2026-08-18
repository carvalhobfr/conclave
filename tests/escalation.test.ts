import { describe, expect, it } from "vitest";

import type { ValidationChallenge, ValidationClaimResult, ValidationFinding } from "../src/domain/validation.js";
import { assessEscalation } from "../src/validation/escalation.js";

function challenge(strategy: ValidationChallenge["strategy"]): ValidationChallenge {
  return { strategy, reason: "r", evidenceIds: [], suggestedProbes: [] };
}

function finding(kind: ValidationFinding["kind"]): ValidationFinding {
  return {
    id: `f_${kind}`,
    fingerprint: `fp_${kind}`,
    kind,
    severity: "warning",
    title: "t",
    detail: "d",
    evidence: [],
    remediation: "r",
  };
}

function claim(outcome: ValidationClaimResult["outcome"]): ValidationClaimResult {
  return {
    claim: { id: "c1", statement: "s", check: { kind: "symbol-exists", symbol: "x", expectation: "present" } },
    outcome,
    explanation: "e",
    evidence: [],
  };
}

describe("escalation assessment", () => {
  it("does not recommend a model pass when only baseline was selected", () => {
    const result = assessEscalation([challenge("baseline")], [], []);
    expect(result.recommended).toBe(false);
    expect(result.dimensions).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it("marks a dimension evidenced when its matching finding is present", () => {
    const result = assessEscalation(
      [challenge("baseline"), challenge("data-integrity")],
      [finding("inconsistent-key")],
      [],
    );
    expect(result.recommended).toBe(false);
    expect(result.dimensions).toEqual([
      { dimension: "data-integrity", coverage: "evidenced", reason: expect.stringContaining("produced a deterministic finding") as unknown },
    ]);
  });

  it("marks a dimension checked-clean when it has a check but no finding fired", () => {
    const result = assessEscalation([challenge("baseline"), challenge("lifecycle-state")], [], []);
    expect(result.recommended).toBe(false);
    expect(result.dimensions[0]?.coverage).toBe("checked-clean");
  });

  it("recommends escalation for a dimension with no deterministic check at all", () => {
    const result = assessEscalation([challenge("baseline"), challenge("security")], [], []);
    expect(result.recommended).toBe(true);
    expect(result.dimensions).toEqual([
      { dimension: "security", coverage: "unchecked", reason: expect.stringContaining("no deterministic check covers that class") as unknown },
    ]);
    expect(result.reasons).toHaveLength(1);
  });

  it("recommends escalation when source could not be mapped onto any symbol", () => {
    const result = assessEscalation([challenge("baseline")], [finding("claim-inconclusive")], []);
    expect(result.recommended).toBe(true);
    expect(result.reasons[0]).toContain("could not be mapped onto an indexed symbol");
  });

  it("counts unresolved completion claims instead of the generic reason once claims exist", () => {
    const result = assessEscalation(
      [challenge("baseline")],
      [finding("claim-inconclusive")],
      [claim("inconclusive"), claim("supported")],
    );
    expect(result.reasons[0]).toBe("1 completion claim(s) could not be settled deterministically.");
  });

  it("combines an unchecked dimension with an inconclusive-claim reason", () => {
    const result = assessEscalation(
      [challenge("baseline"), challenge("security")],
      [finding("claim-inconclusive")],
      [claim("inconclusive")],
    );
    expect(result.recommended).toBe(true);
    expect(result.reasons).toHaveLength(2);
  });
});

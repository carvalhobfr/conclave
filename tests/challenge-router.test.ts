import { describe, expect, it } from "vitest";

import type { IndexedCodeUnit } from "../src/domain/code-index.js";
import type { ChangeSet, ValidationContract, ValidationFinding } from "../src/domain/validation.js";
import { createChallengePlan } from "../src/validation/challenge-router.js";

function unit(overrides: Partial<IndexedCodeUnit> = {}): IndexedCodeUnit {
  return {
    id: "unit-1",
    sourceIdentity: "identity-1",
    path: "src/module.ts",
    language: "typescript",
    symbol: "doWork",
    symbolKind: "function",
    startLine: 1,
    endLine: 10,
    references: [],
    calls: [],
    heritage: [],
    exported: false,
    async: false,
    lexical: { terms: {}, length: 0 },
    embeddingKey: "key-1",
    ...overrides,
  };
}

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    source: { kind: "working" },
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    files: [{ path: "src/module.ts", status: "modified", hunks: [] }],
    patch: "bounded test patch",
    collectedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function contract(objective: string): ValidationContract {
  return { objective, claims: [], allowedPathPrefixes: [] };
}

function finding(id: string, kind: ValidationFinding["kind"]): ValidationFinding {
  return {
    id,
    fingerprint: `fingerprint_${id}`,
    kind,
    severity: "warning",
    title: "title",
    detail: "detail",
    evidence: [],
    remediation: "remediation",
  };
}

function strategies(plan: readonly { readonly strategy: string }[]): readonly string[] {
  return plan.map((challenge) => challenge.strategy);
}

describe("challenge router", () => {
  it("always keeps the baseline challenge first, even with no risk signal", () => {
    const plan = createChallengePlan(changeSet(), contract("Rename a local helper"), [], new Set(), []);
    expect(strategies(plan)).toEqual(["baseline"]);
    expect(plan[0]?.suggestedProbes).toHaveLength(1);
  });

  it("attaches the highest-severity finding ids to the baseline challenge", () => {
    const findings = Array.from({ length: 12 }, (_, index) => finding(`f${String(index)}`, "impact-outside-diff"));
    const plan = createChallengePlan(changeSet(), contract("Objective"), [], new Set(), findings);
    expect(plan[0]?.evidenceIds).toHaveLength(8);
  });

  it("selects a security challenge from the objective wording alone", () => {
    const plan = createChallengePlan(
      changeSet(),
      contract("Rotate the session token on privilege change"),
      [],
      new Set(),
      [],
    );
    expect(strategies(plan)).toContain("security");
  });

  it("reads risk signals out of the patch text, not only the objective", () => {
    const plan = createChallengePlan(
      changeSet({ patch: "+ ALTER TABLE refunds ADD COLUMN settled_at" }),
      contract("Objective without signal words"),
      [],
      new Set(),
      [],
    );
    expect(strategies(plan)).toContain("data-integrity");
  });

  it("ignores Git's own diff header vocabulary when reading risk signals", () => {
    // Every modified-file diff carries an "index <hash>..<hash> <mode>" header line from Git
    // itself; without filtering it, "index" alone would trip the performance dimension on
    // every single changed file, regardless of what the change actually does.
    const patch = [
      "diff --git a/src/math.ts b/src/math.ts",
      "index 16083fc..f90aae3 100644",
      "--- a/src/math.ts",
      "+++ b/src/math.ts",
      "@@ -1 +1 @@",
      "-function helper(a: number): number {",
      "+function increment(a: number): number {",
    ].join("\n");
    const plan = createChallengePlan(
      changeSet({ patch }),
      contract("Rename a local helper"),
      [],
      new Set(),
      [],
    );
    expect(strategies(plan)).toEqual(["baseline"]);
  });

  it("still reads a real performance keyword out of the changed lines themselves", () => {
    const patch = [
      "diff --git a/src/agg.ts b/src/agg.ts",
      "index 16083fc..f90aae3 100644",
      "--- a/src/agg.ts",
      "+++ b/src/agg.ts",
      "@@ -1 +1 @@",
      "-export function total() { return 0; }",
      "+export function total() { const cache = new Map(); return 0; }",
    ].join("\n");
    const plan = createChallengePlan(
      changeSet({ patch }),
      contract("Speed up the aggregate"),
      [],
      new Set(),
      [],
    );
    expect(strategies(plan)).toContain("performance");
  });

  it("raises public-api-compatibility only when a changed unit is exported", () => {
    const internal = createChallengePlan(changeSet(), contract("Objective"), [unit()], new Set(), []);
    expect(strategies(internal)).not.toContain("public-api-compatibility");

    const exported = createChallengePlan(
      changeSet(),
      contract("Objective"),
      [unit({ exported: true })],
      new Set(),
      [],
    );
    expect(strategies(exported)).toContain("public-api-compatibility");
  });

  it("raises blast-radius only once the graph reaches three unchanged files", () => {
    const belowThreshold = createChallengePlan(
      changeSet(),
      contract("Objective"),
      [],
      new Set(["src/module.ts", "src/a.ts", "src/b.ts"]),
      [],
    );
    expect(strategies(belowThreshold)).not.toContain("blast-radius");

    const atThreshold = createChallengePlan(
      changeSet(),
      contract("Objective"),
      [],
      new Set(["src/module.ts", "src/a.ts", "src/b.ts", "src/c.ts"]),
      [],
    );
    expect(strategies(atThreshold)).toContain("blast-radius");
  });

  it("carries the originating finding ids into the test-gap challenge", () => {
    const plan = createChallengePlan(
      changeSet(),
      contract("Objective"),
      [],
      new Set(),
      [finding("gap-1", "exported-change-without-tests")],
    );
    const testGap = plan.find((challenge) => challenge.strategy === "test-gap");
    expect(testGap?.evidenceIds).toEqual(["gap-1"]);
  });

  it("keeps a defect-class probe when a process finding outranks it", () => {
    const plan = createChallengePlan(
      changeSet({ patch: "session token listener event async retry migration schema" }),
      contract("Objective"),
      [unit({ exported: true })],
      new Set(),
      [finding("gap-1", "exported-change-without-tests")],
    );
    // test-gap outranks lifecycle-state, but it describes how the change was made rather
    // than a class of defect, so it must not take the probe's slot.
    expect(strategies(plan)).toContain("test-gap");
    expect(strategies(plan)).toContain("lifecycle-state");
  });

  it("budgets defect probes and process signals separately, ordered by priority", () => {
    const plan = createChallengePlan(
      // Deliberately trips security, data-integrity, lifecycle-state, performance, and ux.
      changeSet({ patch: "session token migration schema async retry cache latency render aria dialog" }),
      contract("Objective"),
      [unit({ exported: true })],
      new Set(["src/module.ts", "src/a.ts", "src/b.ts", "src/c.ts"]),
      [finding("gap-1", "exported-change-without-tests")],
    );
    // Three defect probes and two process signals, then baseline first and the rest by priority.
    expect(strategies(plan)).toEqual([
      "baseline",
      "security",
      "test-gap",
      "data-integrity",
      "lifecycle-state",
      "blast-radius",
    ]);
  });
});

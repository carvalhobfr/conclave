import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import type { GenerateRequest, GenerateResponse } from "../src/domain/provider.js";
import { FakeProvider } from "../src/providers/fake-provider.js";
import { createReasoningFixtureEngine, reasoningFixtureProvider } from "./helpers/reasoning-fixture.js";

function systemPrompt(request: GenerateRequest): string {
  return request.messages.find((message) => message.role === "system")?.content ?? "";
}

function response(request: GenerateRequest, value: object): GenerateResponse {
  return { provider: "fake", model: request.model, text: JSON.stringify(value) };
}

describe("adaptive Review consumer", () => {
  it("returns a valid deterministic ReviewVerdict with zero model calls", async () => {
    const provider = reasoningFixtureProvider();
    const engine = await createReasoningFixtureEngine(provider);
    const snapshots: string[] = [];

    const verdict = await engine.review({
      unifiedDiff: [
        "diff --git a/docs/review.md b/docs/review.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/docs/review.md",
        "@@ -0,0 +1,2 @@",
        "+# Review behavior",
        "+Review reuses Project Knowledge and adaptive orchestration.",
      ].join("\n"),
    }, { onSnapshot: (snapshot) => snapshots.push(snapshot.status) });

    expect(verdict.status).toBe("approved");
    expect(verdict.metrics.modelCalls).toBe(0);
    expect(verdict.analysis.route).toBe("project-knowledge");
    expect(verdict.analysis.deterministic).toBe(true);
    expect(verdict.analysis.plan.strategy).toBe("deterministic");
    expect(verdict.changedFiles).toEqual([
      expect.objectContaining({ path: "docs/review.md", changeType: "added", additions: 2 }),
    ]);
    expect(provider.requests).toHaveLength(0);
    expect(snapshots).toEqual(["complete"]);
  });

  it("does not approve when ChangeSet scope and indexed target state diverge", async () => {
    const engine = await createReasoningFixtureEngine();
    const unifiedDiff = [
      "diff --git a/docs/review.md b/docs/review.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/review.md",
      "@@ -0,0 +1,1 @@",
      "+Review behavior",
    ].join("\n");
    const verdict = await engine.review({
      unifiedDiff,
      changeSet: {
        id: "changeset_drift",
        repositoryRoot: "/fixture",
        source: { kind: "staged" },
        unifiedDiff,
        createdAt: "2026-08-09T00:00:00.000Z",
        excludedSensitivePaths: [],
        limitations: ["The opened working tree differs from the staged snapshot."],
      },
    });

    expect(verdict.status).toBe("uncertain");
    expect(verdict.uncertainty[0]).toEqual(expect.objectContaining({ reason: "incomplete-diff" }));
    expect(verdict.metrics.modelCalls).toBe(0);
  });

  it("blocks an objective merge-conflict defect without model inference", async () => {
    const provider = reasoningFixtureProvider();
    const engine = await createReasoningFixtureEngine(provider);

    const verdict = await engine.review({
      unifiedDiff: [
        "diff --git a/src/auth/storage.ts b/src/auth/storage.ts",
        "--- a/src/auth/storage.ts",
        "+++ b/src/auth/storage.ts",
        "@@ -1,1 +1,2 @@",
        "+<<<<<<< HEAD",
        " let token: string | null = null;",
      ].join("\n"),
    });

    expect(verdict.status).toBe("changes-requested");
    expect(verdict.findings).toEqual([
      expect.objectContaining({ category: "merge-conflict", deterministic: true, severity: "blocking" }),
    ]);
    expect(verdict.metrics.modelCalls).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("does not approve an empty or malformed diff", async () => {
    const provider = reasoningFixtureProvider();
    const engine = await createReasoningFixtureEngine(provider);

    const empty = await engine.review({ unifiedDiff: "" });
    const malformed = await engine.review({ unifiedDiff: "this is not a unified diff" });
    const incomplete = await engine.review({ unifiedDiff: "diff --git a/src/empty.ts b/src/empty.ts" });

    expect(empty.status).toBe("nothing-to-review");
    expect(empty.summary).toMatch(/no substantive diff/i);
    expect(malformed.status).toBe("invalid");
    expect(incomplete.status).toBe("invalid");
    expect(malformed.findings[0]).toEqual(expect.objectContaining({ category: "invalid-diff", severity: "warning" }));
    expect(provider.requests).toHaveLength(0);
  });

  it("redacts deterministic secret findings everywhere in the verdict", async () => {
    const provider = reasoningFixtureProvider();
    const engine = await createReasoningFixtureEngine(provider);
    const credential = "sk-live-abcdefghijklmnop";

    const verdict = await engine.review({
      unifiedDiff: [
        "diff --git a/src/config.ts b/src/config.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/config.ts",
        "@@ -0,0 +1,1 @@",
        `+export const credential = "${credential}";`,
      ].join("\n"),
    });

    expect(verdict.status).toBe("changes-requested");
    expect(verdict.findings[0]).toEqual(expect.objectContaining({ category: "secret-exposure", secretType: "provider-token" }));
    expect(JSON.stringify(verdict)).not.toContain(credential);
    expect(provider.requests).toHaveLength(0);

    const assignedCredential = "account-secret-728194837465";
    const assigned = await engine.review({ unifiedDiff: [
      "diff --git a/src/config.ts b/src/config.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/config.ts",
      "@@ -0,0 +1,1 @@",
      `+export const clientSecret = "${assignedCredential}";`,
    ].join("\n") });
    expect(assigned.findings[0]).toEqual(expect.objectContaining({ secretType: "credential-assignment" }));
    expect(JSON.stringify(assigned)).not.toContain(assignedCredential);
  });

  it("approves a positive type-only code ChangeSet from real structural evidence with zero model calls", async () => {
    const provider = reasoningFixtureProvider();
    const engine = await createReasoningFixtureEngine(provider, 10, resolve("tests/fixtures/review-positive"));
    const verdict = await engine.review({
      objective: "Add a compile-time validation result contract.",
      unifiedDiff: [
        "diff --git a/src/contracts.ts b/src/contracts.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/contracts.ts",
        "@@ -0,0 +1,6 @@",
        "+export interface ValidationSummary {",
        "+  readonly status: \"approved\" | \"uncertain\";",
        "+  readonly findingCount: number;",
        "+}",
        "+",
        "+export type ValidationMode = \"deterministic\" | \"adaptive\";",
      ].join("\n"),
    });

    expect(verdict.status).toBe("approved");
    expect(verdict.metrics.modelCalls).toBe(0);
    expect(verdict.findings).toHaveLength(0);
    expect(verdict.impact.changedSymbols.map((symbol) => symbol.symbol)).toEqual(["ValidationSummary", "ValidationMode"]);
    expect(verdict.confirmedProperties.map((property) => property.statement).join(" ")).toMatch(/type declarations.*no runtime graph/i);
    expect(provider.requests).toHaveLength(0);
  });

  it("routes semantic source review through the existing adaptive roles", async () => {
    const provider = new FakeProvider((request) => {
      expect(systemPrompt(request)).toContain("You are the Investigator");
      expect(systemPrompt(request)).not.toContain("You are the Reviewer");
      const evidenceId = /evidence_[a-f0-9]{24}/u.exec(request.messages.at(-1)?.content ?? "")?.[0];
      if (evidenceId === undefined) throw new Error("review fixture returned no indexed evidence");
      return response(request, {
        summary: "The changed storage behavior has an evidence-grounded regression.",
        claims: [{
          statement: "The changed token storage remains process-local and is lost on refresh.",
          evidenceIds: [evidenceId],
          uncertainty: "none",
          check: { kind: "text", text: "let token", expectation: "present" },
        }],
        retrievalRequests: [],
      });
    });
    const engine = await createReasoningFixtureEngine(provider);

    const verdict = await engine.review({
      objective: "Preserve login state.",
      unifiedDiff: [
        "diff --git a/src/auth/storage.ts b/src/auth/storage.ts",
        "--- a/src/auth/storage.ts",
        "+++ b/src/auth/storage.ts",
        "@@ -1,1 +1,1 @@",
        "-let token: string | null = null;",
        "+let token: string | null = null;",
      ].join("\n"),
    }, { depth: "fast" });

    expect(verdict.status).toBe("changes-requested");
    expect(verdict.analysis.route).toBe("adaptive-orchestration");
    expect(verdict.analysis.assessment.queryKind).toBe("review");
    expect(verdict.analysis.plan.strategy).toBe("diff-review");
    expect(verdict.metrics.modelCalls).toBe(1);
    expect(verdict.findings[0]).toEqual(expect.objectContaining({ deterministic: false, severity: "blocking" }));
    expect(provider.requests).toHaveLength(1);
  });

  it("approves a legitimate simple code choice when adaptive review finds no concrete consequence", async () => {
    const provider = new FakeProvider((request) => response(request, {
      summary: "No concrete repository defect is supported by the bounded evidence.",
      claims: [],
      retrievalRequests: [],
    }));
    const engine = await createReasoningFixtureEngine(provider);
    const verdict = await engine.review({
      objective: "Normalize the persisted token before storing it.",
      unifiedDiff: [
        "diff --git a/src/auth/storage.ts b/src/auth/storage.ts",
        "--- a/src/auth/storage.ts",
        "+++ b/src/auth/storage.ts",
        "@@ -4,1 +4,1 @@",
        "-  token = nextToken;",
        "+  token = nextToken.trim();",
      ].join("\n"),
    }, { depth: "fast" });

    expect(verdict.status).toBe("approved");
    expect(verdict.findings).toHaveLength(0);
    expect(verdict.metrics.modelCalls).toBe(1);
    expect(JSON.stringify(verdict)).not.toMatch(/\b(?:DRY|KISS|SOLID)\b/u);
  });
});

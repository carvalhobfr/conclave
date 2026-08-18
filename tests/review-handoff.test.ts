import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { createReviewHandoff } from "../src/domain/review-handoff.js";
import type { ChangeSet, ValidationReport } from "../src/domain/validation.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { SuperValidator } from "../src/validation/super-validator.js";

const changeSet: ChangeSet = {
  source: { kind: "working" },
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  files: [{ path: "src/storage.ts", status: "modified", hunks: [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 }] }],
  patch: "bounded test patch",
  collectedAt: "2026-08-11T00:00:00.000Z",
};

/** A real SuperValidator report, so the handoff is exercised against production output. */
let report: ValidationReport;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "conclave-handoff-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "storage.ts"),
    "export function persistToken(token: string) {\n  localStorage.setItem(\"token\", token);\n}\n",
  );
  await writeFile(
    join(root, "src", "flow.ts"),
    "import { persistToken } from \"./storage\";\nexport function authenticate(token: string) {\n  persistToken(token);\n}\n",
  );
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider: new LocalHashEmbeddingProvider(),
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  report = new SuperValidator().validate(indexed.index, changeSet, {
    objective: "Keep token persistence safe",
    claims: [],
    allowedPathPrefixes: [],
  });
});

describe("review handoff", () => {
  it("asks for corrections when the real report carries a warning", () => {
    const handoff = createReviewHandoff(report);
    expect(handoff.needsWork).toBe(true);
    expect(handoff.title).toBe("Correction handoff");
    expect(handoff.prompt).toContain("Address the Conclave review findings below.");
    expect(handoff.prompt).toContain("Objective: Keep token persistence safe");
    expect(handoff.prompt).toContain("Comparison: working");
    expect(handoff.prompt).toContain(`Review series: ${report.lineage.seriesId}`);
  });

  it("always closes with the read-only boundary the product promises", () => {
    expect(createReviewHandoff(report).prompt).toContain(
      "Do not commit, push, or merge unless the user explicitly asks.",
    );
  });

  it("switches to a human review handoff when nothing needs work", () => {
    const clean: ValidationReport = { ...report, verdict: "pass", findings: [] };
    const handoff = createReviewHandoff(clean);
    expect(handoff.needsWork).toBe(false);
    expect(handoff.title).toBe("Human review handoff");
    expect(handoff.prompt).toContain("No deterministic blocker or warning was found.");
  });

  it("treats an info-only report as work-free but still reports the verdict", () => {
    const infoOnly: ValidationReport = {
      ...report,
      verdict: "pass",
      findings: report.findings.map((finding) => ({ ...finding, severity: "info" as const })),
    };
    const handoff = createReviewHandoff(infoOnly);
    expect(handoff.needsWork).toBe(false);
    expect(handoff.prompt).toContain("Verdict: PASS");
  });

  it("leads with the rebaseline warning when the contract drifted", () => {
    const drifted: ValidationReport = {
      ...report,
      lineage: { ...report.lineage, rebaselineRequired: true },
    };
    expect(createReviewHandoff(drifted).prompt).toContain("REBASELINE REQUIRED");
    expect(createReviewHandoff(report).prompt).not.toContain("REBASELINE REQUIRED");
  });

  it("caps the rendered findings and says how many were withheld", () => {
    const first = report.findings[0];
    if (first === undefined) throw new Error("Expected the fixture report to carry a finding");
    const many: ValidationReport = {
      ...report,
      findings: Array.from({ length: 11 }, (_, index) => ({
        ...first,
        id: `finding-${String(index)}`,
        severity: "warning" as const,
      })),
    };
    const prompt = createReviewHandoff(many).prompt;
    expect(prompt).toContain("3 additional findings remain in the full report.");
  });

  it("calls out stagnating findings so the agent stops repeating a patch strategy", () => {
    const stagnating: ValidationReport = {
      ...report,
      findingLifecycle: { ...report.findingLifecycle, stagnating: ["fingerprint_a", "fingerprint_b"] },
    };
    expect(createReviewHandoff(stagnating).prompt).toContain(
      "Stagnation: 2 finding(s) survived repeated changed artifacts.",
    );
  });

  it("renders the non-baseline challenge plan as concrete probes", () => {
    const withPlan: ValidationReport = {
      ...report,
      challengePlan: [
        { strategy: "baseline", reason: "baseline reason", evidenceIds: [], suggestedProbes: ["baseline probe"] },
        { strategy: "security", reason: "touches sessions", evidenceIds: [], suggestedProbes: ["Exercise unauthorized paths."] },
      ],
    };
    const prompt = createReviewHandoff(withPlan).prompt;
    expect(prompt).toContain("Suggested independent challenges:");
    expect(prompt).toContain("- security: touches sessions");
    expect(prompt).toContain("  - Exercise unauthorized paths.");
    expect(prompt).not.toContain("baseline probe");
  });
});

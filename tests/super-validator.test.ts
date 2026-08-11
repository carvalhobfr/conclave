import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import type {
  ChangeSet,
  ValidationContract,
} from "../src/domain/validation.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { SuperValidator } from "../src/validation/super-validator.js";

async function validationFixture() {
  const root = await mkdtemp(join(tmpdir(), "conclave-validation-"));
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "src", "storage.ts"),
      [
        "export function persistToken(token: string) {",
        "  localStorage.setItem(\"token\", token);",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "src", "flow.ts"),
      [
        "import { persistToken } from \"./storage\";",
        "export function authenticate(token: string) {",
        "  persistToken(token);",
        "}",
        "",
      ].join("\n"),
    ),
  ]);
  const embeddingProvider = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  return indexed.index;
}

function changeSet(paths: readonly string[] = ["src/storage.ts"]): ChangeSet {
  return {
    source: { kind: "working" },
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    files: paths.map((path) => ({
      path,
      status: "modified" as const,
      hunks: [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 }],
    })),
    patch: "bounded test patch",
    collectedAt: "2026-08-11T00:00:00.000Z",
  };
}

function contract(overrides: Partial<ValidationContract> = {}): ValidationContract {
  return {
    objective: "Change token persistence safely",
    claims: [],
    allowedPathPrefixes: [],
    ...overrides,
  };
}

describe("SuperValidator", () => {
  it("uses graph impact to surface unchanged callers outside the diff", async () => {
    const report = new SuperValidator({ impactDepth: 3 }).validate(
      await validationFixture(),
      changeSet(),
      contract(),
    );

    expect(report.verdict).toBe("warn");
    expect(report.findings.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["impact-outside-diff", "exported-change-without-tests"]),
    );
    expect(report.impact.impactedFiles).toContain("src/flow.ts");
    expect(report.impact.changedSymbols).toContain("persistToken");
  });

  it("blocks a completion claim contradicted by deterministic graph evidence", async () => {
    const report = new SuperValidator({ impactDepth: 3 }).validate(
      await validationFixture(),
      changeSet(),
      contract({
        claims: [{
          id: "no-callers",
          statement: "persistToken has no remaining callers.",
          check: {
            kind: "callers",
            symbol: "persistToken",
            expectation: "absent",
          },
        }],
      }),
    );

    expect(report.verdict).toBe("block");
    expect(report.claims[0]?.outcome).toBe("rejected");
    expect(report.findings.some((item) => item.kind === "claim-contradicted")).toBe(true);
  });

  it("blocks files outside an explicit validation scope", async () => {
    const report = new SuperValidator().validate(
      await validationFixture(),
      changeSet(["src/storage.ts", "src/flow.ts"]),
      contract({ allowedPathPrefixes: ["src/storage.ts"] }),
    );

    expect(report.verdict).toBe("block");
    expect(report.findings.find((item) => item.kind === "scope-expansion")?.evidence).toEqual([
      expect.objectContaining({ path: "src/flow.ts" }),
    ]);
  });
});

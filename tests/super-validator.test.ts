import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { MultiLanguageCodeParser } from "../src/code-intelligence/multi-language-parser.js";
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

async function ambiguousSymbolFixture() {
  const root = await mkdtemp(join(tmpdir(), "conclave-validation-ambiguous-"));
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "src", "left.ts"), "export function duplicate() { return \"left\"; }\n"),
    writeFile(join(root, "src", "right.ts"), "export function duplicate() { return \"right\"; }\n"),
    writeFile(
      join(root, "src", "consumer.ts"),
      'import { duplicate } from "./left";\nexport function consume() { return duplicate(); }\n',
    ),
  ]);
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider: new LocalHashEmbeddingProvider(),
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
  it.each([
    ["python", "src/service.py", "def public_service():\n    return True\n", "tests/test_service.py"],
    ["java", "src/main/java/Service.java", "public class Service { public boolean run() { return true; } }\n", "src/test/java/ServiceTest.java"],
  ] as const)("recognizes %s production and test files", async (_language, sourcePath, source, testPath) => {
    const root = await mkdtemp(join(tmpdir(), "conclave-multilanguage-validation-"));
    await mkdir(join(root, sourcePath, ".."), { recursive: true });
    await mkdir(join(root, testPath, ".."), { recursive: true });
    await writeFile(join(root, sourcePath), source);
    await writeFile(join(root, testPath), source);
    const indexed = await new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new MultiLanguageCodeParser(),
      embeddingProvider: new LocalHashEmbeddingProvider(),
      indexStore: new InMemoryCodeIndexStore(),
    }).index(root);
    const report = new SuperValidator().validate(indexed.index, changeSet([sourcePath, testPath]), contract());
    expect(report.findings.some((finding) => finding.kind === "exported-change-without-tests")).toBe(false);
    expect(report.impact.changedSymbols.length).toBeGreaterThan(0);
  });
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
    expect(report.metrics.symbolsChanged).toBe(report.impact.changedSymbols.length);
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

  it("does not treat a mixed source edit as a deletion-only change", async () => {
    const report = new SuperValidator().validate(
      await validationFixture(),
      {
        ...changeSet(),
        files: [{
          path: "src/storage.ts",
          status: "modified",
          hunks: [
            { oldStart: 1, oldCount: 1, newStart: 1, newCount: 0 },
            { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
          ],
        }],
      },
      contract(),
    );

    expect(report.findings.some((item) => item.kind === "head-only-deletion")).toBe(false);
  });

  it("keeps callers claims inconclusive when a symbol name resolves to multiple declarations", async () => {
    const report = new SuperValidator({ impactDepth: 3 }).validate(
      await ambiguousSymbolFixture(),
      changeSet(["src/left.ts"]),
      contract({
        claims: [{
          id: "duplicate-callers",
          statement: "duplicate has callers.",
          check: { kind: "callers", symbol: "duplicate", expectation: "present" },
        }],
      }),
    );

    expect(report.verdict).toBe("inconclusive");
    expect(report.claims[0]?.outcome).toBe("inconclusive");
    expect(report.claims[0]?.evidence.map((item) => item.path)).toEqual([
      "src/left.ts",
      "src/right.ts",
    ]);
  });

  it("refuses a non-deterministic embedding index instead of misreporting the trust boundary", async () => {
    const index = await validationFixture();
    const nonDeterministic = {
      ...index,
      embedding: { ...index.embedding, kind: "learned-semantic" as const },
    };

    expect(() => new SuperValidator().validate(nonDeterministic, changeSet(), contract())).toThrow(
      "requires deterministic local embeddings",
    );
  });
});

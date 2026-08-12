import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JavaCodeParser, PythonCodeParser } from "../src/code-intelligence/structured-language-parser.js";
import { MultiLanguageCodeParser } from "../src/code-intelligence/multi-language-parser.js";
import type { RepositoryFile, SourceLanguage } from "../src/domain/repository.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";

function sourceFile(relativePath: string, language: SourceLanguage, content: string): RepositoryFile {
  return {
    relativePath,
    language,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    sizeBytes: Buffer.byteLength(content),
    modifiedAt: "2026-01-01T00:00:00.000Z",
    safety: { externalTransmissionAllowed: true, findings: [] },
  };
}

describe("PythonCodeParser", () => {
  it("indexes functions, classes, imports, calls, and inheritance", () => {
    const content = `from .storage import load_token\n\nclass Session(BaseSession):\n    def restore(self):\n        return load_token()\n\ndef bootstrap():\n    return Session().restore()`;
    const parsed = new PythonCodeParser().parse(sourceFile("src/auth/session.py", "python", content));

    expect(parsed.imports).toEqual([
      expect.objectContaining({ source: ".storage", line: 1 }),
    ]);
    expect(parsed.exports.map((entry) => entry.name)).toEqual(["Session", "bootstrap"]);
    expect(parsed.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "Session", symbolKind: "class", exported: true, startLine: 3 }),
        expect.objectContaining({ symbol: "restore", symbolKind: "method", parentSymbol: "Session", startLine: 4 }),
        expect.objectContaining({ symbol: "bootstrap", symbolKind: "function", exported: true, startLine: 7 }),
      ]),
    );
    expect(parsed.units.find((unit) => unit.symbol === "Session")?.heritage).toEqual([
      { name: "BaseSession", relation: "extends", line: 3 },
    ]);
    expect(parsed.units.find((unit) => unit.symbol === "restore")?.calls).toContainEqual({ name: "load_token", line: 5 });
  });
});

describe("JavaCodeParser", () => {
  it("indexes public classes, methods, imports, and Java heritage", () => {
    const content = `package demo.auth;\n\nimport demo.store.TokenStore;\n\npublic class Session extends BaseSession implements Restorable {\n    public String restore() {\n        return TokenStore.load();\n    }\n}`;
    const parsed = new JavaCodeParser().parse(sourceFile("src/demo/auth/Session.java", "java", content));

    expect(parsed.imports).toEqual([
      expect.objectContaining({ source: "demo.store.TokenStore", line: 3 }),
    ]);
    expect(parsed.exports.map((entry) => entry.name)).toEqual(["Session", "restore"]);
    expect(parsed.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "Session", symbolKind: "class", exported: true, startLine: 5 }),
        expect.objectContaining({ symbol: "restore", symbolKind: "method", parentSymbol: "Session", exported: true, startLine: 6 }),
      ]),
    );
    expect(parsed.units.find((unit) => unit.symbol === "Session")?.heritage).toEqual([
      { name: "BaseSession", relation: "extends", line: 5 },
      { name: "Restorable", relation: "implements", line: 5 },
    ]);
    expect(parsed.units.find((unit) => unit.symbol === "restore")?.calls).toContainEqual({ name: "load", line: 7 });
  });
});

describe("MultiLanguageCodeParser", () => {
  it("routes TypeScript, Python, and Java while leaving other files unsupported", () => {
    const parser = new MultiLanguageCodeParser();
    expect(parser.supports("typescript")).toBe(true);
    expect(parser.supports("python")).toBe(true);
    expect(parser.supports("java")).toBe(true);
    expect(parser.supports("markdown")).toBe(false);
    expect(parser.parse(sourceFile("main.py", "python", "def main():\n    return True")).parserId).toContain("python-structural-v1");
  });

  it("resolves Python relative and Java package imports in the graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-language-"));
    await mkdir(join(root, "src", "auth"), { recursive: true });
    await mkdir(join(root, "demo", "auth"), { recursive: true });
    await mkdir(join(root, "demo", "store"), { recursive: true });
    await writeFile(join(root, "src", "auth", "session.py"), "from .storage import load_token\n\ndef restore():\n    return load_token()\n");
    await writeFile(join(root, "src", "auth", "storage.py"), "def load_token():\n    return None\n");
    await writeFile(join(root, "demo", "auth", "Session.java"), "package demo.auth;\nimport demo.store.TokenStore;\npublic class Session {\n  public String restore() { return TokenStore.load(); }\n}\n");
    await writeFile(join(root, "demo", "store", "TokenStore.java"), "package demo.store;\npublic class TokenStore {\n  public static String load() { return \"token\"; }\n}\n");

    const indexed = await new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new MultiLanguageCodeParser(),
      embeddingProvider: new LocalHashEmbeddingProvider(),
      indexStore: new InMemoryCodeIndexStore(),
    }).index(root);
    const imports = indexed.index.graphEdges.filter((edge) => edge.relation === "imports-file");
    expect(imports.map((edge) => `${edge.from.id}->${edge.to.id}`)).toEqual(
      expect.arrayContaining([
        "src/auth/session.py->src/auth/storage.py",
        "demo/auth/Session.java->demo/store/TokenStore.java",
      ]),
    );
  });
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { CodeGraph } from "../src/graph/code-graph.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { CodeRetrievalService } from "../src/retrieval/code-retrieval-service.js";

async function graphFixture() {
  const root = await mkdtemp(join(tmpdir(), "conclave-graph-"));
  await mkdir(join(root, "src", "auth"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "src", "auth", "storage.ts"),
      `export function getStoredToken() {
  return localStorage.getItem("token");
}
`,
    ),
    writeFile(
      join(root, "src", "auth", "AuthProvider.tsx"),
      `import React from "react";
import { getStoredToken } from "./storage";
export class SessionController {
  bootstrapSession() {
    return getStoredToken();
  }
}
`,
    ),
  ]);
  const embeddingProvider = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  return { index: indexed.index, embeddingProvider };
}

describe("deterministic code graph", () => {
  it("derives only resolved import, ownership, containment, reference, and direct-call edges", async () => {
    const { index } = await graphFixture();
    const relations = index.graphEdges.map((edge) => edge.relation);

    expect(relations).toEqual(
      expect.arrayContaining([
        "belongs-to-file",
        "exports-symbol",
        "contains-symbol",
        "imports-file",
        "imports-symbol",
        "references-symbol",
        "calls-symbol",
      ]),
    );
    expect(
      index.graphEdges.some(
        (edge) => edge.relation === "imports-file" && edge.provenance.reason.includes("react"),
      ),
    ).toBe(false);
    expect(
      index.graphEdges.find((edge) => edge.relation === "calls-symbol")?.provenance,
    ).toEqual(
      expect.objectContaining({ path: "src/auth/AuthProvider.tsx", line: 5 }),
    );
  });

  it("bounds graph expansion depth and evidence budget with duplicate suppression", async () => {
    const { index } = await graphFixture();
    const bootstrap = Object.values(index.units).find((unit) => unit.symbol === "bootstrapSession");
    expect(bootstrap).toBeDefined();
    const graph = new CodeGraph(index);

    expect(graph.expand([bootstrap!.id], { maxDepth: 0, maxEvidence: 10 })).toEqual([]);
    const expanded = graph.expand([bootstrap!.id], { maxDepth: 2, maxEvidence: 1 });
    expect(expanded).toHaveLength(1);
    expect(new Set(expanded.map((item) => item.unit.id)).size).toBe(expanded.length);
    expect(expanded[0]?.depth).toBeLessThanOrEqual(2);
  });
});

describe("repository retrieval primitives", () => {
  it("finds references, imports, related symbols, and graph-expanded hybrid evidence", async () => {
    const { index, embeddingProvider } = await graphFixture();
    const service = new CodeRetrievalService(index, embeddingProvider);

    expect(service.findReferences("getStoredToken").map((result) => result.evidence.symbol)).toContain(
      "bootstrapSession",
    );
    expect(
      service
        .findImports("src/auth/AuthProvider.tsx")
        .map((result) => result.evidence.symbol),
    ).toContain("getStoredToken");
    expect(service.findImports("getStoredToken")[0]?.evidence.excerpt).toContain(
      "import { getStoredToken }",
    );
    expect(service.findRelated("bootstrapSession", 2, 10).map((result) => result.evidence.symbol)).toContain(
      "getStoredToken",
    );

    const search = await service.search("bootstrapSession", { limit: 5, graphDepth: 2 });
    const storedToken = search.find((result) => result.evidence.symbol === "getStoredToken");
    expect(storedToken?.signals.graph).toBeGreaterThan(0);
    expect(storedToken?.reasons.some((reason) => reason.strategy === "graph")).toBe(true);
  });
});

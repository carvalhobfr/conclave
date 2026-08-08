import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
} from "../src/domain/embedding.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { RetrievalPlanner } from "../src/retrieval/retrieval-planner.js";

class TrackingEmbeddingProvider implements EmbeddingProvider {
  readonly #delegate = new LocalHashEmbeddingProvider();
  public readonly id = this.#delegate.id;
  public readonly dimensions = this.#delegate.dimensions;
  public calls = 0;

  public embed(requests: readonly EmbeddingRequest[]): Promise<readonly EmbeddingResult[]> {
    this.calls += 1;
    return this.#delegate.embed(requests);
  }
}

async function plannerFixture() {
  const embeddingProvider = new TrackingEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(resolve("tests/fixtures/code-rag"));
  embeddingProvider.calls = 0;
  return { planner: new RetrievalPlanner(indexed.index, embeddingProvider), embeddingProvider };
}

describe("graph-first retrieval planner", () => {
  it("uses exact symbol callers and skips feature-vector retrieval when evidence is sufficient", async () => {
    const { planner, embeddingProvider } = await plannerFixture();
    const retrieval = await planner.retrieve("Where is bootstrapSession called?");

    expect(retrieval.results.map((result) => result.evidence.symbol)).toEqual(
      expect.arrayContaining(["bootstrapSession", "AuthProvider"]),
    );
    expect(retrieval.plan.deterministicEvidenceSufficient).toBe(true);
    expect(retrieval.plan.operations).toContainEqual(
      expect.objectContaining({ kind: "graph-callers", status: "executed" }),
    );
    expect(retrieval.plan.operations).toContainEqual(
      expect.objectContaining({ kind: "semantic-feature-vector", status: "skipped" }),
    );
    expect(embeddingProvider.calls).toBe(0);
  });

  it("falls back to broad retrieval when deterministic graph evidence is insufficient", async () => {
    const { planner, embeddingProvider } = await plannerFixture();
    const retrieval = await planner.retrieve("Where is persistToken called?");

    expect(retrieval.plan.operations).toContainEqual(
      expect.objectContaining({ kind: "graph-callers", status: "executed", resultCount: 0 }),
    );
    expect(retrieval.plan.operations).toContainEqual(
      expect.objectContaining({ kind: "semantic-feature-vector", status: "executed" }),
    );
    expect(embeddingProvider.calls).toBe(1);
  });

  it("uses broad lexical, feature-vector, fusion, and graph expansion for natural language", async () => {
    const { planner, embeddingProvider } = await plannerFixture();
    const retrieval = await planner.retrieve(
      "Where do we restore the user session after reopening the application?",
    );

    expect(retrieval.plan.deterministicEvidenceSufficient).toBe(false);
    expect(retrieval.plan.operations.filter((entry) => entry.status === "executed").map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["lexical", "semantic-feature-vector", "hybrid-fusion", "graph-expansion"]),
    );
    expect(retrieval.results.map((result) => result.evidence.symbol)).toContain("bootstrapSession");
    expect(embeddingProvider.calls).toBe(1);
  });

  it("plans bounded symbol paths without file-ownership shortcuts", async () => {
    const { planner, embeddingProvider } = await plannerFixture();
    const retrieval = await planner.retrieve(
      "What path connects AuthProvider to getStoredToken?",
      { budget: { graphDepth: 3 } },
    );

    expect(retrieval.plan.operations).toContainEqual(
      expect.objectContaining({ kind: "graph-shortest-path", status: "executed" }),
    );
    expect(retrieval.graphEdges.map((edge) => edge.relation)).toEqual([
      "calls-symbol",
      "calls-symbol",
    ]);
    expect(embeddingProvider.calls).toBe(0);
  });

  it("uses exact paths as deterministic graph entities", async () => {
    const { planner, embeddingProvider } = await plannerFixture();
    const retrieval = await planner.retrieve("What does src/auth/AuthProvider.tsx import?");

    expect(retrieval.plan.operations).toContainEqual(
      expect.objectContaining({ kind: "exact-path", status: "executed" }),
    );
    expect(retrieval.plan.operations).toContainEqual(
      expect.objectContaining({ kind: "graph-imports", status: "executed" }),
    );
    expect(retrieval.graphEdges.map((edge) => edge.relation)).toEqual(
      expect.arrayContaining(["imports-file", "imports-symbol"]),
    );
    expect(embeddingProvider.calls).toBe(0);
  });
});

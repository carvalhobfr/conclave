import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { CodeRetrievalService } from "../src/retrieval/code-retrieval-service.js";

async function knowledge() {
  const embedding = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider: embedding,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(resolve("tests/fixtures/reasoning-auth"));
  return new CodeRetrievalService(indexed.index, embedding).knowledge;
}

describe("ProjectKnowledge", () => {
  it("formalizes the existing reusable index without duplicating it", async () => {
    const project = await knowledge();

    expect(project.repositoryId).not.toBe("");
    expect(project.stats.files).toBe(3);
    expect(project.stats.symbols).toBeGreaterThan(3);
    expect(project.stats.graphEdges).toBeGreaterThan(0);
  });

  it.each([
    ["Where is persistToken defined?", "src/auth/storage.ts"],
    ["Who calls persistToken?", "completeLogin → persistToken"],
    ["What does completeLogin call?", "completeLogin → persistToken"],
    ["Where is persistToken referenced?", "persistToken"],
    ["Which file exports persistToken?", "src/auth/storage.ts"],
    ["Path from completeLogin to persistToken?", "completeLogin → persistToken"],
  ])("answers %s from deterministic provenance", async (question, expected) => {
    const answer = (await knowledge()).answer(question);

    expect(answer?.answer).toContain(expected);
    expect(answer?.operations.length).toBeGreaterThan(0);
    expect(answer?.limitations.length).toBeGreaterThan(0);
    expect(answer?.graphEdges.every((edge) => new Set<string>(["extracted", "resolved"]).has(edge.provenance.kind))).toBe(true);
  });

  it("preserves ambiguity instead of merging same-named symbols", async () => {
    const embedding = new LocalHashEmbeddingProvider();
    const indexed = await new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(), parser: new TypeScriptCodeParser(),
      embeddingProvider: embedding, indexStore: new InMemoryCodeIndexStore(),
    }).index(resolve("tests/fixtures/code-rag"));
    const answer = new CodeRetrievalService(indexed.index, embedding).knowledge.answer("Where is restoreState defined?");

    expect(answer?.ambiguity).toBe("high");
    expect(answer?.answer).toContain("qualify it with a file path");
  });
});

import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import {
  loadEvaluationCases,
  runRetrievalEvaluation,
} from "../src/evaluation/retrieval-evaluation.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { CodeRetrievalService } from "../src/retrieval/code-retrieval-service.js";

describe("retrieval evaluation fixture", () => {
  it("reports deterministic lexical, semantic, and hybrid metrics", async () => {
    const root = resolve("tests/fixtures/code-rag");
    const embeddingProvider = new LocalHashEmbeddingProvider();
    const indexed = await new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new TypeScriptCodeParser(),
      embeddingProvider,
      indexStore: new InMemoryCodeIndexStore(),
    }).index(root);
    const cases = await loadEvaluationCases(resolve(root, "eval-cases.json"));
    const report = await runRetrievalEvaluation(
      new CodeRetrievalService(indexed.index, embeddingProvider),
      cases,
    );

    expect(report.caseCount).toBe(3);
    expect(report.strategies.map((result) => result.strategy)).toEqual([
      "lexical",
      "semantic",
      "hybrid",
    ]);
    expect(report.strategies.find((result) => result.strategy === "lexical")?.metrics).toEqual({
      fileRecallAt1: 0.3333,
      fileRecallAt3: 0.6667,
      fileRecallAt5: 0.8333,
      symbolRecallAt1: 0.3333,
      symbolRecallAt3: 0.6667,
      symbolRecallAt5: 0.6667,
      meanReciprocalRank: 0.5,
    });
    expect(report.strategies.find((result) => result.strategy === "semantic")?.metrics).toEqual({
      fileRecallAt1: 0.3333,
      fileRecallAt3: 0.6667,
      fileRecallAt5: 1,
      symbolRecallAt1: 0.1667,
      symbolRecallAt3: 0.6667,
      symbolRecallAt5: 1,
      meanReciprocalRank: 0.5556,
    });
    expect(report.strategies.find((result) => result.strategy === "hybrid")?.metrics).toEqual({
      fileRecallAt1: 0.6667,
      fileRecallAt3: 0.8333,
      fileRecallAt5: 0.8333,
      symbolRecallAt1: 0.5,
      symbolRecallAt3: 0.8333,
      symbolRecallAt5: 0.8333,
      meanReciprocalRank: 0.7778,
    });
  });
});

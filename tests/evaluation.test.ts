import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import {
  loadEvaluationCases,
  runGraphAwareRetrievalEvaluation,
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

  it("compares graph-aware strategies and context efficiency without changing Phase 2 cases", async () => {
    const root = resolve("tests/fixtures/code-rag");
    const embeddingProvider = new LocalHashEmbeddingProvider();
    const indexed = await new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new TypeScriptCodeParser(),
      embeddingProvider,
      indexStore: new InMemoryCodeIndexStore(),
    }).index(root);
    const phase2Cases = await loadEvaluationCases(resolve(root, "eval-cases.json"));
    const graphCases = await loadEvaluationCases(resolve(root, "graph-eval-cases.json"));
    const report = await runGraphAwareRetrievalEvaluation(
      new CodeRetrievalService(indexed.index, embeddingProvider),
      [...phase2Cases, ...graphCases],
    );

    expect(phase2Cases).toHaveLength(3);
    expect(report.caseCount).toBe(7);
    expect(report.embedding).toEqual({
      terminology: "deterministic-feature-hash",
      learnedSemanticModel: false,
    });
    expect(report.strategies.map((result) => result.strategy)).toEqual([
      "lexical",
      "feature-vector",
      "hybrid-no-graph",
      "graph-only",
      "graph-aware-hybrid",
    ]);
    expect(report.strategies.find((result) => result.strategy === "graph-only")?.caseCount).toBe(3);
    for (const strategy of report.strategies) {
      expect(strategy.metrics.meanEvidenceCount).toBeGreaterThanOrEqual(0);
      expect(strategy.metrics.meanSourceBytes).toBeGreaterThanOrEqual(0);
      expect(strategy.metrics.meanApproximateTokens).toBeGreaterThanOrEqual(0);
      expect(strategy.metrics.meanStrategiesExecuted).toBeGreaterThanOrEqual(1);
      expect(strategy.metrics.relevantEvidencePer1kTokens).toBeGreaterThanOrEqual(0);
    }
    expect(report.strategies.find((result) => result.strategy === "graph-only")?.metrics).toEqual({
      fileRecallAt1: 0.6667,
      fileRecallAt3: 1,
      fileRecallAt5: 1,
      symbolRecallAt1: 0.4444,
      symbolRecallAt3: 1,
      symbolRecallAt5: 1,
      meanReciprocalRank: 1,
      meanEvidenceCount: 2.3333,
      meanSourceBytes: 472.6667,
      meanApproximateTokens: 118.6667,
      meanStrategiesExecuted: 2,
      relevantEvidencePer1kTokens: 19.6629,
    });
    expect(report.strategies.find((result) => result.strategy === "graph-aware-hybrid")?.metrics).toEqual({
      fileRecallAt1: 0.6429,
      fileRecallAt3: 0.9286,
      fileRecallAt5: 0.9286,
      symbolRecallAt1: 0.4524,
      symbolRecallAt3: 0.9286,
      symbolRecallAt5: 0.9286,
      meanReciprocalRank: 0.9048,
      meanEvidenceCount: 6.2857,
      meanSourceBytes: 990.7143,
      meanApproximateTokens: 248.1429,
      meanStrategiesExecuted: 3.2857,
      relevantEvidencePer1kTokens: 8.6356,
    });
  });
});

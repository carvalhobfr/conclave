import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { DEFAULT_EVIDENCE_BUDGET } from "../src/domain/retrieval-plan.js";
import type { Evidence, RetrievalResult } from "../src/domain/evidence.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { ContextPacker, approximateTokenCount } from "../src/retrieval/context-packer.js";
import { CodeIndexReader } from "../src/retrieval/index-reader.js";

async function contextFixture() {
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider: new LocalHashEmbeddingProvider(),
    indexStore: new InMemoryCodeIndexStore(),
  }).index(resolve("tests/fixtures/code-rag"));
  return { index: indexed.index, reader: new CodeIndexReader(indexed.index) };
}

function ranked(evidence: Evidence, rank: number): RetrievalResult {
  return {
    evidence,
    rank,
    score: 1 / rank,
    signals: { graph: 1 },
    reasons: [{ strategy: "graph", detail: "test relationship" }],
  };
}

describe("deterministic context packing", () => {
  it("merges overlapping evidence while preserving source IDs and canonical source", async () => {
    const { index, reader } = await contextFixture();
    const provider = reader.findSymbol("AuthProvider")[0];
    const callLine = reader.searchText("bootstrapSession(setSession)")[0];
    if (provider === undefined || callLine === undefined) throw new Error("Fixture evidence missing");

    const bundle = new ContextPacker(index).pack(
      [ranked(provider, 1), ranked(callLine, 2), ranked(callLine, 3)],
      index.graphEdges,
      DEFAULT_EVIDENCE_BUDGET,
    );

    expect(bundle.evidence).toHaveLength(1);
    expect(bundle.evidence[0]).toEqual(
      expect.objectContaining({
        path: "src/auth/AuthProvider.tsx",
        startLine: 16,
        endLine: 24,
      }),
    );
    expect(bundle.evidence[0]?.sourceEvidenceIds).toEqual(
      expect.arrayContaining([provider.id, callLine.id]),
    );
    expect(bundle.evidence[0]?.excerpt).toBe(provider.excerpt);
    expect(bundle.stats).toEqual(
      expect.objectContaining({
        inputEvidenceCount: 3,
        selectedEvidenceCount: 2,
        packedEvidenceCount: 1,
        duplicateOrOverlappingUnitsRemoved: 2,
      }),
    );
    expect(bundle.relationships.some((edge) => edge.provenance.path === provider.path)).toBe(true);
  });

  it("enforces evidence, byte, and approximate-token budgets", async () => {
    const { index, reader } = await contextFixture();
    const bootstrap = reader.findSymbol("bootstrapSession")[0];
    const provider = reader.findSymbol("AuthProvider")[0];
    if (bootstrap === undefined || provider === undefined) throw new Error("Fixture evidence missing");
    const firstBytes = Buffer.byteLength(bootstrap.excerpt);
    const firstTokens = approximateTokenCount(firstBytes);

    const bundle = new ContextPacker(index).pack(
      [ranked(bootstrap, 1), ranked(provider, 2)],
      [],
      {
        ...DEFAULT_EVIDENCE_BUDGET,
        finalEvidence: 1,
        sourceBytes: firstBytes,
        approximateTokens: firstTokens,
      },
    );

    expect(bundle.evidence).toHaveLength(1);
    expect(bundle.evidence[0]?.symbols.map((symbol) => symbol.name)).toEqual(["bootstrapSession"]);
    expect(bundle.stats.sourceBytes).toBe(firstBytes);
    expect(bundle.stats.approximateTokens).toBe(firstTokens);
    expect(bundle.stats.truncated).toBe(true);
  });

  it("returns no source when every candidate exceeds the context budget", async () => {
    const { index, reader } = await contextFixture();
    const bootstrap = reader.findSymbol("bootstrapSession")[0];
    if (bootstrap === undefined) throw new Error("Fixture evidence missing");

    const bundle = new ContextPacker(index).pack([ranked(bootstrap, 1)], [], {
      ...DEFAULT_EVIDENCE_BUDGET,
      sourceBytes: 1,
      approximateTokens: 1,
    });

    expect(bundle.evidence).toEqual([]);
    expect(bundle.stats).toEqual(
      expect.objectContaining({ sourceBytes: 0, approximateTokens: 0, truncated: true }),
    );
  });
});

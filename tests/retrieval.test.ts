import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { searchBm25 } from "../src/retrieval/bm25.js";
import { HybridRetriever } from "../src/retrieval/hybrid-retriever.js";
import { tokenizeCode } from "../src/retrieval/tokenizer.js";

async function retrievalFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-retrieval-"));
  await mkdir(join(root, "src", "auth"), { recursive: true });
  await mkdir(join(root, "src", "metrics"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "src", "auth", "AuthProvider.tsx"),
      `import { getStoredToken } from "./storage";
export async function bootstrapSession() {
  const token = getStoredToken();
  if (!token) throw new Error("AUTH_RESTORE_FAILED");
  return { token };
}
export function AuthProvider() {
  return <main>authenticated</main>;
}
`,
    ),
    writeFile(
      join(root, "src", "auth", "storage.ts"),
      `export function getStoredToken() {
  return localStorage.getItem("auth-token");
}
export function persistToken(token: string) {
  localStorage.setItem("auth-token", token);
}
`,
    ),
    writeFile(
      join(root, "src", "metrics", "bootstrap.ts"),
      `export function bootstrapStatistics() {
  return { refreshed: true };
}
`,
    ),
  ]);
  return root;
}

async function indexedFixture() {
  const root = await retrievalFixture();
  const embeddingProvider = new LocalHashEmbeddingProvider();
  const result = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  return { index: result.index, embeddingProvider };
}

describe("code-aware lexical retrieval", () => {
  it("tokenizes identifiers and ranks exact error strings with BM25", async () => {
    expect(tokenizeCode("bootstrapSession auth-token")).toEqual(
      expect.arrayContaining(["bootstrapsession", "bootstrap", "session", "auth", "token"]),
    );
    const { index } = await indexedFixture();
    const results = searchBm25(index, "AUTH_RESTORE_FAILED");

    expect(results[0]?.unit.symbol).toBe("bootstrapSession");
    expect(results[0]?.score).toBeGreaterThan(0);
  });
});

describe("hybrid retrieval", () => {
  it("uses local semantic concepts to connect restoration language to bootstrap code", async () => {
    const { index, embeddingProvider } = await indexedFixture();
    const results = await new HybridRetriever(index, embeddingProvider).search(
      "rehydrate authentication after refresh",
      { strategy: "semantic", limit: 3 },
    );

    expect(results.slice(0, 2).map((result) => result.evidence.symbol)).toContain(
      "bootstrapSession",
    );
    expect(results[0]?.signals.semantic).toBeGreaterThan(0);
  });

  it("gives an explicit known symbol a dominant deterministic signal", async () => {
    const { index, embeddingProvider } = await indexedFixture();
    const retriever = new HybridRetriever(index, embeddingProvider);
    const first = await retriever.search("Where is bootstrapSession called?", { limit: 5 });
    const second = await retriever.search("Where is bootstrapSession called?", { limit: 5 });

    expect(first[0]?.evidence.symbol).toBe("bootstrapSession");
    expect(first[0]?.signals.exactSymbol).toBe(1);
    expect(first.map((result) => result.evidence.id)).toEqual(
      second.map((result) => result.evidence.id),
    );
  });

  it("exposes BM25, semantic, symbol, and path component signals", async () => {
    const { index, embeddingProvider } = await indexedFixture();
    const results = await new HybridRetriever(index, embeddingProvider).search(
      "auth storage getStoredToken",
      { limit: 5 },
    );
    const storedToken = results.find((result) => result.evidence.symbol === "getStoredToken");

    expect(typeof storedToken?.signals.lexical).toBe("number");
    expect(typeof storedToken?.signals.semantic).toBe("number");
    expect(storedToken?.signals.exactSymbol).toBe(1);
    expect(typeof storedToken?.signals.path).toBe("number");
    expect(storedToken?.score).toBeGreaterThan(0);
  });

  it("keeps lexical-only and semantic-only strategies distinct", async () => {
    const { index, embeddingProvider } = await indexedFixture();
    const retriever = new HybridRetriever(index, embeddingProvider);
    const lexical = await retriever.search("AUTH_RESTORE_FAILED", {
      strategy: "lexical",
      limit: 3,
    });
    const semantic = await retriever.search("authentication rehydrate", {
      strategy: "semantic",
      limit: 3,
    });

    expect(lexical[0]?.signals.lexical).toBeDefined();
    expect(lexical[0]?.signals.semantic).toBeUndefined();
    expect(semantic[0]?.signals.semantic).toBeDefined();
    expect(semantic[0]?.signals.lexical).toBeUndefined();
  });
});

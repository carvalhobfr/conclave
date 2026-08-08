import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
} from "../src/domain/embedding.js";
import {
  CODE_INDEX_DIRECTORY,
  CODE_INDEX_FILENAME,
  FileSystemCodeIndexStore,
} from "../src/indexing/file-system-index-store.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { CodeIndexReader } from "../src/retrieval/index-reader.js";

class CountingEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "counting-test-v1";
  public readonly dimensions = 4;
  public readonly batches: EmbeddingRequest[][] = [];

  public embed(requests: readonly EmbeddingRequest[]): Promise<readonly EmbeddingResult[]> {
    this.batches.push(structuredClone([...requests]));
    return Promise.resolve(
      requests.map((request, index) => ({
        identity: request.identity,
        vector: [1, index / 10, request.text.length / 1_000, 0],
      })),
    );
  }
}

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-index-"));
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(root, ".conclaveignore"), "src/ignored.ts\n"),
    writeFile(
      join(root, "src", "session.ts"),
      `export function bootstrapSession() {
  const state = "auth-restored";
  return state;
}
`,
    ),
    writeFile(join(root, "src", "old.ts"), "export const oldSymbol = () => true;\n"),
    writeFile(join(root, "src", "ignored.ts"), "export const ignored = () => true;\n"),
    writeFile(
      join(root, "src", "secret.ts"),
      'export const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";\n',
    ),
  ]);
  return root;
}

describe("RepositoryIndexer", () => {
  it("indexes safe structural source and incrementally handles unchanged, changed, new, and deleted files", async () => {
    const root = await repositoryFixture();
    const embeddingProvider = new CountingEmbeddingProvider();
    const store = new InMemoryCodeIndexStore();
    const indexer = new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new TypeScriptCodeParser(),
      embeddingProvider,
      indexStore: store,
    });

    const first = await indexer.index(root);
    expect(first.stats).toEqual(
      expect.objectContaining({
        filesAdded: 2,
        filesSkippedSecret: 1,
        filesSkippedUnsupported: 1,
        embeddingsCreated: 2,
      }),
    );
    expect(Object.keys(first.index.files)).toEqual(["src/old.ts", "src/session.ts"]);
    expect(Object.values(first.index.units).map((unit) => unit.symbol)).toEqual(
      expect.arrayContaining(["bootstrapSession", "oldSymbol"]),
    );
    expect(JSON.stringify(first.index)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");

    const second = await indexer.index(root);
    expect(second.stats).toEqual(
      expect.objectContaining({ filesUnchanged: 2, embeddingsCreated: 0, embeddingCacheHits: 2 }),
    );
    expect(embeddingProvider.batches).toHaveLength(1);

    await Promise.all([
      writeFile(
        join(root, "src", "session.ts"),
        `export function bootstrapSession() {
  const state = "auth-restored-after-refresh";
  return state;
}
`,
      ),
      writeFile(join(root, "src", "new.ts"), "export const newSymbol = () => 42;\n"),
      unlink(join(root, "src", "old.ts")),
    ]);

    const third = await indexer.index(root);
    expect(third.stats).toEqual(
      expect.objectContaining({ filesAdded: 1, filesChanged: 1, filesDeleted: 1, embeddingsCreated: 2 }),
    );
    expect(third.index.files["src/old.ts"]).toBeUndefined();
    expect(Object.values(third.index.units).map((unit) => unit.symbol)).not.toContain("oldSymbol");
    expect(Object.values(third.index.units).map((unit) => unit.symbol)).toContain("newSymbol");
  });

  it("persists and validates an owner-only index inside the ignored Conclave directory", async () => {
    const root = await repositoryFixture();
    const store = new FileSystemCodeIndexStore();
    const indexer = new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new TypeScriptCodeParser(),
      embeddingProvider: new CountingEmbeddingProvider(),
      indexStore: store,
    });
    const result = await indexer.index(root);
    const indexPath = join(root, CODE_INDEX_DIRECTORY, CODE_INDEX_FILENAME);

    expect((await stat(indexPath)).mode & 0o777).toBe(0o600);
    await expect(store.load(root)).resolves.toEqual(result.index);
    expect(await readFile(indexPath, "utf8")).not.toContain("abcdefghijklmnopqrstuvwxyz123456");

    const indexedFile = result.index.files["src/session.ts"]!;
    const unsafeSource = `${indexedFile.sourceText}\nconst apiKey = "sk-zyxwvutsrqponmlkjihgfedcba654321";`;
    const unsafeIndex = {
      ...result.index,
      files: {
        ...result.index.files,
        "src/session.ts": {
          ...indexedFile,
          sourceText: unsafeSource,
          contentHash: createHash("sha256").update(unsafeSource).digest("hex"),
        },
      },
    };
    await expect(store.save(root, unsafeIndex)).rejects.toThrow("secret-classified source");
  });

  it("forces a full rebuild when the indexing pipeline version changes", async () => {
    const root = await repositoryFixture();
    const store = new InMemoryCodeIndexStore();
    const embeddingProvider = new CountingEmbeddingProvider();
    const indexer = new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new TypeScriptCodeParser(),
      embeddingProvider,
      indexStore: store,
    });
    const first = await indexer.index(root);
    await store.save(first.index.repository.rootPath, { ...first.index, indexingVersion: 0 });

    const rebuilt = await indexer.index(root);
    expect(rebuilt.stats.filesAdded).toBe(2);
    expect(rebuilt.stats.filesUnchanged).toBe(0);
    expect(rebuilt.stats.embeddingsCreated).toBe(2);
  });
});

describe("CodeIndexReader", () => {
  it("supports exact symbol, path + symbol, exports, exact text, ranges, and stable evidence IDs", async () => {
    const root = await repositoryFixture();
    const result = await new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new TypeScriptCodeParser(),
      embeddingProvider: new CountingEmbeddingProvider(),
      indexStore: new InMemoryCodeIndexStore(),
    }).index(root);
    const reader = new CodeIndexReader(result.index);

    const symbols = reader.findSymbol("bootstrapSession", "src/session.ts");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toEqual(
      expect.objectContaining({
        path: "src/session.ts",
        startLine: 1,
        endLine: 4,
        symbol: "bootstrapSession",
      }),
    );
    expect(symbols[0]?.excerpt).toContain('const state = "auth-restored"');
    expect(reader.findSymbol("bootstrapsession")[0]?.id).toBe(symbols[0]?.id);
    expect(reader.findExportedSymbols().map((evidence) => evidence.symbol)).toContain(
      "bootstrapSession",
    );

    const textMatches = reader.searchText("auth-restored");
    expect(textMatches).toHaveLength(1);
    expect(textMatches[0]).toEqual(
      expect.objectContaining({ path: "src/session.ts", startLine: 2, endLine: 2 }),
    );
    expect(reader.readEvidence(textMatches[0]!.id)).toEqual(textMatches[0]);
    expect(reader.readFile("src/session.ts", { startLine: 2, endLine: 3 }).excerpt).toBe(
      '  const state = "auth-restored";\n  return state;',
    );
    expect(new CodeIndexReader(result.index).findSymbol("bootstrapSession")[0]?.id).toBe(
      symbols[0]?.id,
    );
  });
});

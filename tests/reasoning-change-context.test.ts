import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { MultiLanguageCodeParser } from "../src/code-intelligence/multi-language-parser.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { inferReasoningChangeContext } from "../src/reasoning/change-context.js";
import { CodeRetrievalService } from "../src/retrieval/code-retrieval-service.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Conclave Test",
      GIT_AUTHOR_EMAIL: "conclave@example.invalid",
      GIT_COMMITTER_NAME: "Conclave Test",
      GIT_COMMITTER_EMAIL: "conclave@example.invalid",
    },
  });
}

async function retrieval(root: string): Promise<CodeRetrievalService> {
  const embedding = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new MultiLanguageCodeParser(),
    embeddingProvider: embedding,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  return new CodeRetrievalService(indexed.index, embedding);
}

describe("reasoning Git change context", () => {
  it("prefers branch/worktree changes and changed symbols over an unrelated latest commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-reasoning-context-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "refund.ts"), "export function refund() {\n  return 1;\n}\n");
      await git(root, ["init", "-b", "main"]);
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "baseline"]);
      await git(root, ["switch", "-c", "feature"]);
      await writeFile(join(root, "src", "refund.ts"), "export function refund() {\n  const cents = 100;\n  return cents;\n}\n");

      const context = await inferReasoningChangeContext(root, await retrieval(root));

      expect(context).toEqual(expect.objectContaining({
        source: "workspace",
        paths: ["src/refund.ts"],
        symbols: ["refund"],
        relatedSymbols: [],
      }));
      // Agents need the changed lines themselves: a path and a symbol cannot show that a
      // literal, a condition, or a missing cleanup call is wrong.
      expect(context?.hunks).toHaveLength(1);
      expect(context?.hunks[0]?.path).toBe("src/refund.ts");
      expect(context?.hunks[0]?.patch).toContain("+  const cents = 100;");
      expect(context?.hunks[0]?.patch).not.toContain("diff --git");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the checked-out latest commit when the workspace is clean", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-reasoning-latest-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "baseline.ts"), "export const baseline = true;\n");
      await git(root, ["init", "-b", "main"]);
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "baseline"]);
      await writeFile(join(root, "src", "latest.ts"), "export function latestBehavior() { return false; }\n");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "latest behavior"]);

      const context = await inferReasoningChangeContext(root, await retrieval(root));

      expect(context).toEqual(expect.objectContaining({
        source: "latest-commit",
        paths: ["src/latest.ts"],
        symbols: ["latestBehavior"],
        relatedSymbols: [],
      }));
      expect(context?.hunks[0]?.patch).toContain("+export function latestBehavior()");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

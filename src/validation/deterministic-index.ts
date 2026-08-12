import { MultiLanguageCodeParser } from "../code-intelligence/multi-language-parser.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../indexing/repository-indexer.js";
import { LocalFolderRepository } from "../repositories/local-folder-repository.js";

/**
 * Validation never depends on configured model or learned-embedding providers. This keeps
 * review deterministic and prevents source transmission while it constructs graph evidence.
 */
export async function createDeterministicValidationIndex(repositoryRoot: string) {
  return new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new MultiLanguageCodeParser(),
    embeddingProvider: new LocalHashEmbeddingProvider(),
    indexStore: new InMemoryCodeIndexStore(),
  }).index(repositoryRoot);
}

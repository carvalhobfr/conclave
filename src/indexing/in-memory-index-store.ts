import type { CodeIndexStore, RepositoryCodeIndex } from "../domain/code-index.js";

export class InMemoryCodeIndexStore implements CodeIndexStore {
  readonly #indexes = new Map<string, RepositoryCodeIndex>();

  public load(repositoryRoot: string): Promise<RepositoryCodeIndex | undefined> {
    const index = this.#indexes.get(repositoryRoot);
    return Promise.resolve(index === undefined ? undefined : structuredClone(index));
  }

  public save(repositoryRoot: string, index: RepositoryCodeIndex): Promise<void> {
    this.#indexes.set(repositoryRoot, structuredClone(index));
    return Promise.resolve();
  }
}

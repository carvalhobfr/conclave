import type { JsonValue, PersistentStore } from "../domain/storage.js";

export class InMemoryStore implements PersistentStore {
  readonly #namespaces = new Map<string, Map<string, JsonValue>>();

  public get(namespace: string, key: string): Promise<JsonValue | undefined> {
    const value = this.#namespaces.get(namespace)?.get(key);
    return Promise.resolve(value === undefined ? undefined : structuredClone(value));
  }

  public set(namespace: string, key: string, value: JsonValue): Promise<void> {
    const entries = this.#namespaces.get(namespace) ?? new Map<string, JsonValue>();
    entries.set(key, structuredClone(value));
    this.#namespaces.set(namespace, entries);
    return Promise.resolve();
  }

  public delete(namespace: string, key: string): Promise<boolean> {
    return Promise.resolve(this.#namespaces.get(namespace)?.delete(key) ?? false);
  }

  public listKeys(namespace: string): Promise<readonly string[]> {
    return Promise.resolve([...(this.#namespaces.get(namespace)?.keys() ?? [])].sort());
  }
}

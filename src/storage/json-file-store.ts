import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { JsonValue, PersistentStore } from "../domain/storage.js";

type StoreState = Record<string, Record<string, JsonValue>>;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function parseState(content: string): StoreState {
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Persistent store is corrupt");
  }

  const state: StoreState = Object.create(null) as StoreState;
  for (const [namespace, entries] of Object.entries(parsed)) {
    validateIdentifier(namespace, "Namespace");
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
      throw new Error("Persistent store is corrupt");
    }
    const safeEntries: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      validateIdentifier(key, "Key");
      if (!isJsonValue(value)) {
        throw new Error("Persistent store contains a non-JSON value");
      }
      safeEntries[key] = value;
    }
    state[namespace] = safeEntries;
  }
  return state;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class JsonFileStore implements PersistentStore {
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();

  public constructor(filePath: string) {
    this.#filePath = filePath;
  }

  public get(namespace: string, key: string): Promise<JsonValue | undefined> {
    validateIdentifier(namespace, "Namespace");
    validateIdentifier(key, "Key");
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const value = state[namespace]?.[key];
      return value === undefined ? undefined : structuredClone(value);
    });
  }

  public set(namespace: string, key: string, value: JsonValue): Promise<void> {
    validateIdentifier(namespace, "Namespace");
    validateIdentifier(key, "Key");
    if (!isJsonValue(value)) {
      return Promise.reject(new Error("Persistent store only accepts finite JSON values"));
    }
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const entries = state[namespace] ?? (Object.create(null) as Record<string, JsonValue>);
      entries[key] = structuredClone(value);
      state[namespace] = entries;
      await this.#writeState(state);
    });
  }

  public delete(namespace: string, key: string): Promise<boolean> {
    validateIdentifier(namespace, "Namespace");
    validateIdentifier(key, "Key");
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const entries = state[namespace];
      if (entries === undefined || !(key in entries)) {
        return false;
      }
      Reflect.deleteProperty(entries, key);
      await this.#writeState(state);
      return true;
    });
  }

  public listKeys(namespace: string): Promise<readonly string[]> {
    validateIdentifier(namespace, "Namespace");
    return this.#enqueue(async () => {
      const state = await this.#readState();
      return Object.keys(state[namespace] ?? {}).sort();
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #readState(): Promise<StoreState> {
    try {
      return parseState(await readFile(this.#filePath, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return Object.create(null) as StoreState;
      }
      throw error;
    }
  }

  async #writeState(state: StoreState): Promise<void> {
    const directory = dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.#filePath);
    await chmod(this.#filePath, 0o600);
  }
}

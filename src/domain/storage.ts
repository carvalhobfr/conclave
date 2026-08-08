export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface PersistentStore {
  get(namespace: string, key: string): Promise<JsonValue | undefined>;
  set(namespace: string, key: string, value: JsonValue): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  listKeys(namespace: string): Promise<readonly string[]>;
}

/** Credentials deliberately use a separate, read-only boundary from app state. */
export interface CredentialSource {
  get(reference: string): string | undefined;
}

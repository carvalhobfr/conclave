import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
} from "../domain/embedding.js";
import { tokenizeCode } from "../retrieval/tokenizer.js";

export const LOCAL_HASH_EMBEDDING_DIMENSIONS = 384;

const SEMANTIC_CONCEPTS: Readonly<Record<string, readonly string[]>> = {
  auth: ["auth", "authentication", "authorize", "credential", "login", "session", "token"],
  cleanup: ["cleanup", "dispose", "remove", "teardown", "unregister", "unsubscribe"],
  event: ["event", "handler", "listener", "observe", "register", "subscribe"],
  persist: ["cache", "persist", "save", "storage", "store", "stored", "write"],
  read: ["fetch", "get", "load", "read", "retrieve"],
  restore: ["bootstrap", "hydrate", "initialize", "refresh", "rehydrate", "restore", "resume"],
  state: ["context", "provider", "state", "store"],
};

const CONCEPT_BY_TOKEN = new Map<string, string>(
  Object.entries(SEMANTIC_CONCEPTS).flatMap(([concept, tokens]) =>
    tokens.map((token) => [token, concept] as const),
  ),
);

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function addFeature(vector: number[], feature: string, weight: number): void {
  const hash = fnv1a(feature);
  const bucket = hash % vector.length;
  const sign = (hash & 0x80000000) === 0 ? 1 : -1;
  vector[bucket] = (vector[bucket] ?? 0) + sign * weight;
}

function normalizedVector(text: string, dimensions: number): readonly number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = tokenizeCode(text);
  for (const token of tokens) {
    addFeature(vector, `token:${token}`, 1);
    const concept = CONCEPT_BY_TOKEN.get(token);
    if (concept !== undefined) {
      addFeature(vector, `concept:${concept}`, 1.35);
    }
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    addFeature(vector, `bigram:${tokens[index] ?? ""}:${tokens[index + 1] ?? ""}`, 0.35);
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

/**
 * Fully local, deterministic code-aware feature-hashing embeddings.
 * This is an explicit production implementation, not a silent fake-model fallback.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "conclave-local-hash-v1";
  public readonly dimensions = LOCAL_HASH_EMBEDDING_DIMENSIONS;

  public embed(requests: readonly EmbeddingRequest[]): Promise<readonly EmbeddingResult[]> {
    return Promise.resolve(
      requests.map((request) => ({
        identity: request.identity,
        vector: normalizedVector(request.text, this.dimensions),
      })),
    );
  }
}

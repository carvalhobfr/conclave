import type { EmbeddingProvider } from "../domain/embedding.js";
import type { CredentialSource } from "../domain/storage.js";
import { LocalHashEmbeddingProvider } from "./local-hash-embedding.js";
import { OpenAiCompatibleEmbeddingProvider } from "./openai-compatible-embedding.js";

export class EmbeddingConfigurationError extends Error {
  public constructor(message: string) { super(message); this.name = "EmbeddingConfigurationError"; }
}

function value(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const trimmed = environment[name]?.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The feature hash remains the deterministic default. A learned embedding mode must be
 * requested explicitly, so an unavailable provider cannot silently change retrieval behavior.
 */
export function createEmbeddingProvider(
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: CredentialSource,
): EmbeddingProvider {
  const mode = value(environment, "CONCLAVE_EMBEDDING_MODE") ?? "feature-hash";
  if (mode === "feature-hash") return new LocalHashEmbeddingProvider();
  if (mode !== "openai-compatible") throw new EmbeddingConfigurationError("CONCLAVE_EMBEDDING_MODE must be feature-hash or openai-compatible");
  const model = value(environment, "CONCLAVE_EMBEDDING_MODEL");
  const baseUrl = value(environment, "CONCLAVE_EMBEDDING_BASE_URL") ?? value(environment, "CONCLAVE_BASE_URL");
  const dimensions = Number(value(environment, "CONCLAVE_EMBEDDING_DIMENSIONS"));
  if (model === undefined || baseUrl === undefined || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw new EmbeddingConfigurationError("Learned embeddings require CONCLAVE_EMBEDDING_MODEL, CONCLAVE_EMBEDDING_BASE_URL, and CONCLAVE_EMBEDDING_DIMENSIONS");
  }
  const local = (value(environment, "CONCLAVE_MODE") ?? "free") === "local";
  const credentialName = value(environment, "CONCLAVE_EMBEDDING_API_KEY") === undefined ? (local ? undefined : value(environment, "CONCLAVE_MODE") === "free" ? "CONCLAVE_FREE_API_KEY" : "CONCLAVE_API_KEY") : "CONCLAVE_EMBEDDING_API_KEY";
  const apiKey = credentialName === undefined ? undefined : (credentials?.get(credentialName) ?? value(environment, credentialName));
  if (!local && apiKey === undefined) throw new EmbeddingConfigurationError("A server-side embedding credential is required for external learned embeddings");
  const safeId = `openai-compatible-embedding:${new URL(baseUrl).origin}${new URL(baseUrl).pathname}:${model}:${String(dimensions)}`;
  return new OpenAiCompatibleEmbeddingProvider({ id: safeId, model, baseUrl, dimensions, ...(apiKey === undefined ? {} : { apiKey }), allowInsecureHttp: local });
}

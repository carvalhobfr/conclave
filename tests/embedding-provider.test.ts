import { describe, expect, it, vi } from "vitest";

import { createEmbeddingProvider } from "../src/embeddings/embedding-factory.js";
import { OpenAiCompatibleEmbeddingProvider } from "../src/embeddings/openai-compatible-embedding.js";
import type { FetchLike } from "../src/providers/openai-compatible-provider.js";

describe("learned semantic embeddings", () => {
  it("uses the OpenAI-compatible embeddings contract without falling back", async () => {
    const fetchImplementation = vi.fn<FetchLike>((input, init): Promise<Response> => { void input; void init; return Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: [0.2, 0.4] }] }), { status: 200 })); });
    const provider = new OpenAiCompatibleEmbeddingProvider({ id: "learned:test", model: "embed-test", baseUrl: "https://embeddings.example/v1", dimensions: 2, apiKey: "process-only-key", fetchImplementation });

    await expect(provider.embed([{ identity: "unit", text: "export function session() {}" }])).resolves.toEqual([{ identity: "unit", vector: [0.2, 0.4] }]);
    expect(provider.kind).toBe("learned-semantic");
    const request = fetchImplementation.mock.calls[0];
    if (request === undefined) throw new Error("Expected embedding request");
    expect(request[0]).toEqual(new URL("https://embeddings.example/v1/embeddings"));
    expect(request[1]?.headers).toEqual({ "content-type": "application/json", authorization: "Bearer process-only-key" });
  });

  it("makes learned embeddings opt-in and model-versioned", () => {
    const deterministic = createEmbeddingProvider({});
    const learned = createEmbeddingProvider({ CONCLAVE_MODE: "local", CONCLAVE_EMBEDDING_MODE: "openai-compatible", CONCLAVE_EMBEDDING_MODEL: "nomic-embed-text", CONCLAVE_EMBEDDING_BASE_URL: "http://127.0.0.1:11434/v1", CONCLAVE_EMBEDDING_DIMENSIONS: "768" });

    expect(deterministic.kind).toBe("deterministic-feature-hash");
    expect(learned).toEqual(expect.objectContaining({ kind: "learned-semantic", dimensions: 768 }));
    expect(learned.id).toContain("nomic-embed-text");
    expect(() => createEmbeddingProvider({ CONCLAVE_EMBEDDING_MODE: "openai-compatible" })).toThrow("Learned embeddings require");
  });
});

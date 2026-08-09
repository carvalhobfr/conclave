import { describe, expect, it, vi } from "vitest";

import { ProviderModelCatalog } from "../src/web/provider-model-catalog.js";
import type { ProviderModelCatalogError } from "../src/web/provider-model-catalog.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("ProviderModelCatalog", () => {
  it("loads only OpenAI text models and creates complete profiles", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requestedInit = init;
      return Promise.resolve(response({
        data: [
          { id: "gpt-5-mini" },
          { id: "gpt-5" },
          { id: "gpt-5-codex" },
          { id: "text-embedding-3-small" },
          { id: "gpt-image-1" },
        ],
      }));
    });
    const catalog = new ProviderModelCatalog(fetcher);

    const result = await catalog.list("openai", "personal-openai-key", "openai-main");

    expect(requestedUrl).toBe("https://api.openai.com/v1/models");
    expect(requestedInit?.method).toBe("GET");
    expect(requestedInit?.headers).toEqual({ Authorization: "Bearer personal-openai-key", Accept: "application/json" });
    expect(result.models.map((model) => model.id)).toEqual(["gpt-5", "gpt-5-codex", "gpt-5-mini"]);
    expect(result.profiles.map((profile) => profile.id)).toEqual(["balanced", "quality", "economy"]);
    expect(result.profiles.every((profile) => profile.assignments.length === 8)).toBe(true);
    expect(result.profiles.flatMap((profile) => profile.assignments).every((item) => item.connectionId === "openai-main")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("personal-openai-key");
  });

  it("loads the user-filtered OpenRouter catalog and derives quality, coding, and economy choices", async () => {
    let requestedUrl = "";
    let requestedHeaders: HeadersInit | undefined;
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requestedHeaders = init?.headers;
      return Promise.resolve(response({
        data: [
          { id: "anthropic/claude-opus", name: "Claude Opus", context_length: 200_000, pricing: { prompt: "0.000015", completion: "0.000075" }, architecture: { output_modalities: ["text"] } },
          { id: "openai/gpt-codex", name: "GPT Codex", pricing: { prompt: "0.00001", completion: "0.00003" }, architecture: { output_modalities: ["text"] } },
          { id: "deepseek/deepseek-chat:free", name: "DeepSeek Free", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] } },
          { id: "image/only", name: "Image only", architecture: { output_modalities: ["image"] } },
        ],
      }));
    });
    const catalog = new ProviderModelCatalog(fetcher);

    const result = await catalog.list("openrouter", "personal-router-key", "router-main");

    expect(requestedUrl).toBe("https://openrouter.ai/api/v1/models/user?output_modalities=text&sort=intelligence-high-to-low");
    expect(requestedHeaders).toEqual({ Authorization: "Bearer personal-router-key", Accept: "application/json" });
    expect(result.models).toHaveLength(3);
    expect(result.profiles.find((profile) => profile.id === "quality")?.defaultModel).toBe("anthropic/claude-opus");
    expect(result.profiles.find((profile) => profile.id === "economy")?.defaultModel).toBe("deepseek/deepseek-chat:free");
    expect(result.profiles.find((profile) => profile.id === "balanced")?.assignments.find((item) => item.role === "implementer")?.model).toBe("openai/gpt-codex");
  });

  it("returns a safe authentication error without exposing the upstream response or key", async () => {
    const catalog = new ProviderModelCatalog(() => Promise.resolve(response({ error: { message: "secret upstream detail" } }, 401)));

    await expect(catalog.list("openai", "private-key-value", "openai-main")).rejects.toEqual(
      expect.objectContaining<Partial<ProviderModelCatalogError>>({ message: "The personal OpenAI key was not accepted." }),
    );
  });
});

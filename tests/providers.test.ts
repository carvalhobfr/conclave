import { describe, expect, it, vi } from "vitest";

import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { FakeProvider } from "../src/providers/fake-provider.js";
import { OpenAiCompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { createProvider } from "../src/providers/provider-factory.js";
import { diagnoseProvider } from "../src/providers/provider-diagnostics.js";
import { EnvironmentCredentialSource } from "../src/storage/environment-credential-source.js";

describe("providers", () => {
  it("uses a fake provider for deterministic tests", async () => {
    const provider = new FakeProvider((request) => ({
      provider: "fake",
      model: request.model,
      text: "structured fake",
    }));

    await expect(
      provider.generate({ model: "test", messages: [{ role: "user", content: "question" }] }),
    ).resolves.toEqual(expect.objectContaining({ text: "structured fake" }));
    expect(provider.requests).toHaveLength(1);
  });

  it("calls the OpenAI-compatible chat completions contract and normalizes usage", async () => {
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(
        expect.objectContaining({ authorization: "Bearer process-only-key" }),
      );
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON string request body");
      }
      expect(JSON.parse(init.body)).toEqual(
        expect.objectContaining({
          model: "model-a",
          messages: [{ role: "user", content: "Hello" }],
          max_completion_tokens: 40,
        }),
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "model-a-2026",
            choices: [{ message: { content: "World" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const provider = new OpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    const response = await provider.generate({
      model: "model-a",
      messages: [{ role: "user", content: "Hello" }],
      maxOutputTokens: 40,
    });

    expect(response).toEqual({
      provider: "openai",
      model: "model-a-2026",
      text: "World",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL("https://api.openai.test/v1/chat/completions"),
      expect.any(Object),
    );
  });

  it("routes Local Mode through the same domain-neutral provider port", async () => {
    const environment = {
      CONCLAVE_MODE: "local",
      CONCLAVE_PROVIDER: "ollama",
      CONCLAVE_MODEL: "coder",
    };
    const fetchImplementation = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
      );
    });
    const config = loadRuntimeConfig(environment);
    const provider = createProvider(config, new EnvironmentCredentialSource(environment), {
      fetchImplementation,
    });

    await provider.generate({ model: "coder", messages: [{ role: "user", content: "ping" }] });
    const request = fetchImplementation.mock.calls[0]?.[1];
    if (typeof request?.body !== "string") {
      throw new Error("Expected a JSON string request body");
    }
    expect(JSON.parse(request.body)).not.toHaveProperty("max_completion_tokens");
  });

  it("does not pretend provider-specific protocols are OpenAI-compatible", () => {
    const environment = {
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: "anthropic",
      CONCLAVE_BASE_URL: "https://api.anthropic.test/v1",
      CONCLAVE_API_KEY: "key",
    };
    const config = loadRuntimeConfig(environment);

    expect(() => createProvider(config, new EnvironmentCredentialSource(environment))).toThrow(
      "adapter is not implemented in Phase 1",
    );
  });

  it("redacts a credential if an upstream error echoes it", async () => {
    const provider = new OpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "do-not-leak-this-key",
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: "Rejected key do-not-leak-this-key" } }),
            { status: 401 },
          ),
        ),
    });

    await expect(
      provider.generate({ model: "model-a", messages: [{ role: "user", content: "Hello" }] }),
    ).rejects.toThrow("Rejected key [REDACTED]");
    expect(JSON.stringify(provider)).not.toContain("do-not-leak-this-key");
  });

  it("retries a transient network failure and preserves a safe cause when it persists", async () => {
    const transient = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const fetchImplementation = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: transient }))
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: transient }));
    const provider = new OpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.test/v1",
      fetchImplementation,
    });

    await expect(
      provider.generate({ model: "model-a", messages: [{ role: "user", content: "Hello" }] }),
    ).rejects.toThrow("Provider request failed: fetch failed [ECONNRESET]: socket reset");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("reports bounded Local Mode diagnostics without exposing credentials", async () => {
    const environment = { CONCLAVE_MODE: "local", CONCLAVE_PROVIDER: "ollama", CONCLAVE_MODEL: "coder" };
    const config = loadRuntimeConfig(environment);
    const diagnostics = await diagnoseProvider(config, new EnvironmentCredentialSource(environment));

    expect(diagnostics).toEqual(expect.objectContaining({ mode: "local", modelConfigured: true, retrievalLocal: true, externalCallsDisabled: true }));
    expect(JSON.stringify(diagnostics)).not.toContain("CONCLAVE_");
  });
});

import { describe, expect, it } from "vitest";

import { describeRuntimeConfig, loadRuntimeConfig } from "../src/config/runtime-config.js";
import { EnvironmentCredentialSource } from "../src/storage/environment-credential-source.js";

describe("runtime configuration", () => {
  it("defaults to Free Mode without serializing server credentials", () => {
    const environment = {
      CONCLAVE_FREE_API_KEY: "server-secret-value",
      CONCLAVE_FREE_MODEL: "configured-model",
    };
    const config = loadRuntimeConfig(environment);
    const publicConfig = describeRuntimeConfig(config, new EnvironmentCredentialSource(environment));

    expect(publicConfig).toEqual(
      expect.objectContaining({
        mode: "free",
        privacyBoundary: "external",
        provider: "openai",
        credentialSource: "server-environment",
        credentialConfigured: true,
      }),
    );
    expect(JSON.stringify(config)).not.toContain("server-secret-value");
    expect(JSON.stringify(publicConfig)).not.toContain("server-secret-value");
  });

  it("supports loopback OpenAI-compatible Local Mode without credentials", () => {
    const config = loadRuntimeConfig({
      CONCLAVE_MODE: "local",
      CONCLAVE_PROVIDER: "openai-compatible",
      CONCLAVE_MODEL: "local-model",
      CONCLAVE_BASE_URL: "http://localhost:9000/v1",
    });

    expect(config).toEqual(
      expect.objectContaining({ mode: "local", privacyBoundary: "local-only" }),
    );
  });

  it("rejects insecure external URLs and non-loopback Local Mode URLs", () => {
    expect(() =>
      loadRuntimeConfig({
        CONCLAVE_MODE: "api",
        CONCLAVE_BASE_URL: "http://provider.example/v1",
      }),
    ).toThrow("External provider URLs must use HTTPS");
    expect(() =>
      loadRuntimeConfig({
        CONCLAVE_MODE: "local",
        CONCLAVE_BASE_URL: "http://192.168.1.5:11434/v1",
      }),
    ).toThrow("loopback host");
    expect(() =>
      loadRuntimeConfig({
        CONCLAVE_MODE: "api",
        CONCLAVE_BASE_URL: "https://provider.example/v1?api_key=secret",
      }),
    ).toThrow("query parameters or fragments");
  });

  it("prevents local adapters from being configured as hosted Free Mode", () => {
    expect(() =>
      loadRuntimeConfig({ CONCLAVE_MODE: "free", CONCLAVE_FREE_PROVIDER: "ollama" }),
    ).toThrow("externally hosted provider");
  });
});

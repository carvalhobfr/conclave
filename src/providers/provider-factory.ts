import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { CredentialSource } from "../domain/storage.js";
import type { LlmProvider } from "../domain/provider.js";
import { ConfigurationError } from "../config/runtime-config.js";
import { OpenAiCompatibleProvider, type FetchLike } from "./openai-compatible-provider.js";

export interface ProviderFactoryOptions {
  readonly fetchImplementation?: FetchLike;
  readonly timeoutMs?: number;
}

export function createProvider(
  config: RuntimeConfig,
  credentials: CredentialSource,
  options: ProviderFactoryOptions = {},
): LlmProvider {
  const selection = config.providerSelection;
  if (selection.provider === "anthropic" || selection.provider === "gemini") {
    throw new ConfigurationError(
      `${selection.provider} uses a provider-specific protocol; its adapter is not implemented in Phase 1`,
    );
  }
  if (selection.baseUrl === undefined) {
    const variable = config.mode === "free" ? "CONCLAVE_FREE_BASE_URL" : "CONCLAVE_BASE_URL";
    throw new ConfigurationError(`${variable} is required for provider ${selection.provider}`);
  }

  const apiKey =
    config.mode === "local"
      ? undefined
      : credentials.get(config.credentialEnvironmentVariable);
  if (config.mode !== "local" && apiKey === undefined) {
    throw new ConfigurationError(
      `${config.credentialEnvironmentVariable} is required for ${config.mode} mode`,
    );
  }

  return new OpenAiCompatibleProvider({
    id: selection.provider,
    baseUrl: selection.baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
    allowInsecureHttp: config.mode === "local",
    timeoutMs: options.timeoutMs ?? config.providerTimeoutMs ?? (config.mode === "free" ? 180_000 : 60_000),
    maxTokensField: config.mode === "local" ? "max_tokens" : "max_completion_tokens",
  });
}

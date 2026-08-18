import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { CredentialSource } from "../domain/storage.js";
import type { LlmProvider } from "../domain/provider.js";
import { ConfigurationError } from "../config/runtime-config.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAiCompatibleProvider, type FetchLike } from "./openai-compatible-provider.js";

export interface ProviderFactoryOptions {
  readonly fetchImplementation?: FetchLike;
}

export function createProvider(
  config: RuntimeConfig,
  credentials: CredentialSource,
  options: ProviderFactoryOptions = {},
): LlmProvider {
  const selection = config.providerSelection;
  if (selection.provider === "gemini") {
    throw new ConfigurationError(
      `${selection.provider} uses a provider-specific protocol; its adapter is not implemented in Phase 1`,
    );
  }
  if (selection.baseUrl === undefined) {
    throw new ConfigurationError(`CONCLAVE_BASE_URL is required for provider ${selection.provider}`);
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

  if (selection.provider === "anthropic") {
    if (apiKey === undefined) {
      throw new ConfigurationError("An API credential is required for Anthropic");
    }
    return new AnthropicProvider({
      baseUrl: selection.baseUrl,
      apiKey,
      ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
    });
  }

  return new OpenAiCompatibleProvider({
    id: selection.provider,
    baseUrl: selection.baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
    allowInsecureHttp: config.mode === "local",
    ...(config.mode === "local" || selection.provider === "opencode-go" || selection.provider === "opencode-zen"
      ? { timeoutMs: 180_000 }
      : {}),
    maxTokensField: config.mode === "local" ? "max_tokens" : "max_completion_tokens",
  });
}

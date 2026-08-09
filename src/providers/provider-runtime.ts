import { ConfigurationError } from "../config/runtime-config.js";
import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { LlmProvider, ProviderId } from "../domain/provider.js";
import type { CredentialSource } from "../domain/storage.js";
import { createProvider, type ProviderFactoryOptions } from "./provider-factory.js";

export interface ProviderAssignment {
  readonly providerId: string;
}

const OPENAI_COMPATIBLE_EXTERNAL = new Set<ProviderId>([
  "openai",
  "openrouter",
  "opencode-zen",
  "openai-compatible",
]);
const OPENAI_COMPATIBLE_LOCAL = new Set<ProviderId>([
  "ollama",
  "lm-studio",
  "openai-compatible",
]);

function providerId(value: string, mode: RuntimeConfig["mode"]): Exclude<ProviderId, "fake"> {
  const allowed = mode === "local" ? OPENAI_COMPATIBLE_LOCAL : OPENAI_COMPATIBLE_EXTERNAL;
  if (!allowed.has(value as ProviderId)) {
    throw new ConfigurationError(
      `Provider ${value} is not compatible with the configured ${mode} OpenAI-compatible endpoint`,
    );
  }
  return value as Exclude<ProviderId, "fake">;
}

function withProvider(config: RuntimeConfig, requestedProvider: string): RuntimeConfig {
  const provider = providerId(requestedProvider, config.mode);
  const providerSelection = { ...config.providerSelection, provider };
  if (config.mode === "free") return { ...config, providerSelection };
  if (config.mode === "api") return { ...config, providerSelection };
  return { ...config, providerSelection };
}

/**
 * Creates protocol adapters for effective role IDs while inheriting one mode-owned
 * endpoint and credential reference. Credentials are resolved only by createProvider.
 */
export function createProviderRuntime(
  config: RuntimeConfig,
  credentials: CredentialSource,
  assignments: readonly ProviderAssignment[],
  options: ProviderFactoryOptions = {},
): ReadonlyMap<string, LlmProvider> {
  const requestedIds = new Set([
    config.providerSelection.provider,
    ...assignments.map((assignment) => assignment.providerId),
  ]);
  const providers = new Map<string, LlmProvider>();
  for (const id of requestedIds) {
    providers.set(id, createProvider(withProvider(config, id), credentials, options));
  }
  return providers;
}

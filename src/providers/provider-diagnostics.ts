import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { CredentialSource } from "../domain/storage.js";
import { ProviderError } from "../domain/provider.js";
import { createProvider, type ProviderFactoryOptions } from "./provider-factory.js";

export interface ProviderDiagnostics {
  readonly mode: RuntimeConfig["mode"];
  readonly provider: string;
  readonly endpoint: string | undefined;
  readonly modelConfigured: boolean;
  readonly endpointReachable: boolean;
  readonly inferenceAvailable: boolean;
  readonly statusCode?: number;
  readonly retrievalLocal: true;
  readonly externalCallsDisabled: boolean;
  readonly message: string;
}

function providerFailure(error: unknown): { readonly endpointReachable: boolean; readonly statusCode?: number; readonly message: string } {
  if (!(error instanceof ProviderError) || error.statusCode === undefined) {
    return {
      endpointReachable: false,
      message: "Conclave could not reach the provider. Check the endpoint and local network connection.",
    };
  }
  const statusCode = error.statusCode;
  const message = statusCode === 400
    ? "The provider rejected the inference request (HTTP 400). Check that the selected model supports this API endpoint."
    : statusCode === 401
      ? "The provider rejected the API key (HTTP 401). Paste a valid key for the selected provider."
      : statusCode === 402
        ? "The provider requires an active subscription or credits (HTTP 402). Check billing for this account."
        : statusCode === 403
          ? "The provider accepted the key but denied access (HTTP 403). Check the subscription, workspace, and region permissions."
          : statusCode === 404
            ? "The provider could not find this endpoint or model (HTTP 404). Check both values."
            : statusCode === 429
              ? "The provider rate or usage limit was reached (HTTP 429). Wait or check the account limits."
              : statusCode >= 500
                ? `The provider is currently failing upstream (HTTP ${String(statusCode)}). Retry shortly.`
                : `The provider rejected the inference request (HTTP ${String(statusCode)}). Check the provider account and model configuration.`;
  return { endpointReachable: true, statusCode, message };
}

/** Makes a bounded one-token-equivalent inference request; credentials never leave this module. */
export async function diagnoseProvider(config: RuntimeConfig, credentials: CredentialSource, options: ProviderFactoryOptions = {}): Promise<ProviderDiagnostics> {
  const selection = config.providerSelection;
  const model = selection.model;
  const base = {
    mode: config.mode,
    provider: selection.provider,
    endpoint: selection.baseUrl,
    modelConfigured: model !== undefined,
    retrievalLocal: true as const,
    externalCallsDisabled: config.mode === "local",
  };
  if (model === undefined) return { ...base, endpointReachable: false, inferenceAvailable: false, message: "Configure a model before running an inference diagnostic." };
  try {
    const provider = createProvider(config, credentials, options);
    await provider.generate({ model, messages: [{ role: "system", content: "Reply with OK." }, { role: "user", content: "Connectivity check." }], maxOutputTokens: 8 });
    return { ...base, endpointReachable: true, inferenceAvailable: true, message: "Bounded provider inference succeeded." };
  } catch (error) {
    return { ...base, ...providerFailure(error), inferenceAvailable: false };
  }
}

import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { CredentialSource } from "../domain/storage.js";
import { createProvider } from "./provider-factory.js";

export interface ProviderDiagnostics {
  readonly mode: RuntimeConfig["mode"];
  readonly provider: string;
  readonly endpoint: string | undefined;
  readonly modelConfigured: boolean;
  readonly endpointReachable: boolean;
  readonly inferenceAvailable: boolean;
  readonly retrievalLocal: true;
  readonly externalCallsDisabled: boolean;
  readonly message: string;
}

/** Makes a bounded one-token-equivalent inference request; credentials never leave this module. */
export async function diagnoseProvider(config: RuntimeConfig, credentials: CredentialSource): Promise<ProviderDiagnostics> {
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
    const provider = createProvider(config, credentials);
    await provider.generate({ model, messages: [{ role: "system", content: "Reply with OK." }, { role: "user", content: "Connectivity check." }], maxOutputTokens: 8, temperature: 0 });
    return { ...base, endpointReachable: true, inferenceAvailable: true, message: "Bounded provider inference succeeded." };
  } catch {
    return { ...base, endpointReachable: false, inferenceAvailable: false, message: "Conclave could not complete the bounded provider inference check. Check endpoint, model, and server-side credentials." };
  }
}

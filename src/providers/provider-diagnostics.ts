import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { CredentialSource } from "../domain/storage.js";
import { createProvider, type ProviderFactoryOptions } from "./provider-factory.js";

export interface DiagnosticAssignment {
  readonly role: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface ProviderDiagnosticOptions extends ProviderFactoryOptions {
  readonly assignments?: readonly DiagnosticAssignment[];
}

export interface ProviderDiagnostics {
  readonly mode: RuntimeConfig["mode"];
  readonly provider: string;
  readonly endpoint: string | undefined;
  readonly endpointHost: string | undefined;
  readonly model: string | undefined;
  readonly modelConfigured: boolean;
  readonly endpointReachable: boolean;
  readonly inferenceAvailable: boolean;
  readonly retrievalLocal: true;
  readonly externalCallsDisabled: boolean;
  readonly assignments: readonly { readonly role: string; readonly provider: string; readonly model: string }[];
  readonly message: string;
}

/** Makes a bounded one-token-equivalent inference request; credentials never leave this module. */
export async function diagnoseProvider(
  config: RuntimeConfig,
  credentials: CredentialSource,
  options: ProviderDiagnosticOptions = {},
): Promise<ProviderDiagnostics> {
  const selection = config.providerSelection;
  const model = selection.model;
  const endpointHost = selection.baseUrl === undefined ? undefined : new URL(selection.baseUrl).host;
  const base = {
    mode: config.mode,
    provider: selection.provider,
    endpoint: selection.baseUrl,
    endpointHost,
    model,
    modelConfigured: model !== undefined,
    retrievalLocal: true as const,
    externalCallsDisabled: config.mode === "local",
    assignments: (options.assignments ?? []).map((assignment) => ({ role: assignment.role, provider: assignment.providerId, model: assignment.modelId })),
  };
  if (model === undefined) return { ...base, endpointReachable: false, inferenceAvailable: false, message: "Configure a model before running an inference diagnostic." };
  try {
    const provider = createProvider(config, credentials, options);
    await provider.generate({ model, messages: [{ role: "system", content: "Reply with OK." }, { role: "user", content: "Connectivity check." }], maxOutputTokens: 8, temperature: 0 });
    return { ...base, endpointReachable: true, inferenceAvailable: true, message: "Bounded provider inference succeeded." };
  } catch (error) {
    // ProviderError already redacts credentials; retaining its bounded message
    // makes local diagnostics actionable without exposing request payloads.
    const detail = error instanceof Error ? error.message.slice(0, 300) : "unknown provider failure";
    return { ...base, endpointReachable: false, inferenceAvailable: false, message: `Bounded provider inference failed: ${detail}` };
  }
}

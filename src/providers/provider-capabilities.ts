import type { ProviderId } from "../domain/provider.js";

/**
 * Transport-level quirks of each OpenAI-compatible endpoint, kept in one table instead of
 * scattered checks inside the request builder. Adding a provider means adding a row here.
 */
export interface ProviderCapabilities {
  /** Endpoints that reject `temperature` outright rather than clamping it. */
  readonly acceptsTemperature: boolean;
  /** Endpoints that understand `response_format: { type: "json_schema" }`. */
  readonly acceptsJsonSchema: boolean;
  /**
   * Model-name prefixes that advertise JSON-schema support but return malformed or empty
   * output for it. These fall back to `json_object` without paying for a rejected request.
   */
  readonly jsonObjectOnlyModelPrefixes: readonly string[];
  /** Endpoints that default to a reasoning pass Conclave does not want to pay for. */
  readonly disablesReasoningEffort: boolean;
  /** Endpoints observed to drop the first connection of a session. */
  readonly retriesNetworkFailure: boolean;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  acceptsTemperature: true,
  acceptsJsonSchema: false,
  jsonObjectOnlyModelPrefixes: [],
  disablesReasoningEffort: false,
  retriesNetworkFailure: false,
};

const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  acceptsTemperature: false,
  acceptsJsonSchema: true,
  jsonObjectOnlyModelPrefixes: ["deepseek-"],
  disablesReasoningEffort: false,
  retriesNetworkFailure: true,
};

const CAPABILITIES: Partial<Readonly<Record<ProviderId, ProviderCapabilities>>> = {
  ollama: {
    ...DEFAULT_CAPABILITIES,
    acceptsJsonSchema: true,
    disablesReasoningEffort: true,
  },
  "opencode-go": OPENCODE_CAPABILITIES,
  "opencode-zen": OPENCODE_CAPABILITIES,
};

export function providerCapabilities(provider: ProviderId): ProviderCapabilities {
  return CAPABILITIES[provider] ?? DEFAULT_CAPABILITIES;
}

export function prefersJsonObject(capabilities: ProviderCapabilities, model: string): boolean {
  return capabilities.jsonObjectOnlyModelPrefixes.some((prefix) => model.startsWith(prefix));
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Classifies a transport failure by its cause rather than by the runtime's error text, which
 * differs between Node releases and between Node, Bun, and Deno. A timeout raised by
 * `AbortSignal.timeout` is deliberately excluded: the caller already waited the full budget.
 */
export function isRetriableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "TimeoutError" || error.name === "AbortError") {
    return false;
  }
  const cause: unknown = error.cause;
  if (isErrorWithCode(cause) && NETWORK_ERROR_CODES.has(cause.code)) return true;
  if (isErrorWithCode(error) && NETWORK_ERROR_CODES.has(error.code)) return true;
  // undici surfaces a bare `TypeError: fetch failed` and hides the real reason in `cause`.
  return error instanceof TypeError;
}

function isErrorWithCode(value: unknown): value is { readonly code: string } {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && typeof (value as { readonly code: unknown }).code === "string";
}

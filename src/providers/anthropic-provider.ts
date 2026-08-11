import type {
  GenerateRequest,
  GenerateResponse,
  LlmProvider,
  TokenUsage,
} from "../domain/provider.js";
import { ProviderError } from "../domain/provider.js";
import type { FetchLike } from "./openai-compatible-provider.js";

export interface AnthropicProviderOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImplementation?: FetchLike;
  readonly timeoutMs?: number;
}

interface AnthropicResponse {
  readonly model?: string;
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSecret(message: string, secret: string): string {
  return message.replaceAll(secret, "[REDACTED]");
}

function responseError(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload["error"])) return undefined;
  const message = payload["error"]["message"];
  return typeof message === "string" ? message.slice(0, 500) : undefined;
}

function parseResponse(payload: unknown): AnthropicResponse {
  if (!isRecord(payload) || !Array.isArray(payload["content"])) {
    throw new ProviderError("Anthropic returned an invalid Messages response", "anthropic");
  }
  const content = payload["content"].flatMap((item) => {
    if (!isRecord(item) || item["type"] !== "text" || typeof item["text"] !== "string") return [];
    return [{ type: item["type"], text: item["text"] }];
  });
  if (content.length === 0) throw new ProviderError("Anthropic response did not contain text output", "anthropic");
  const usageValue = isRecord(payload["usage"]) ? payload["usage"] : undefined;
  const inputTokens = usageValue?.["input_tokens"];
  const outputTokens = usageValue?.["output_tokens"];
  const usage: TokenUsage | undefined =
    (typeof inputTokens === "number" && Number.isFinite(inputTokens)) ||
    (typeof outputTokens === "number" && Number.isFinite(outputTokens))
      ? {
          ...(typeof inputTokens === "number" && Number.isFinite(inputTokens) ? { inputTokens } : {}),
          ...(typeof outputTokens === "number" && Number.isFinite(outputTokens) ? { outputTokens } : {}),
        }
      : undefined;
  const normalizedUsage = usage === undefined
    ? undefined
    : {
        ...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { output_tokens: usage.outputTokens }),
      };
  return {
    content,
    ...(typeof payload["model"] === "string" ? { model: payload["model"] } : {}),
    ...(typeof payload["stop_reason"] === "string" ? { stop_reason: payload["stop_reason"] } : {}),
    ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
  };
}

export class AnthropicProvider implements LlmProvider {
  public readonly id = "anthropic" as const;
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  public constructor(options: AnthropicProviderOptions) {
    const baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (baseUrl.protocol !== "https:") throw new ProviderError("Anthropic provider URL must use HTTPS", "anthropic");
    if (baseUrl.username !== "" || baseUrl.password !== "" || baseUrl.search !== "" || baseUrl.hash !== "") {
      throw new ProviderError("Anthropic provider URL must not contain credentials, queries, or fragments", "anthropic");
    }
    this.#endpoint = new URL(baseUrl.pathname.endsWith("/v1/") ? "messages" : "v1/messages", baseUrl);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  public async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const body = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? 1_024,
      ...(system === "" ? {} : { system: request.responseFormat === "json" ? `${system}\n\nReturn a valid JSON object only.` : system }),
      messages: request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content })),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    };
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown network error";
      throw new ProviderError(`Anthropic request failed: ${redactSecret(reason, this.#apiKey)}`, "anthropic");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError("Anthropic returned a non-JSON response", "anthropic", response.status);
    }
    if (!response.ok) {
      throw new ProviderError(
        redactSecret(responseError(payload) ?? `Anthropic request failed with status ${String(response.status)}`, this.#apiKey),
        "anthropic",
        response.status,
      );
    }
    const parsed = parseResponse(payload);
    const text = parsed.content?.map((item) => item.text ?? "").join("");
    if (text === undefined || text === "") throw new ProviderError("Anthropic response did not contain text output", "anthropic");
    const usage = parsed.usage;
    return {
      provider: "anthropic",
      model: parsed.model ?? request.model,
      text,
      ...(parsed.stop_reason === undefined ? {} : { finishReason: parsed.stop_reason }),
      ...(usage === undefined
        ? {}
        : {
            usage: {
              ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
              ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
            },
          }),
    };
  }
}

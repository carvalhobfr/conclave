import type {
  GenerateRequest,
  GenerateResponse,
  LlmProvider,
  ProviderId,
  TokenUsage,
} from "../domain/provider.js";
import { ProviderError } from "../domain/provider.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleProviderOptions {
  readonly id: Exclude<ProviderId, "anthropic" | "gemini" | "fake">;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly allowInsecureHttp?: boolean;
  readonly fetchImplementation?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
}

interface ChatCompletionResponse {
  readonly model?: string;
  readonly choices: readonly {
    readonly message: { readonly content: string };
    readonly finishReason?: string;
  }[];
  readonly usage?: TokenUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const textParts = value.flatMap((part) => {
    if (!isRecord(part)) {
      return [];
    }
    const text = part["text"];
    return typeof text === "string" ? [text] : [];
  });
  return textParts.length === 0 ? undefined : textParts.join("");
}

function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseChatCompletion(payload: unknown, provider: ProviderId): ChatCompletionResponse {
  if (!isRecord(payload) || !Array.isArray(payload["choices"])) {
    throw new ProviderError("Provider returned an invalid chat completion", provider);
  }

  const choices = payload["choices"].flatMap((choice) => {
    if (!isRecord(choice) || !isRecord(choice["message"])) {
      return [];
    }
    const content = parseContent(choice["message"]["content"]);
    if (content === undefined) {
      return [];
    }
    const finishReason = choice["finish_reason"];
    return [
      {
        message: { content },
        ...(typeof finishReason === "string" ? { finishReason } : {}),
      },
    ];
  });

  if (choices.length === 0) {
    throw new ProviderError("Provider response did not contain text output", provider);
  }

  const rawUsage = payload["usage"];
  let usage: TokenUsage | undefined;
  if (isRecord(rawUsage)) {
    const inputTokens = optionalTokenCount(rawUsage["prompt_tokens"]);
    const outputTokens = optionalTokenCount(rawUsage["completion_tokens"]);
    if (inputTokens !== undefined || outputTokens !== undefined) {
      usage = {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      };
    }
  }

  return {
    choices,
    ...(typeof payload["model"] === "string" ? { model: payload["model"] } : {}),
    ...(usage === undefined ? {} : { usage }),
  };
}

function errorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload["error"])) {
    return undefined;
  }
  const message = payload["error"]["message"];
  return typeof message === "string" ? message.slice(0, 500) : undefined;
}

function redactSecret(message: string, secret: string | undefined): string {
  return secret === undefined || secret === "" ? message : message.replaceAll(secret, "[REDACTED]");
}

function networkFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown network error";
  const cause = error.cause;
  if (cause instanceof Error && cause.message !== error.message) {
    const code = "code" in cause && typeof cause.code === "string" ? ` [${cause.code}]` : "";
    return `${error.message}${code}: ${cause.message}`;
  }
  const code = "code" in error && typeof error.code === "string" ? ` [${error.code}]` : "";
  return `${error.message}${code}`;
}

function isTransientNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  if (error.message === "fetch failed") return true;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false;
  return ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(String(cause.code));
}

export class OpenAiCompatibleProvider implements LlmProvider {
  public readonly id: OpenAiCompatibleProviderOptions["id"];
  readonly #endpoint: URL;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxTokensField: "max_tokens" | "max_completion_tokens";

  public constructor(options: OpenAiCompatibleProviderOptions) {
    const baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (baseUrl.username !== "" || baseUrl.password !== "") {
      throw new ProviderError("Provider URL must not contain credentials", options.id);
    }
    if (baseUrl.search !== "" || baseUrl.hash !== "") {
      throw new ProviderError(
        "Provider URL must not contain query parameters or fragments",
        options.id,
      );
    }
    if (baseUrl.protocol !== "https:" && options.allowInsecureHttp !== true) {
      throw new ProviderError("External provider URL must use HTTPS", options.id);
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new ProviderError("Provider URL must use HTTP or HTTPS", options.id);
    }

    this.id = options.id;
    this.#endpoint = new URL("chat/completions", baseUrl);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxTokensField = options.maxTokensField ?? "max_completion_tokens";
  }

  public async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
    if (request.maxOutputTokens !== undefined) {
      body[this.#maxTokensField] = request.maxOutputTokens;
    }
    if (request.temperature !== undefined) {
      body["temperature"] = request.temperature;
    }
    if (request.responseFormat === "json") {
      body["response_format"] = { type: "json_object" };
    }

    let response: Response | undefined;
    let lastNetworkError: unknown;
    const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? this.#timeoutMs);
    const signal = request.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([request.signal, timeoutSignal]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }),
          },
          body: JSON.stringify(body),
          signal,
        });
        break;
      } catch (error) {
        lastNetworkError = error;
        if (attempt === 0 && isTransientNetworkFailure(error)) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 250);
            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(signal.reason instanceof Error ? signal.reason : new Error("Provider request cancelled"));
            }, { once: true });
          });
          continue;
        }
        break;
      }
    }
    if (response === undefined) {
      const reason = redactSecret(networkFailureReason(lastNetworkError), this.#apiKey);
      throw new ProviderError(`Provider request failed: ${reason}`, this.id);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError("Provider returned a non-JSON response", this.id, response.status);
    }

    if (!response.ok) {
      const rawMessage =
        errorMessage(payload) ?? `Provider request failed with status ${String(response.status)}`;
      throw new ProviderError(
        redactSecret(rawMessage, this.#apiKey),
        this.id,
        response.status,
      );
    }

    const completion = parseChatCompletion(payload, this.id);
    const firstChoice = completion.choices[0];
    if (firstChoice === undefined) {
      throw new ProviderError("Provider response did not contain a choice", this.id);
    }
    return {
      provider: this.id,
      model: completion.model ?? request.model,
      text: firstChoice.message.content,
      ...(firstChoice.finishReason === undefined ? {} : { finishReason: firstChoice.finishReason }),
      ...(completion.usage === undefined ? {} : { usage: completion.usage }),
    };
  }
}

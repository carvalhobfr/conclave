import type { GenerateRequest, GenerateResponse, LlmProvider } from "../domain/provider.js";

export type FakeProviderHandler = (request: GenerateRequest) => GenerateResponse | Promise<GenerateResponse>;

export class FakeProvider implements LlmProvider {
  public readonly id = "fake" as const;
  public readonly requests: GenerateRequest[] = [];
  readonly #handler: FakeProviderHandler;

  public constructor(handler?: FakeProviderHandler) {
    this.#handler =
      handler ??
      ((request) => ({
        provider: "fake",
        model: request.model,
        text: "Fake provider response",
      }));
  }

  public async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.requests.push(structuredClone(request));
    return this.#handler(request);
  }
}

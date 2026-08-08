export interface EmbeddingRequest {
  readonly identity: string;
  readonly text: string;
}

export interface EmbeddingResult {
  readonly identity: string;
  readonly vector: readonly number[];
}

export type EmbeddingKind = "deterministic-feature-hash" | "learned-semantic";

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly kind: EmbeddingKind;
  embed(requests: readonly EmbeddingRequest[]): Promise<readonly EmbeddingResult[]>;
}

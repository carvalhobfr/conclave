export interface EmbeddingRequest {
  readonly identity: string;
  readonly text: string;
}

export interface EmbeddingResult {
  readonly identity: string;
  readonly vector: readonly number[];
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(requests: readonly EmbeddingRequest[]): Promise<readonly EmbeddingResult[]>;
}

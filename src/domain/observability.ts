export type RetrievalEventType =
  | "repository_index_started"
  | "file_parsed"
  | "file_skipped"
  | "index_updated"
  | "embedding_cache_hit"
  | "lexical_search_completed"
  | "semantic_search_completed"
  | "hybrid_search_completed"
  | "graph_expansion_completed"
  | "retrieval_plan_completed"
  | "context_packed"
  | "evidence_selected";

export interface RetrievalEvent {
  readonly type: RetrievalEventType;
  readonly occurredAt: string;
  readonly repositoryId?: string;
  readonly path?: string;
  readonly data?: Readonly<Record<string, string | number | boolean>>;
}

export interface RetrievalEventSink {
  emit(event: RetrievalEvent): void;
}

export class NullRetrievalEventSink implements RetrievalEventSink {
  public emit(_event: RetrievalEvent): void {
    void _event;
    // Deliberately no-op for library consumers that do not need tracing.
  }
}

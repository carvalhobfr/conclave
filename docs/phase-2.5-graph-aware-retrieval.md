# Phase 2.5 Graph-aware retrieval and context efficiency

## Scope

Phase 2.5 promotes the deterministic Phase 2 graph into an explicit retrieval subsystem. It adds graph queries, inspectable query planning, hard evidence budgets, and compact context bundles. It remains entirely deterministic: no LLM plans queries, infers graph edges, summarizes source, or generates an answer.

## Graph schema

Graph nodes are either indexed files or structural symbols. Relation types are explicit:

- `belongs-to-file`;
- `exports-symbol`;
- `contains-symbol`;
- `imports-file`;
- `imports-symbol`;
- `references-symbol`;
- `calls-symbol`;
- `extends-symbol`;
- `implements-symbol`.

The TypeScript parser extracts simple identifier-based `extends` and `implements` clauses. Graph construction links them only through an explicit import binding or a unique same-file declaration.

Every edge has a provenance kind:

- `extracted`: directly represented by a declaration, explicit export, or nested source range;
- `resolved`: linked deterministically through a relative import, explicit import binding, imported identifier, or unique same-file identifier.

Provenance retains the source path, start/end line when available, relation type on the edge, resolution method, and a human-readable reason. There are no inferred or model-generated edges.

The persisted index advances to schema/indexing version 2 and `.conclave/code-index-v2.json`. Older indexes are not trusted as schema 2; indexing rebuilds them from the safe repository snapshot.

## First-class graph queries

`GraphQueryService` provides deterministic operations for:

- exact symbol and file node resolution;
- neighbors, incoming edges, and outgoing edges;
- callers, callees, imports, exports, and references;
- containing and contained symbols;
- related files;
- bounded subgraphs;
- bounded shortest symbol paths.

All traversal accepts depth, node, and edge limits. Results are sorted deterministically and suppress duplicate nodes/edges. Exact duplicate symbol names return an explicit `ambiguous` result with candidates; Conclave never selects one by map order.

Symbol path queries use symbol relationships by default. File ownership/import edges cannot create misleading shortcuts between symbols. Direct calls are preferred over duplicate identifier-reference edges when both represent the same step.

## Graph-first planner

`RetrievalPlanner` uses inspectable heuristics in this order:

1. quoted exact text, indexed path, and exact symbol detection;
2. graph intent detection and bounded graph execution;
3. lexical BM25;
4. deterministic feature-vector similarity;
5. hybrid fusion and bounded graph expansion.

Supported graph intents include callers, callees, imports, exports, references/dependents, containment, related files, and shortest paths. If exact resolution plus graph traversal returns sufficient evidence, lexical and feature-vector retrieval are explicitly skipped. If resolution is ambiguous, no relation exists, or no exact entity is present, the planner falls back to broad graph-aware hybrid retrieval.

The returned `RetrievalPlan` lists every executed or skipped operation, its reason, and result count. Observability records only operation counts and skip decisions, never query/source content.

## Evidence budgets and context packing

The default `EvidenceBudget` limits:

| Resource | Default |
| --- | ---: |
| Graph depth | 2 |
| Graph nodes | 30 |
| Retrieval candidates | 50 |
| Final packed evidence units | 10 |
| Source bytes | 24,000 |
| Approximate downstream tokens | 6,000 |

`ContextPacker` processes ranked evidence in order, validates each item against the indexed content hash, suppresses duplicate evidence IDs, and merges overlapping or adjacent ranges from the canonical persisted source. A merged unit retains every contributing evidence ID, structural unit ID, symbol, ranking reason, and file content hash.

Approximate tokens use a documented deterministic estimate of `ceil(UTF-8 source bytes / 4)`. This is context planning, not provider tokenization. The bundle reports evidence counts, source bytes, estimated tokens, represented files/symbols, compaction, truncation, and relevant graph relationships.

## Embedding terminology

The 384-dimensional `conclave-local-hash-v1` provider remains the offline default. Its explicit provider kind is `deterministic-feature-hash`; evaluation calls the strategy `feature-vector`. It is signed feature hashing over code-aware terms and a small declared concept map, not a learned semantic model.

`EmbeddingProvider.kind` distinguishes deterministic feature hashing from `learned-semantic` implementations. The interface remains suitable for a future local or hosted learned model without changing retrieval consumers.

## Evaluation

The original three Phase 2 cases are unchanged. Four new cases cover callers, paths, dependents, and semantic discovery followed by graph expansion.

On all seven cases:

| Strategy | MRR | Mean packed evidence | Mean source bytes | Mean approx. tokens | Mean executed strategies | Relevant evidence / 1k tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Lexical | 0.7143 | 7.5714 | 1097.0 | 274.7143 | 1.0000 | 6.7603 |
| Feature vector | 0.8095 | 9.4286 | 1512.2857 | 378.4286 | 1.0000 | 5.6625 |
| Hybrid, no graph | 0.8857 | 9.5714 | 1448.0 | 362.4286 | 3.0000 | 5.9125 |
| Graph-aware hybrid | 0.9048 | 6.2857 | 990.7143 | 248.1429 | 3.2857 | 8.6356 |

Graph-aware hybrid uses 34.3% fewer packed evidence units, 31.6% fewer source bytes, and 31.5% fewer approximate tokens than hybrid without graph on the same cases, while MRR rises by 0.0191. Graph-only is evaluated only on the three explicitly graph-resolvable cases: MRR 1.0, mean 2.3333 packed units, and 118.6667 approximate tokens.

This remains a small deterministic regression fixture, not a broad code-search quality claim.

## Known limits

- Resolution does not use a TypeScript `Program`, type checker, `tsconfig` aliases, package exports, or language-server data.
- Dynamic imports, computed properties, callbacks passed through values, runtime dispatch, polymorphic call targets, and framework wiring remain unresolved.
- Namespace/member heritage clauses and ambiguous identifiers do not create edges.
- Reference line provenance currently uses the containing structural range because identifier references retain names but not individual offsets; direct calls retain exact call lines.
- Feature hashing has limited conceptual coverage compared with a learned code embedding model.
- Approximate token accounting is provider-independent and will differ from exact model tokenization.

## Phase 3 recommendation

Phase 3 is safe to begin against these interfaces. Reasoning agents should consume `PlannedRetrieval` and `ContextBundle`, cite retained evidence/edge provenance, request additional bounded retrieval when needed, and treat a missing graph edge as unknown rather than proof that no runtime relationship exists. Phase 3 must not replace this retrieval stack or infer hidden graph edges as facts.

# Phase 2 Code Intelligence and RAG

## Scope

Phase 2 turns safe Phase 1 repository snapshots into persistent code intelligence and retrieval evidence. It does not call an LLM, synthesize an answer, or define agent/claim state.

## Parser choice

Conclave uses a language-router behind the `CodeParser` port. The TypeScript compiler parser handles TypeScript/TSX/JavaScript/JSX, while deterministic structural parsers handle Python and Java.

The TypeScript parser was selected over Tree-sitter for the initial JavaScript-family language set because it offers native syntax coverage, tolerant AST creation for partially malformed files, precise source offsets, and first-class import/export syntax without native bindings. Python and Java use conservative line/brace-aware structural parsing so partially edited files remain indexable. None of the parsers type-check, evaluate imports, or execute repository scripts.

Additional language parsers can implement `CodeParser` without changing indexing or retrieval.

## Structural representation

The parser emits `StructuralCodeUnit` values for:

- functions and async functions;
- variable-assigned arrow/function expressions;
- React components and hooks;
- classes and methods;
- nested named functions;
- interfaces, type aliases, and enums.

Python and Java units currently cover declarations, methods, imports, calls, exports, and inheritance. Their parsers intentionally do not claim compiler-level diagnostics; unsupported languages continue through file-level indexing and contract checks.

Each unit has a deterministic identity, exact source range, exact node text, parent symbol where applicable, file imports/exports, direct syntactic calls, and identifier references.

Persisted indexes store source text once per file. Indexed structural units retain ranges and identities rather than duplicate excerpts. `Evidence` reconstructs exact complete source lines from the single file copy.

## Index lifecycle

Phase 2 originally used schema 1. Phase 2.5 advances graph provenance to schema 2, persisted at `.conclave/code-index-v2.json`, with owner-only file permissions and atomic replacement. The current indexing version is 3 because the Python and Java structural parsers are part of the index contract; older indexes rebuild automatically.

Indexing:

1. loads a Phase 1 `RepositorySnapshot`;
2. rejects every secret-classified file and unsupported language;
3. detects unchanged files through Phase 1 SHA-256 content hashes;
4. reuses unchanged parser metadata, lexical terms, and embeddings;
5. parses changed/new files independently, without aborting for a single parser failure;
6. removes deleted files, symbols, graph edges, and unused embedding records;
7. rebuilds the deterministic relationship graph;
8. validates and atomically persists the index.

The persisted loader validates schema, repository root, relative paths, unit/file ownership, and embedding dimensions. An unsupported schema causes a full rebuild; corruption fails explicitly.

## Lexical retrieval

Source, symbols, and paths are tokenized with camel-case, underscore, punctuation, and light stemming awareness. Symbol terms receive a threefold indexing weight and path terms a twofold weight. BM25 uses `k1 = 1.2` and `b = 0.75`; raw BM25 scores remain visible in retrieval signals.

Exact text search is separate. It scans the one persisted file source, supports case-sensitive or case-insensitive matching, and returns deterministic line-backed evidence.

## Embeddings

The production default is `conclave-local-hash-v1`:

- 384 dimensions;
- fully local and deterministic;
- signed feature hashing over code-aware unigrams and bigrams;
- a small explicit concept map for relationships such as auth/session/token, bootstrap/restore/refresh, store/persist, and listener/cleanup;
- L2-normalized vectors;
- no paid call, network request, native dependency, or model download.

This is an explicit, limited embedding implementation—not a fake learned model. It improves conceptual matching over raw tokens but cannot provide the broad semantics of a trained code embedding model. `EmbeddingProvider` supports replacing it with local or hosted learned embeddings. Tests can use deterministic test providers.

Embeddings are cached by provider ID plus structural source identity. Unchanged units and unchanged units inside a modified file reuse cached vectors.

## Hybrid ranking

Heterogeneous score scales are combined with weighted Reciprocal Rank Fusion (`k = 60`):

- lexical BM25: `0.8`;
- semantic cosine: `1.2`;
- exact symbol: `8.0`;
- partial symbol: `0.25`;
- path: `1.2`;
- graph: `1.0`.

Exact identifiers therefore dominate generic similarity. Low-information partial symbol tokens such as `state`, `data`, `get`, and `set` are excluded from the partial-symbol signal. Declaration-kind weights keep behavior-oriented functions/methods ahead of interfaces and type aliases when the underlying evidence scores are otherwise similar.

Every result exposes raw component signals, the final retrieval score, and user-facing ranking/graph reasons. Scores are not confidence estimates.

## Code graph

The graph records only relationships with deterministic provenance:

- symbol belongs to file;
- file explicitly exports symbol;
- parent symbol contains nested symbol;
- relative import resolves to indexed file;
- explicit import binding resolves to explicit exported symbol;
- identifier references an imported or unique same-file symbol;
- direct identifier call resolves through an import or unique same-file declaration.

External packages, unresolved aliases, ambiguous same-file names, dynamic dispatch, and speculative property relationships do not create edges.

Graph expansion is bidirectional and bounded by depth and evidence count. Duplicate symbols are suppressed. Expanded results retain the edge relation and extraction reason.

## Retrieval API

`CodeRetrievalService` provides application operations for:

- `search(query)`;
- `searchText(text)`;
- `findSymbol(name, path?)`;
- `findSymbolsInFile(path)`;
- `findReferences(symbol)`;
- `findImports(pathOrSymbol)`;
- `findRelated(symbol)`;
- `readEvidence(id)`;
- `readFile(path, range?)`.

These are regular application services. Phase 3 may expose selected operations as agent tools without changing retrieval internals.

## Evaluation definitions

The fixture benchmark defines expectations before retrieval runs. Metrics are macro-averaged across cases:

- file Recall@K: fraction of distinct expected files represented in the top K;
- symbol Recall@K: fraction of distinct expected symbols represented in an expected file in the top K;
- first relevant rank: first result whose path and symbol satisfy the case expectations;
- MRR: mean reciprocal first relevant rank, with missing evidence scored as zero.

The original Phase 2 results remain reproducible with `npm run eval`. The additive graph-aware benchmark is documented in the Phase 2.5 architecture and runs with `npm run eval:graph`.

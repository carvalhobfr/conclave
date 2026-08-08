# Conclave

Conclave is an evidence-driven Code RAG application built around a simple product idea:

> Ask your code. Let the models argue.

The project currently contains **Phase 2 — Code Intelligence and RAG**. It indexes TypeScript and JavaScript repositories and returns inspectable, provenance-backed repository evidence. It intentionally does not generate an answer or run agents yet.

## What exists

- Phase 1 repository, provider, privacy, credential, persistence, and content-safety boundaries.
- Tolerant structural parsing for TypeScript, TSX, JavaScript, and JSX through the TypeScript compiler API.
- Functions, classes, methods, React components, hooks, interfaces, type aliases, enums, nested symbols, and variable-assigned functions.
- Independent file intelligence for source hashes, imports, exports, parser diagnostics, and symbol identities.
- Persistent incremental indexing with changed/new/deleted-file handling and cached embeddings.
- Deterministic symbol lookup, path + symbol lookup, exported-symbol discovery, exact text search, and file/range reads.
- Local BM25 retrieval over code-aware tokens.
- A local 384-dimensional code-aware feature-hashing embedding implementation with no model download or paid API.
- Weighted Reciprocal Rank Fusion across lexical, semantic, exact/partial symbol, path, and graph signals.
- A provenance-backed graph for resolved imports, explicit symbol bindings, containment, and direct local/imported references and calls.
- Bounded graph expansion with depth, evidence-budget, and duplicate limits.
- Stable `Evidence` objects with exact line ranges and excerpts.
- Structured indexing/retrieval events that exclude source text and queries.
- Realistic fixture repositories and a deterministic lexical/semantic/hybrid evaluation harness.
- CLI commands for indexing, retrieval, exact text, and symbols.

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

Index and inspect a repository:

```bash
npm run dev -- index /path/to/repository
npm run dev -- search /path/to/repository "where is authentication restored?"
npm run dev -- symbol /path/to/repository bootstrapSession
npm run dev -- text /path/to/repository "AUTH_RESTORE_FAILED"
```

Search output includes rank, source location, structural symbol, retrieval score, component signals, graph/relationship reasons, and the exact repository excerpt. Retrieval scores are ranking values, not confidence estimates.

The search command incrementally updates the repository index before querying it. Persistent indexes live at `.conclave/code-index-v1.json` inside the indexed repository and are excluded from future scans.

## Evaluation

Run the committed fixture benchmark:

```bash
npm run eval
```

Current three-case results:

| Strategy | File R@1 | File R@3 | File R@5 | Symbol R@1 | Symbol R@3 | Symbol R@5 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Lexical | 0.3333 | 0.6667 | 0.8333 | 0.3333 | 0.6667 | 0.6667 | 0.5000 |
| Semantic | 0.3333 | 0.6667 | 1.0000 | 0.1667 | 0.6667 | 1.0000 | 0.5556 |
| Hybrid | 0.6667 | 0.8333 | 0.8333 | 0.5000 | 0.8333 | 0.8333 | 0.7778 |

Hybrid improves early file recall and MRR on this small fixture, but semantic-only File Recall@5 remains higher. The benchmark reports this rather than hiding it.

## Execution modes

Free, API, and Local Mode configuration remains available from Phase 1 for later inference stages. Phase 2 retrieval itself is local and performs no LLM call.

```bash
npm run dev -- config --json
```

- Free Mode credentials come from the server process.
- API Mode credentials come from the user process environment.
- Local Mode permits only loopback model endpoints.
- No credential is persisted in the code index.

See `.env.example` for provider-connectivity examples. `provider-check` exercises only the provider adapter and is separate from retrieval.

## Project layout

```text
src/
  code-intelligence/  structural parser adapters
  domain/             repository, evidence, index, graph, and provider ports
  embeddings/         interchangeable embedding implementations
  evaluation/         retrieval benchmark runner
  graph/              deterministic code relationship extraction
  indexing/           persistent and incremental index lifecycle
  retrieval/          tokenizer, BM25, fusion, evidence, and query services
  repositories/       safe local-folder loading
  security/           path, secret, and untrusted-context boundaries
  storage/            app-state and credential-source adapters
tests/fixtures/        realistic retrieval/evaluation repositories
```

See [Phase 1 architecture](docs/phase-1-architecture.md), [Phase 2 Code RAG architecture](docs/phase-2-code-rag.md), and [security boundaries](docs/security.md).

## Current limitations

- The parser is syntax-aware but does not create a TypeScript `Program`, run type checking, or resolve `tsconfig` path aliases.
- The local embedding is deterministic feature hashing with a small code-oriented concept map, not a learned neural model. The abstraction supports adding local or hosted learned embeddings later.
- BM25 and vector search currently scan in-memory index records; there is no ANN index or database-backed inverted index.
- Graph resolution covers relative imports, explicit exports/bindings, unique same-file identifiers, and direct identifier calls. It does not attempt language-server-level resolution, dynamic imports, package exports, polymorphism, or arbitrary property dispatch.
- Root `.gitignore` and `.conclaveignore` files are honored; nested ignore-file composition remains unimplemented.
- The JSON index is atomic and owner-readable but not encrypted or cross-process locked.
- Source files classified as likely secrets are excluded completely, but heuristic secret detection can have false positives and false negatives.
- Local Git working trees can be indexed as folders; remote Git cloning is not implemented.
- No Investigator, Skeptic, Architect, Verifier, Judge, Claims, Challenges, Verdict, LLM answer, hosted backend, rate limiter, or web UI exists.

## Recommended next phase

Proceed with **Phase 3 — Conclave Engine**: structured Claims and Challenges, Investigator/Skeptic/Architect/Verifier/Judge roles, deterministic verification tools, iterative retrieval requests, explicit orchestration state, execution traces, and verdict synthesis. Phase 3 should consume the evidence and retrieval primitives delivered here rather than implementing another retrieval stack.

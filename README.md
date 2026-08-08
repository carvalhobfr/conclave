# Conclave

Conclave is an evidence-driven Code RAG application built around a simple product idea:

> Ask your code. Let the models argue.

The project currently contains **Phase 3 — Conclave Reasoning Engine**. It indexes TypeScript and JavaScript repositories, retrieves provenance-backed evidence, proposes explicit claims, selectively challenges them, performs bounded follow-up retrieval, verifies them, and returns an inspectable verdict.

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
- A provenance-backed graph for ownership, exports, resolved imports, containment, inheritance, direct references, and calls.
- First-class graph queries for nodes, edges, callers/callees, imports/exports, references, containment, related files, bounded subgraphs, and shortest paths.
- An inspectable graph-first retrieval planner that skips feature-vector retrieval when deterministic evidence is sufficient.
- Explicit graph/candidate/evidence/source-byte/approximate-token budgets.
- Deterministic context packing that merges overlapping source while retaining evidence and edge provenance.
- Stable `Evidence` objects with exact line ranges and excerpts.
- Structured indexing/retrieval events that exclude source text and queries.
- Realistic fixture repositories and deterministic Phase 2 plus graph-aware evaluation harnesses.
- Structured `Claim`, `Challenge`, `RetrievalRequest`, `VerificationResult`, and `Verdict` state.
- Independent role-to-provider/model assignments for Investigator, Skeptic, Architect, Verifier, and Judge.
- Strict runtime validation and one bounded repair attempt for model JSON outputs.
- Deterministic selective routing that avoids Skeptic and Architect calls for simple lookups.
- Bounded, deduplicated follow-up symbol, text, caller/callee/reference, path, and search retrieval.
- Deterministic verification that takes precedence over model agreement and preserves uncertainty.
- Injection-resistant role prompts that frame repository source as untrusted data.
- Per-role model-call, token, provider usage, latency, retrieval, and final-claim metrics.
- CLI commands for indexing, retrieval inspection, graph queries, evidence-grounded questions, and evaluation.

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
npm run dev -- retrieve /path/to/repository "Where is bootstrapSession called?"
npm run dev -- symbol /path/to/repository bootstrapSession
npm run dev -- text /path/to/repository "AUTH_RESTORE_FAILED"
npm run dev -- graph /path/to/repository bootstrapSession --operation callers
npm run dev -- path /path/to/repository LoginButton persistToken --depth 4
npm run dev -- ask /path/to/repository "Why might authentication disappear after refreshing?" --debug
```

Search output includes rank, source location, structural symbol, retrieval score, component signals, graph/relationship reasons, and the exact repository excerpt. Retrieval scores are ranking values, not confidence estimates.

The search and graph commands incrementally update the repository index before querying it. Persistent indexes live at `.conclave/code-index-v2.json` inside the indexed repository and are excluded from future scans.

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

Run the additive seven-case graph/context benchmark:

```bash
npm run eval:graph
```

| Strategy | MRR | Mean evidence | Mean bytes | Mean approx. tokens | Relevant / 1k tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lexical | 0.7143 | 7.5714 | 1097.0 | 274.7143 | 6.7603 |
| Feature vector | 0.8095 | 9.4286 | 1512.2857 | 378.4286 | 5.6625 |
| Hybrid, no graph | 0.8857 | 9.5714 | 1448.0 | 362.4286 | 5.9125 |
| Graph-aware hybrid | 0.9048 | 6.2857 | 990.7143 | 248.1429 | 8.6356 |

Compared on the same cases, graph-aware hybrid reduces approximate context tokens by 31.5% and packed evidence units by 34.3% while improving MRR by 0.0191. Graph-only is scored separately on three graph-resolvable cases and reaches MRR 1.0 with 118.7 mean approximate tokens. These fixtures are regression tests, not broad production benchmarks.

The fixed Phase 3 benchmark compares the same two cases across single-pass generation, Investigator + Judge, and Conclave. It uses scripted fake providers, so CI measures orchestration rather than model variability.

| Strategy | Answer accuracy | Claim precision | Unsupported rate | Wrong-claim rejection | Mean calls | Mean retrieval rounds | Mean context tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Single model | 0.5000 | 0.7500 | 0.2500 | 0.5000 | 1 | 0 | 986.0 |
| Investigator + Judge | 0.5000 | 0.7500 | 0.2500 | 0.5000 | 2 | 0 | 1466.5 |
| Conclave | 1.0000 | 1.0000 | 0.0000 | 1.0000 | 3 | 1 | 2784.0 |

Run it with:

```bash
npm run eval:reasoning
```

`eval-reasoning` also supports optional configured-provider experiments. Those runs are intentionally separate from deterministic CI:

```bash
npm run dev -- eval-reasoning /path/to/repository /path/to/reasoning-cases.json --json
```

## Execution modes

Free, API, and Local Mode configuration from Phase 1 now drives reasoning inference. Retrieval remains local and performs no LLM call.

```bash
npm run dev -- config --json
```

- Free Mode credentials come from the server process.
- API Mode credentials come from the user process environment.
- Local Mode permits only loopback model endpoints.
- No credential is persisted in the code index.
- `CONCLAVE_REASONING_PRESET` selects `free-like`, `full`, or `local` behavior.
- `CONCLAVE_<ROLE>_PROVIDER` and `CONCLAVE_<ROLE>_MODEL` override each role independently.

See `.env.example` for provider-connectivity examples. `provider-check` exercises only the provider adapter and is separate from retrieval.

## Project layout

```text
src/
  code-intelligence/  structural parser adapters
  domain/             repository, evidence, index, graph, and provider ports
  embeddings/         interchangeable embedding implementations
  evaluation/         retrieval and reasoning benchmark runners
  graph/              deterministic code relationship extraction
  indexing/           persistent and incremental index lifecycle
  retrieval/          tokenizer, BM25, fusion, evidence, and query services
  reasoning/          agents, routing, follow-up retrieval, verification, and verdicts
  repositories/       safe local-folder loading
  security/           path, secret, and untrusted-context boundaries
  storage/            app-state and credential-source adapters
tests/fixtures/        realistic retrieval/evaluation repositories
```

See [Phase 1 architecture](docs/phase-1-architecture.md), [Phase 2 Code RAG architecture](docs/phase-2-code-rag.md), [Phase 2.5 graph-aware retrieval](docs/phase-2.5-graph-aware-retrieval.md), [Phase 3 reasoning](docs/phase-3-reasoning.md), and [security boundaries](docs/security.md).

## Current limitations

- The parser is syntax-aware but does not create a TypeScript `Program`, run type checking, or resolve `tsconfig` path aliases.
- The local embedding is deterministic feature hashing with a small code-oriented concept map, not a learned neural model. The abstraction supports adding local or hosted learned embeddings later.
- BM25 and vector search currently scan in-memory index records; there is no ANN index or database-backed inverted index.
- Graph resolution covers relative imports, explicit exports/bindings, unique same-file identifiers, direct identifier calls, and simple resolvable heritage clauses. It does not attempt language-server-level resolution, dynamic imports, package exports, polymorphism, or arbitrary property dispatch.
- Missing graph edges mean “not statically resolved,” not proof that no runtime relationship exists.
- Negative deterministic checks are only as complete as the static index; dynamic dispatch and unresolved imports can require an uncertain verdict.
- Context tokens use a deterministic bytes/4 estimate, not an exact provider tokenizer.
- The CLI constructs the configured runtime provider. Heterogeneous role providers require embedding multiple configured adapters in a future host process; unsupported assignments fail cleanly.
- Structured output uses strict JSON validation, not provider-specific JSON Schema transport.
- Root `.gitignore` and `.conclaveignore` files are honored; nested ignore-file composition remains unimplemented.
- The JSON index is atomic and owner-readable but not encrypted or cross-process locked.
- Source files classified as likely secrets are excluded completely, but heuristic secret detection can have false positives and false negatives.
- Local Git working trees can be indexed as folders; remote Git cloning is not implemented.
- No repository edits, patches, shell execution against target repositories, hosted backend, rate limiter, or web UI exists.

## Recommended next phase

Proceed with **Phase 4 — Task Execution** on top of the structured Verdict. Keep repository mutation, command authorization, patch generation, validation, and rollback boundaries separate from the Phase 3 reasoning engine.

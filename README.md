# Conclave

Conclave is an evidence-driven Code RAG application built around a simple product idea:

> Ask your code. Let the models argue.

This repository currently contains **Phase 1 — Foundation**. It establishes safe repository access, execution-mode and provider boundaries, persistence ports, and a developer CLI. It intentionally does not claim to perform Code RAG or multi-agent analysis yet.

## What exists

- Strict TypeScript domain types for repositories, evidence references, providers, privacy boundaries, and persistence.
- A `RepositorySource` port and a working local-folder adapter.
- Root `.gitignore`, `.conclaveignore`, built-in generated-output, cache, binary, and obvious-secret exclusions.
- File size/count limits, binary detection, extension-based language detection, symlink exclusion, and optional allowed-root enforcement.
- A content safety assessment for likely credentials, private keys, and prompt-injection-shaped text.
- A bounded repository-context builder that labels source as untrusted and prevents secret-bearing files from entering external model context.
- Free, API, and Local Mode configuration with explicit privacy boundaries.
- A provider-neutral `LlmProvider` interface, deterministic `FakeProvider`, and working OpenAI-compatible Chat Completions HTTP adapter.
- Environment-only credential access; runtime configuration contains credential references, not credential values.
- In-memory and owner-readable JSON-file persistence adapters.
- A small CLI for repository scans, safe configuration inspection, and provider connectivity checks.

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run dev -- scan .
```

The scan command reports aggregate metadata only; it does not print repository source.

```bash
npm run dev -- scan /path/to/repository --json
npm run dev -- config --json
```

## Execution modes

Copy `.env.example` into your process/environment manager as a reference. The CLI does not load `.env` files itself, which avoids adding a second credential persistence path.

### Free Mode

Free Mode is the default. Credentials belong to the Conclave server process:

```bash
CONCLAVE_MODE=free \
CONCLAVE_FREE_PROVIDER=openai \
CONCLAVE_FREE_MODEL=your-server-model \
CONCLAVE_FREE_API_KEY=your-server-key \
npm run dev -- provider-check
```

The Phase 1 CLI exercises this boundary, but there is no hosted service or rate limiter yet.

### API Mode

API Mode reads a user-provided key from the current process only:

```bash
CONCLAVE_MODE=api \
CONCLAVE_PROVIDER=openai \
CONCLAVE_MODEL=your-model \
CONCLAVE_API_KEY=your-key \
npm run dev -- provider-check
```

`openai`, `openrouter`, `opencode-zen`, and `openai-compatible` can use the OpenAI-compatible adapter when a compatible HTTPS base URL is available. OpenAI and OpenRouter have built-in base URLs; custom providers require `CONCLAVE_BASE_URL`.

Anthropic and Gemini are recognized provider identities but deliberately fail with a clear unsupported-adapter error. Their native protocol adapters are not implemented in this phase.

### Local Mode

Local Mode allows only loopback HTTP(S) endpoints and does not require an API key:

```bash
CONCLAVE_MODE=local \
CONCLAVE_PROVIDER=ollama \
CONCLAVE_MODEL=your-installed-model \
npm run dev -- provider-check
```

Defaults:

- Ollama: `http://127.0.0.1:11434/v1`
- LM Studio: `http://127.0.0.1:1234/v1`

## Project layout

```text
src/
  config/        validated Free/API/Local runtime configuration
  domain/        provider-independent types and ports
  providers/     LLM adapter implementations and routing
  repositories/  local-folder loading, ignore rules, file classification
  security/      path, secret, and untrusted-context boundaries
  storage/       app-state and credential-source adapters
  cli.ts         Phase 1 developer interface
tests/           isolated unit and fixture-style integration tests
docs/            architecture and security notes
```

See [Phase 1 architecture](docs/phase-1-architecture.md) and [security boundaries](docs/security.md) for the design rationale.

## Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Tests use temporary fixture repositories and fake HTTP/model providers. No real model call is required.

## Current limitations

- No structural parser, symbols, chunks, embeddings, lexical index, vector index, graph, or retrieval API exists yet.
- No Investigator, Skeptic, Architect, Verifier, Judge, Claim state machine, trace, or verdict exists yet.
- Local Git working trees can be scanned as folders; cloning remote Git URLs is not implemented.
- Only root `.gitignore` and `.conclaveignore` files are evaluated. Nested ignore files are not yet composed.
- Secret and prompt-injection detection is heuristic and intentionally conservative, not a substitute for a dedicated secret-scanning service.
- The JSON persistence adapter is single-process and has no cross-process locking or database indexing.
- Provider streaming, tool calls, structured JSON schemas, embeddings, cost tracking, and provider-specific Anthropic/Gemini adapters are not implemented.
- Free Mode has no hosted backend, authentication, or rate limiting in this phase.
- There is no browser or web UI.

## Recommended next phase

Proceed with **Phase 2 — Code Intelligence and RAG**: TypeScript/JavaScript structural parsing, symbol-aware chunks, lexical/symbol/semantic retrieval, hybrid reranking, import/reference relationships, indexing lifecycle, and measurable retrieval fixtures. Do not begin the multi-agent engine until retrieval quality is testable.

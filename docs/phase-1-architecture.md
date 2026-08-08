# Phase 1 architecture

## Dependency direction

Conclave uses ports at the domain boundary and adapters at the edges:

```text
CLI / future application services
          |
          v
Domain types and ports
  |        |         |
  v        v         v
Repository Provider  Persistence adapters
adapters    adapters
```

Domain code imports no provider SDK, filesystem implementation, orchestration framework, or database type. The current HTTP adapter uses the platform `fetch` API, and the local repository adapter uses Node filesystem APIs.

## Repository boundary

`RepositorySource` returns a `RepositorySnapshot` with normalized repository-relative paths, content hashes, language metadata, line-preserving text, and a safety assessment. `LocalFolderRepository` is the first adapter.

The loader:

1. resolves the canonical root and optionally checks it against configured allowed roots;
2. combines built-in exclusions with root `.gitignore` and `.conclaveignore` patterns;
3. walks without following symlinks;
4. enforces file-count and per-file byte limits;
5. skips obvious binary content;
6. classifies language by extension;
7. records a content hash and external-transmission safety result.

Phase 2 can consume the snapshot without coupling parsing or indexing to filesystem traversal. A future Git adapter can implement `RepositorySource` without changing consumers.

## Provider boundary

`LlmProvider.generate()` accepts Conclave-owned request and response types. Provider-specific payloads remain inside adapters.

The first real adapter targets the broadly implemented OpenAI-compatible Chat Completions shape. This was selected for the initial boundary because OpenAI, OpenRouter, Ollama, LM Studio, and other compatible endpoints can share the adapter while model/provider selection remains configuration. Native Anthropic and Gemini protocols require their own adapters and are explicitly unsupported for now.

`FakeProvider` captures requests and returns deterministic responses, so later orchestration tests will not require model calls.

## Execution modes and privacy

Runtime configuration is a discriminated union:

| Mode | Credential source | Privacy boundary | Endpoint rule |
| --- | --- | --- | --- |
| Free | server environment | external | HTTPS |
| API | user process environment | external | HTTPS |
| Local | none | local-only | loopback HTTP(S) |

Runtime configuration contains only the credential environment-variable name. The credential value crosses into the provider factory from a separate `CredentialSource` and is held in a JavaScript private field by the HTTP adapter.

The orchestration layer planned for Phase 3 will consume the same `LlmProvider` regardless of mode.

## Repository content is untrusted

Content safety and context construction are separate operations:

- loading assesses likely secrets and prompt-injection-shaped content;
- external context construction rejects secret-bearing files, limits files and bytes, and wraps selected source in untrusted-data markers;
- a system instruction states that repository text is evidence, never instructions;
- Local Mode may retain secret-bearing content locally but still marks it as untrusted model input.

The context builder accepts only an explicit list of selected files. It is not connected to a “send repository” operation. Phase 2 retrieval will be responsible for selecting evidence before this boundary.

## Persistence

`PersistentStore` supports namespaced JSON app state. The JSON-file adapter uses atomic replacement, serializes in-process operations, validates namespace/key identifiers, and applies owner-only file permissions. The in-memory implementation supports tests.

Credentials deliberately have a separate read-only `CredentialSource`; `PersistentStore` is not used for provider keys.

## Deliberate omissions

Phase 1 defines `EvidenceReference` because accurate evidence locations are a cross-phase domain concept. It does not define claim transitions or agent state: those are Phase 3 behavior and should be designed against the retrieval capabilities that actually exist after Phase 2.

No framework-managed orchestration was introduced. The later Conclave state machine can remain explicit TypeScript domain logic.

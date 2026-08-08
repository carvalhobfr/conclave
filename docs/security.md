# Security boundaries

Repositories are sensitive and their contents are untrusted. Phase 1 establishes the following enforceable boundaries.

## Credentials

- Provider credentials are read from process environment variables through `CredentialSource`.
- Serializable runtime configuration stores only the environment-variable reference.
- Credentials are held in a private field inside the HTTP adapter and are only placed in the outbound authorization header.
- Provider URLs containing usernames or passwords are rejected.
- External provider endpoints must use HTTPS.
- The JSON app-state store is not a credential store.

There is no browser bundle in Phase 1. A future web backend must keep provider creation and credential access server-side.

## Repository paths

- Roots are canonicalized and must be accessible directories.
- Hosted callers can configure `allowedRoots`; paths outside them are rejected.
- Repository-relative paths come from filesystem enumeration, not user-provided retrieval paths.
- Symlinks are not followed.
- Canonical file paths are checked against the repository root before reads.
- Storage namespaces and keys reject traversal characters.

## Ingestion exclusions

Built-in exclusions cover version-control metadata, common dependency/build/cache directories, source maps, minified JavaScript, environment files, private-key files, and common credential filenames. Root `.gitignore` and `.conclaveignore` add repository-specific rules.

Files over the configured byte limit, repositories over the configured file limit, and likely binary files are not loaded.

## External inference

Before repository content can be prepared for an external model:

- likely credentials and private keys block that file from external transmission;
- the context builder enforces file and byte budgets;
- every excerpt is labelled as untrusted repository data;
- a separate system instruction tells the model to treat source only as evidence;
- prompt-injection-shaped repository text is recorded as a warning.

The provider adapter never accepts a repository snapshot directly. A caller must explicitly build a bounded context from selected files. This prevents an accidental whole-repository request at the type/API boundary.

## Code indexing and retrieval

- Ignored files never reach the Phase 2 index because indexing consumes the Phase 1 repository snapshot.
- Any file with a blocking content-safety finding is excluded from parsing, lexical indexing, embeddings, graph construction, and persistence.
- Parser operations create syntax trees only. They do not type-check, import, evaluate, install, or execute repository code.
- Index paths are canonicalized beneath the repository root. Persisted file/unit paths must be normalized repository-relative paths.
- Index schema, repository ownership, unit/file ownership, and embedding dimensions are validated when loading.
- `.conclave/code-index-v2.json` is written atomically with owner-only permissions and is ignored by repository loading and Git.
- Graph operations traverse only validated indexed nodes and edges and enforce bounded depth/node/result limits.
- Context packing reconstructs ranges only from the validated canonical source copy, verifies evidence content hashes, and enforces evidence, source-byte, and approximate-token budgets.
- Retrieval observability records event type, counts, paths, and ranks where needed. It does not record queries, complete private files, credentials, or hidden model reasoning.
- Evidence provenance comes only from deterministic index metadata and source ranges. No model can create or alter it.

## Local Mode

Local Mode is marked `local-only`, accepts only loopback HTTP(S) provider endpoints, and does not require a credential. Repository content can remain on the machine. Code retrieval uses the local deterministic feature-hash provider and persisted vectors without network access.

## Reasoning

- Repository excerpts are serialized only inside explicit untrusted-data sections; system role instructions and trusted task records are separate messages/sections.
- Roles return strict JSON. Unknown fields and fabricated claim, evidence, or graph-edge IDs are rejected before domain state changes.
- Agents can request only typed, bounded operations through `CodeRetrievalService`; they cannot open arbitrary paths, invoke tools, change providers, or expand budgets.
- Provider/model assignments come from validated host configuration, never repository text or model output.
- Deterministic verification overrides model agreement, and rejected claims are excluded by deterministic answer synthesis.
- Execution traces retain concise structured conclusions and usage metadata. They do not store hidden chain-of-thought.
- Reasoning is capped by model-call, round, repeated-request, evidence, graph, approximate-token, and output-token limits.

## Task execution

Task Mode has no model-to-shell path. The only execution flow is:

```text
model requests a typed capability
    -> Conclave policy validates permissions, shape, target, and budget
    -> policy creates an unforgeable approved command
    -> structured runner starts the fixed executable with shell disabled
```

- Intent is explicit. `ask` and `investigate` cannot enter the mutation workflow.
- Permissions default to plan-only. Editing, static checks, repository-code execution, and network access are separate cumulative grants.
- The Planner, Implementer, and Reviewer return strict JSON. Unknown fields, paths outside the plan, fabricated IDs, raw command strings, executable names, and argument arrays are rejected.
- Repository content, prior diffs, implementation claims, check output, and post-change evidence remain labelled untrusted data in every role prompt.
- A clean Git repository is edited in a detached temporary worktree. A non-Git folder is copied to a temporary workspace without symlinks, ignored files, or likely secrets. The source repository is never edited directly.
- Patches are exact, expected-hash-bound replacements against existing regular files. Protected, ignored, secret-like, escaping, and symlink paths are rejected. Every applied round can be rolled back.
- File count, per-file lines, total lines, patch bytes, model calls, commands, command duration, command output, evidence, revision rounds, and total task duration are bounded.
- Allowed commands are a closed union: Node syntax checks, Node test files, and host-allowlisted package scripts. There is no raw shell command domain type.
- Command policy maps capabilities to fixed executable/argument vectors. The runner uses `spawn` with `shell: false`, a fixed isolated working directory, a credential-free environment allowlist, timeout/process-group termination, and bounded captured output.
- The same in-memory index is incrementally refreshed after edits. Deterministic requirement and claim checks override model assertions; unrelated edits, failed checks, and unsupported required claims create blocking findings even if the Reviewer approves.
- Revisions are bounded and stop on repeated no-progress signatures. Completion is never inferred only from an Implementer or Reviewer statement.

## Local web application

- The Phase 5 product server binds to `127.0.0.1`; it is not a hosted API surface and does not implement Free Mode hosting.
- Browser requests are display/application requests only. The browser never receives provider credentials, raw repository index state, arbitrary filesystem authority, direct command execution, or direct patch authority.
- Local folder opening is canonicalized and restricted to `CONCLAVE_WEB_ALLOWED_ROOT` (or the server working directory by default). Browser-provided paths outside that boundary are rejected.
- API JSON bodies are capped at 64 KB and API errors are converted to concise product-safe messages rather than provider headers, credentials, or stack traces.
- Provider configuration continues to be read by the local server process from existing environment-backed configuration. Phase 5 adds no plaintext browser credential store.
- Demo Mode uses a bundled repository fixture and FakeProvider responses labelled as deterministic demo inference. It does not represent a configured remote provider or hosted Free service.
- Task permission controls request the existing Task Mode flags only. The core policy remains the authority for every patch and command capability; the UI cannot construct an approved command or apply a patch to the original repository.

## Residual risks

- Pattern-based secret detection has false positives and false negatives.
- Prompt injection cannot be eliminated solely through delimiters and instructions; later structured outputs and evidence validation remain necessary.
- Node tests and package scripts execute repository code. Because portable child-process filesystem and network isolation is unavailable, they require explicit repository-script and network grants and should be enabled only for trusted repositories. Isolation protects the original Git worktree from ordinary edits but is not a host sandbox against absolute-path access or child processes.
- The child environment excludes credentials known to Conclave, but a hostile repository process may still discover host information through operating-system interfaces. Default-deny repository-code execution remains the safe mode.
- The local web server has no authentication, multi-user session boundary, rate limiting, hosted request controls, or remote-path defense because it is loopback-only. Do not expose it through a reverse proxy or public network without a dedicated hosted security design.
- Root ignore-file support does not yet reproduce nested Git ignore semantics.
- Files can change during a scan. Symlink and canonical-path checks narrow traversal risk but do not provide an immutable filesystem snapshot.
- JSON storage is owner-readable and atomic but not encrypted, multi-process safe, or suitable for credentials.
- The code index contains non-secret repository source in plaintext with owner-only permissions; repository filesystem access still grants index access.
- No hosted HTTP surface exists yet, so authentication, request-size controls, CSRF/CORS policy, and rate limiting are not implemented.

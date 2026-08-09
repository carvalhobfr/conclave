# Security boundaries

Repositories are sensitive and their contents are untrusted. Phase 1 establishes the following enforceable boundaries.

## Credentials

- Provider credentials are read from process environment variables through `CredentialSource`.
- Serializable runtime configuration stores only the environment-variable reference.
- Credentials are held in a private field inside the HTTP adapter and are only placed in the outbound authorization header.
- Provider URLs containing usernames or passwords are rejected.
- External provider endpoints must use HTTPS.
- The JSON app-state store is not a credential store.

The loopback web backend keeps provider creation and credential access server-side.

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
- Project Knowledge direct answers use only validated index data and extracted/resolved graph provenance. Model-inferred relationships cannot satisfy deterministic verification.
- The deterministic pre-router and depth presets can reduce work but cannot raise hard ceilings or change repository, provider, credential, or Task authority.
- A configured Conductor may propose only a strict reasoning plan. Unknown fields, provider endpoints, model identities, permissions, and budget increases are rejected; the host remains authoritative.
- Model capability profiles are host/user configuration. Explicit assignments are authoritative while healthy, and fallback is disabled unless the host explicitly enables it.
- Cancellation and depth-aware timeouts propagate to provider fetches. Public snapshots contain structured claims and evidence only, never hidden model reasoning.

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

## Review and Decision Validation

- Review consumes a typed `ChangeSet`; it does not grant model filesystem, Git, command, patch, or Task authority. Git is invoked by the host with `spawn`, shell disabled, fixed arguments, validated refs, a 20-second timeout, and a 2 MB output bound.
- Working-tree, staged, branch, and commit comparison discover changed paths first. Sensitive repository paths are excluded before diff content is read. Their paths and the resulting uncertainty are reported, but their contents never enter evidence, prompts, traces, UI, or handoffs.
- Explicit diff input is bounded to 2 MB. Diff paths are normalized and traversal-shaped paths are rejected by deterministic parsing.
- Concrete secret detection stops adaptive Review before model reasoning. Findings contain only secret type, path/range, and redacted evidence. Complete detected credentials are not retained in Review evidence or revision handoffs.
- Deterministic Review status preserves semantics: no diff is not approval; malformed input is invalid; exclusions and unresolved runtime behavior preserve uncertainty; blockers request changes.
- Changed-symbol and graph-impact traversal is bounded. A truncated traversal is exposed as uncertainty rather than silently treated as complete coverage.
- Decision Validation decomposes proposal text into typed Claims. Deterministic symbol and graph checks override model conclusions; unsupported or contradicted assumptions cannot be upgraded by agreement between roles.
- Review and Decision reuse the Phase 8 reasoning roles and provider boundary. Neither workflow introduces a model with direct Git or implementation authority.

## Local web application

- The product server binds to `127.0.0.1`; it is not a public hosted API surface.
- Browser requests are display/application requests only. The browser never receives provider credentials, raw repository index state, arbitrary filesystem authority, direct command execution, or direct patch authority.
- Local folder opening is canonicalized and restricted to `CONCLAVE_WEB_ALLOWED_ROOT` (or the server working directory by default). Browser-provided paths outside that boundary are rejected.
- Browser folder import removes environment files, private keys, and common credential files before reading file contents. The server repeats the same case-insensitive path check before writing an imported file, and local ingestion repeats it before filesystem reads. `.env.example` is allowed as documentation but still passes through content-level secret detection.
- API JSON bodies are capped at 64 KB, except bounded repository import (20 MB) and explicit Review diff (2.5 MB envelope / 2 MB diff) endpoints. API errors are converted to concise product-safe messages rather than provider headers, credentials, or stack traces.
- The server-owned Free credential is read only by the local server process and is never sent to the browser, diagnostics, logs, role assignments, or the settings file.
- Personal provider sets deliberately store a user's own key in the owner-only local settings file (`0600`). The API never returns the key, and an active personal set overrides `.env` without gaining access to the server-owned Free credential. The file is not encrypted and should be protected like any local credential file.
- Demo Mode uses a bundled repository fixture and FakeProvider responses labelled as deterministic demo inference. It does not represent a configured remote provider or hosted Free service.
- Task permission controls request the existing Task Mode flags only. The core policy remains the authority for every patch and command capability; the UI cannot construct an approved command or apply a patch to the original repository.
- Ask, Investigate, and Task browser jobs own server-side abort controllers. Cancellation reaches provider and approved child-process work; Task execution continues to use and clean an isolated workspace.
- Adaptive aggregate metrics are process-local and contain counts, token estimates, and rates. They are not transmitted to an analytics service.

## Residual risks

- Pattern-based secret detection has false positives and false negatives.
- Prompt injection cannot be eliminated solely through delimiters and instructions; later structured outputs and evidence validation remain necessary.
- Node tests and package scripts execute repository code. Because portable child-process filesystem and network isolation is unavailable, they require explicit repository-script and network grants and should be enabled only for trusted repositories. Isolation protects the original Git worktree from ordinary edits but is not a host sandbox against absolute-path access or child processes.
- The child environment excludes credentials known to Conclave, but a hostile repository process may still discover host information through operating-system interfaces. Default-deny repository-code execution remains the safe mode.
- Free Mode has host-controlled model allowlisting, a provider-neutral usage gate, a fixed-window request quota, and an in-process concurrency limit at the product-service boundary. Personal BYOK sets do not consume the host Free quota.
- The local web server still has no authentication or multi-user session boundary. Its usage and concurrency state is process-local and keyed to the loopback client boundary, so it must not be exposed through a reverse proxy or public network without durable identity, distributed quotas, abuse controls, and a dedicated hosted security design.
- Root ignore-file support does not yet reproduce nested Git ignore semantics.
- Files can change during a scan. Symlink and canonical-path checks narrow traversal risk but do not provide an immutable filesystem snapshot.
- The personal-settings JSON deliberately stores user-supplied provider keys with owner-only permissions, but it is not encrypted or multi-process safe. It is suitable only for this single-user local product boundary and must be protected like any local credential file.
- The code index contains non-secret repository source in plaintext with owner-only permissions; repository filesystem access still grants index access.
- No public hosted HTTP surface exists yet. Authentication, durable/distributed quotas, billing, CSRF/CORS policy for public origins, and remote-repository defenses remain outside this phase.

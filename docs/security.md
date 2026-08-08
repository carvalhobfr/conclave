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

## Residual risks

- Pattern-based secret detection has false positives and false negatives.
- Prompt injection cannot be eliminated solely through delimiters and instructions; later structured outputs and evidence validation remain necessary.
- Root ignore-file support does not yet reproduce nested Git ignore semantics.
- Files can change during a scan. Symlink and canonical-path checks narrow traversal risk but do not provide an immutable filesystem snapshot.
- JSON storage is owner-readable and atomic but not encrypted, multi-process safe, or suitable for credentials.
- The code index contains non-secret repository source in plaintext with owner-only permissions; repository filesystem access still grants index access.
- No hosted HTTP surface exists yet, so authentication, request-size controls, CSRF/CORS policy, and rate limiting are not implemented.

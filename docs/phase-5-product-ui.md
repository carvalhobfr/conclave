# Phase 5 — Product and Web UI

Phase 5 makes the existing Conclave core usable as a local developer product. It does not redesign the reasoning or execution engines and does not grant browser code direct filesystem, provider, process, or repository-mutation authority.

## Architecture

```text
Browser (React/Vite)
        ↓ bounded JSON display DTOs
Local Conclave web server (127.0.0.1)
        ↓ application services
Existing indexing, retrieval, reasoning, graph, and task core
```

The web server is the only product component that opens folders, reads server environment configuration, constructs providers, or invokes Task Mode. It has a 64 KB JSON request limit, sanitizes errors, serves only loopback traffic, and allows local folders only beneath `CONCLAVE_WEB_ALLOWED_ROOT` (the process directory is the conservative default).

## Local workflow

```bash
npm install
npm run build
npm run start:web
```

Open `http://127.0.0.1:4317`. For frontend development, run `npm run dev:web` in a second terminal; it proxies API calls to the local server. To open local repositories outside the Conclave checkout, start the server with an explicit allowed root:

```bash
CONCLAVE_WEB_ALLOWED_ROOT=/Users/you/Dev npm run start:web
```

No remote Git import is presented as available.

## Product surfaces

- **Ask** runs the lightweight Investigator + Judge route for evidence-backed repository questions. The role route shows skipped agents rather than pretending all roles ran.
- **Investigate** runs the bounded Conclave route and preserves supported, rejected, and uncertain hypotheses alongside evidence and verification counts.
- **Task** is explicit. It starts in plan-only mode and displays the objective, verified plan, expected files, permissions, engine events, review/revision progress, checks, verdict, and final isolated diff.
- **Evidence** opens exact source excerpts with canonical path and line range.
- **Graph** scopes exploration to a symbol and its bounded neighbors. It does not attempt to render the entire repository graph.
- **Retrieval** reports executed/skipped operations, evidence count, source bytes, and approximate context tokens.

## Provider modes and roles

The UI renders the server’s existing Free/API/Local conceptual mode. Configuration remains environment-driven and server-side; the browser never stores plaintext provider credentials. If no supported provider is configured, live runs return a clear configuration error and Demo Mode remains available.

Existing reasoning presets and role assignments remain authoritative. The UI shows actual per-run role routing and uses configured assignments for live runs. Phase 5 intentionally does not add a browser-side credential form, unsupported provider cards, or persisted advanced role overrides.

## Task safety UX

Task permissions are request inputs, never browser authority:

```text
Browser requests permissions
        ↓
Conclave Task Engine policy validates every capability
        ↓
structured runner, where permitted
        ↓
process executes in the isolated workspace
```

File edits, static checks, repository scripts, and network are default-deny. Repository scripts are visibly marked as executing repository code without a portable full sandbox. The application does not apply the resulting patch to the original repository, commit, push, reset, or open a pull request.

## Demo Mode

The bundled `demo/auth-repository` is a deterministic auth-lifecycle fixture. Demo Mode uses explicit fake-provider responses while running the real indexing, retrieval, reasoning, Task planning, isolated worktree, patch, revision, and verification code. The interface states that this is demo inference, not live AI.

It demonstrates:

- Ask: `Where is bootstrapSession called?`
- Investigate: `Why might authentication disappear after refresh?`, including a rejected persistence hypothesis and graph follow-up.
- Task: `Fix authentication disappearing after refresh.`, including a bad first patch, revision, verified final patch, and completed verdict.
- A `completed-with-uncertainty` demo can be requested by appending `Keep runtime behavior uncertain.` to the Task objective; source requirements remain verified while the Reviewer retains runtime uncertainty.

## Validation

`npm run test:web` runs DOM-level intent, permissions, warning, claim-status, and evidence-navigation checks. `tests/web-product-service.test.ts` covers the actual deterministic API service for Ask, Investigate, Task plan-only, isolated task execution, final diff, uncertainty, graph evidence, and local-folder denial.

Phase 5 does not add hosted execution, persistence/history, patch application, MCP, autonomous sessions, or remote cloning. Those remain deliberate boundaries for later phases.

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

- **Ask** queries Project Knowledge first and can return a cited static answer with zero model calls. Model roles run only when semantic interpretation remains necessary.
- **Investigate** runs an adaptive bounded route and preserves supported, rejected, and uncertain hypotheses alongside evidence and verification counts.
- **Review** validates working-tree, staged, branch, commit, or explicit-diff ChangeSets through Project Knowledge and the adaptive reasoning path. Structurally proven results can use zero model calls.
- **Decide** decomposes a proposal into claims, challenges assumptions against repository evidence, and generates an implementation or revision handoff.
- **Task** is explicit. It starts in plan-only mode and displays the objective, verified plan, expected files, permissions, engine events, review/revision progress, checks, verdict, and final isolated diff.
- **Analysis depth** keeps intent separate from Auto, Fast, Balanced, and Deep reasoning budgets. Auto is the default.
- **Progress and cancellation** expose semantic engine events and evidence-backed snapshots. Cancellation aborts pending provider/command work instead of merely hiding a spinner.
- **Evidence** opens exact source excerpts with canonical path and line range.
- **Graph** scopes exploration to a symbol and its bounded neighbors. It does not attempt to render the entire repository graph.
- **Retrieval** reports executed/skipped operations, evidence count, source bytes, and approximate context tokens.

## Provider modes and roles

The UI presents four honest configuration strategies: local Ollama/LM Studio, the host's Free configuration, BYOK OpenAI/OpenRouter, and a custom OpenAI-compatible endpoint. OpenRouter requires the user's own key even for currently free models, and provider availability, quotas, and data handling remain provider-controlled. Local inference keeps repository reasoning on the machine only when embeddings are local too.

Environment configuration remains read-only in the browser. Personal provider sets are persisted by the local server in an owner-only settings file; plaintext credentials are never returned in settings responses. If no supported provider is configured, live runs return a clear configuration error and Demo Mode remains available.

Ready-made profiles are the normal path. Advanced routing optionally assigns a provider and model independently to each role, grouped as reasoning roles (Investigator, Skeptic, Architect, Verifier, Judge) and Task roles (Planner, Implementer, Reviewer). First-class Review consumes the reasoning roles through the Phase 8 adaptive path; it does not create a second fixed Reviewer pipeline.

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

The bundled `demo/auth-repository` is a deterministic auth-lifecycle fixture. Demo Mode uses explicit fake-provider responses while running the real indexing, retrieval, reasoning, Task planning, isolated worktree, patch, revision, and verification code. Direct Ask and Review examples also demonstrate that Project Knowledge can produce a valid result with zero model calls. The interface distinguishes these deterministic paths from fake provider-assisted demo paths.

It demonstrates:

- Ask: `Where is bootstrapSession called?`
- Investigate: `Why might authentication disappear after refresh?`, including a rejected persistence hypothesis and graph follow-up.
- Task: `Fix authentication disappearing after refresh.`, including a bad first patch, revision, verified final patch, and completed verdict.
- A `completed-with-uncertainty` demo can be requested by appending `Keep runtime behavior uncertain.` to the Task objective; source requirements remain verified while the Reviewer retains runtime uncertainty.

## Validation

`npm run test:web` runs DOM-level intent, validation workspaces, model strategies, role grouping, permissions, warnings, claim status, and evidence-navigation checks. `tests/web-product-service.test.ts` covers the deterministic API service for Ask, Investigate, Review, Decide, Task plan-only, isolated task execution, final diff, uncertainty, graph evidence, and local-folder denial.

Phase 5 does not add hosted execution, persistence/history, patch application, MCP, autonomous sessions, or remote cloning. Those remain deliberate boundaries for later phases.

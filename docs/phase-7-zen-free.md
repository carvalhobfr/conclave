# Phase 7 — OpenCode Zen Free Mode

Phase 7 turns Free Mode into a real, end-to-end OpenAI-compatible configuration while keeping the hosted work deliberately at foundation level. It does not publish a service, add remote Git import, add native Anthropic/Gemini protocols, or expose Task Mode through MCP.

## Provider contract

The default external endpoint is `https://opencode.ai/zen/v1`; the existing adapter appends `chat/completions`. The current host defaults use these exact model IDs:

| Role | Default model |
| --- | --- |
| Investigator | `deepseek-v4-flash-free` |
| Skeptic | `nemotron-3-ultra-free` |
| Architect | `nemotron-3-ultra-free` |
| Verifier | `deepseek-v4-flash-free` |
| Judge | `nemotron-3-ultra-free` |
| Planner | `nemotron-3-ultra-free` |
| Implementer | `north-mini-code-free` |
| Reviewer | `deepseek-v4-flash-free` |

These IDs and availability are provider-controlled and can change. The host can update `CONCLAVE_FREE_MODEL_ALLOWLIST` and the role variables without changing domain code. See the [OpenCode Zen documentation](https://opencode.ai/docs/zen) for the current provider catalog and API contract.

## Configuration and inheritance

Free Mode reads the credential exclusively from `CONCLAVE_FREE_API_KEY`. Runtime configuration stores only that environment-variable reference. Each effective role assignment contains a provider ID and model ID, then inherits the active mode's validated base URL, timeout, and credential source when its adapter is constructed. This means a role override cannot accidentally fall back to the public OpenAI endpoint and credentials are not duplicated into serializable role state.

Within the environment profile, a role-specific provider/model variable has priority over the Free fallback. In the product UI, an active personal provider set has priority over the complete `.env` profile. Personal sets require their own keys for remote connections; the locked Free profile and server-owned key cannot be selected or copied into a personal set.

The Free allowlist is checked when runtime and role configurations load, and again at the product-service execution boundary. Unknown models fail closed before provider inference. API Mode and Local Mode retain their own provider/model/base URL and credential rules, so their settings cannot bleed into Free Mode.

Embeddings remain a separate subsystem. The default `feature-hash` mode is deterministic and offline; a learned OpenAI-compatible embedding endpoint must be configured explicitly.

## Hosted foundation

The foundation is provider-neutral:

- `UsageGate` is an asynchronous authorization interface, currently backed by a deterministic in-memory fixed-window implementation.
- `FreeUsageController` enforces the host model allowlist, request authorization, and a global in-process concurrency ceiling.
- Ask, Investigate, and Task runs enter this controller at the product-service boundary before any live Free inference.
- Personal BYOK sets bypass host-funded Free usage, while all core reasoning and Task safety invariants remain unchanged.

Defaults are 20 runs per one-hour process-local window and two concurrent runs. They can be configured with `CONCLAVE_FREE_REQUESTS_PER_WINDOW`, `CONCLAVE_FREE_WINDOW_MS`, and `CONCLAVE_FREE_MAX_CONCURRENCY`.

This is not production hosting. There is no user identity, durable or distributed quota, billing, public-origin policy, or abuse system. A future hosted deployment can replace `UsageGate` without changing reasoning or Task engines.

## Diagnostics and smoke tests

`conclave provider-check` runs one bounded inference and reports mode, provider, endpoint host, exact default model, and all effective reasoning/Task assignments. It never includes the credential.

```bash
npm run dev -- provider-check
npm run test:zen
CONCLAVE_ZEN_FULL_SMOKE=1 npm run test:zen
```

`test:zen` skips successfully when `CONCLAVE_FREE_API_KEY` is absent. With a credential it performs the bounded provider diagnostic; the opt-in full smoke also indexes the committed fixture and exercises a real reasoning flow. Neither path prints the key.

## Privacy warning

Free Mode uses external inference. Conclave retrieves and packs context locally, but the selected repository excerpts used for reasoning may be transmitted to OpenCode Zen. Secret-like files are blocked, context is bounded, and repository content is labelled untrusted, but those controls do not turn an external inference flow into a local one. Use Local Mode when repository content must remain on the machine.

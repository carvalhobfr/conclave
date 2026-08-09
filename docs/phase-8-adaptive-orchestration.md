# Knowledge-first adaptive orchestration

Conclave builds local structural knowledge before asking models to reason. Repository opening produces a reusable code index, static relationship graph, retrieval indexes, and provenance-backed evidence lookup. Questions query that representation first; they do not rebuild the graph or ask a model to rediscover the repository.

```text
open or update repository
  -> safe ingestion
  -> structural parse + hashes
  -> lexical/feature indexes + resolved graph
  -> Project Knowledge ready

question
  -> deterministic assessment
  -> direct graph/evidence answer, when sufficient
  -> otherwise the smallest bounded reasoning route
```

This is an index-once, query-many design. Reopening an unchanged repository reuses file units, embedding vectors, and the immutable graph edge set. Content-hash changes reparse only added or changed files and remove deleted units. The current graph builder still recomputes the graph after any structural content change so cross-file import resolution remains deterministic; it does not rebuild per question.

## Project Knowledge and direct answers

`ProjectKnowledge` is a facade over the existing `RepositoryCodeIndex`, `CodeIndexReader`, graph queries, and retrieval service. It does not duplicate or serialize repository state. It exposes repository/version identity and actual file, symbol, node, and edge counts.

The deterministic pre-router recognizes exact definitions, callers, callees, references, imports, exports, and bounded paths. A direct result retains exact source evidence, extracted/resolved edge provenance, ambiguity, and static-analysis limitations. Auto and Fast may return this result with zero model calls. Balanced or Deep can be forced when the user wants analysis beyond an otherwise direct lookup.

For questions that are not directly answerable, the assessment records explainable signals: query kind, resolved entities and paths, relevant modules, causal or security-sensitive language, ambiguity, graph coverage, and whether model reasoning is necessary. It never invents a confidence percentage.

## Analysis depth

- **Auto** chooses the smallest useful route from deterministic evidence. This is the default interactive setting.
- **Fast** targets zero to two model calls, one reasoning round, a short provider timeout, and no automatic tribunal. Insufficient results remain uncertain and suggest deeper analysis.
- **Balanced** permits a moderate number of calls and retrievals, with structural or adversarial roles selected only when the evidence requires them.
- **Deep** permits the existing hard reasoning ceiling, a longer provider timeout, and more aggressive adversarial review.

Depth presets can only lower existing hard limits. They cannot expand retrieval, token, Task, filesystem, command, or network authority. Provider-call timeouts are 12 seconds for Fast, 35 seconds for Balanced, and 60 seconds for Deep; configured provider ceilings remain authoritative.

## Conditional planning and roles

The host creates a deterministic `ReasoningPlan` for every model-assisted run. It specifies a bounded strategy, required or conditional roles, capability requirements, final-review policy, and concise reason codes.

The Conductor is optional. It runs only for high-ambiguity requests that require model reasoning and only when a Conductor assignment is configured. It receives a compact structural assessment and budget/provider availability—not a repository source dump. Its strict output cannot name endpoints, grant permissions, expand budgets, select arbitrary models, or bypass deterministic verification. Invalid or unavailable Conductor output falls back to the deterministic host plan.

Role selection follows current evidence:

- Investigator forms testable claims only when semantic interpretation is needed.
- Skeptic challenges causal, ambiguous, conflicting, or explicitly Deep work.
- Architect joins cross-module, lifecycle, or Deep routes.
- deterministic verification runs first; the model Verifier sees only unresolved claims.
- Judge runs for meaningful challenges or competing claims, forced Deep review, or the explicit legacy comparison route. It is skipped when material claims are already resolved.

Sufficiency is deterministic and inspectable: material claims must be resolved by deterministic checks, critical retrieval requests must be complete, and no ambiguity or contradiction may remain that affects the conclusion. When those conditions hold, the trace records an early-exit reason instead of running unused roles.

## Capability-based model selection

Roles and requirements remain separate from models. `ModelSelector` matches a role's reasoning, coding, speed, context, independence, and cost requirements against configured `ModelProfile` records. Profiles are host/user data supplied through `CONCLAVE_MODEL_PROFILES_JSON`; reasoning policy contains no permanent claims about named model quality.

Explicit per-role assignments win while available. The in-memory health tracker records a small rolling window of successes, failures, and latency. It can mark a model degraded or temporarily unavailable, but it never overrides a healthy explicit assignment. Fallback requires both configured eligible profiles and `CONCLAVE_MODEL_FALLBACK_POLICY=configured`; the default is disabled. Routing and any fallback are included in Technical details.

## Partial results, timeout, and cancellation

Reasoning emits safe snapshots containing only structured claims, evidence, provisional conclusions, and remaining checks. It never emits private chain-of-thought. Browser runs retain the latest snapshot while active, cancelling, timed out, or complete.

Cancellation travels from the browser's DELETE request through the product job's `AbortController`, reasoning or Task engine, retrieval checkpoints, role runtime, provider request, and structured command runner. A cancelled reasoning run preserves already verified evidence and labels incomplete claims. Task cancellation stops before the next mutation boundary, terminates approved child work where applicable, cleans the isolated workspace, and never applies partial work to the original repository.

An optional role timing out does not erase an evidence-supported partial verdict. The final status is `timed-out`, remaining checks stay visible, and provisional findings are not upgraded to complete.

## Product and measurement

The main result presents Conclusion, main evidence, rejected hypotheses, remaining uncertainty, and a suggested next action. Analysis depth, routing explanations, role/model selection, provider latency, deterministic operations, total model calls, cumulative input/output context, retrieval rounds, and early-exit reasons live under Technical details.

The service keeps process-local aggregate metrics for mean/median model calls and cumulative input context by requested depth, plus cancellation, early-exit, deterministic-answer, and Conductor-invocation rates. `GET /api/metrics/adaptive` returns this ephemeral view. No analytics are sent externally.

`npm run eval:adaptive` compares Auto with the preserved full-style route on unchanged fixtures using deterministic delayed providers. It checks correctness, rejected-claim behavior, roles, total calls, cumulative context, and wall-clock latency. It is a regression benchmark, not a provider response-time promise.

## Boundaries and limitations

- Static graph results do not prove dynamic dispatch, reflection, framework wiring, runtime configuration, or unresolved alias behavior.
- Changed content still causes a deterministic full graph-edge recomputation; affected-edge incremental graph mutation remains a future profiling-driven optimization.
- Independent review is recommended and a portable challenge-oriented handoff is generated when risk or uncertainty warrants it. Automatic cross-model review is only possible where a suitable configured role/model exists.
- Capability profiles describe user/host configuration, not objective model rankings. Provider availability and latency can change.
- Phase 8 remains code-focused. It adds no PDF/OCR pipeline, inferred semantic graph facts, hosted deployment, remote Git import, background workers, or MCP mutation.

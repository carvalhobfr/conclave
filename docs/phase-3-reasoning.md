# Phase 3 — Conclave Reasoning Engine

Phase 3 consumes the Phase 2/2.5 `PlannedRetrieval` and `ContextBundle` APIs. It does not grant agents direct filesystem, shell, Git, or repository mutation access.

## State and orchestration

`ReasoningEngine` owns one explicit `ReasoningCaseState` per question:

```text
question + initial retrieval
  -> Investigator claims
  -> deterministic routing
  -> optional Skeptic / Architect challenges
  -> validated, deduplicated follow-up requests
  -> deterministic checks, then model Verifier only for unresolved claims
  -> Judge adjudication
  -> deterministic verdict synthesis
```

Agents exchange validated JSON conclusions. They do not receive one another's hidden transcripts, and no chain-of-thought is persisted. Claim, challenge, request, and verification identifiers are stable hashes of their structured inputs.

## Role and provider separation

Roles determine prompts and output schemas. `AgentAssignment` independently selects `providerId` and `modelId`. The same provider/model may fill every role, as in Local Mode, or a host may register different providers. The engine contains no model-name-to-role mapping.

`StructuredAgentRuntime` requests JSON, uses temperature zero, validates every reference against known claim/evidence/edge IDs, and permits at most the configured number of repair calls. Malformed output or provider failure never enters case state.

## Selective routing

The deterministic router uses question shape, claim uncertainty, represented files, and cross-module graph context:

- Investigator, Verifier, and Judge are selected for normal Conclave runs.
- Skeptic is selected for causal/lifecycle questions or uncertain claims.
- Architect is selected for causal, cross-module questions in full/local presets.
- The free-like preset avoids Architect calls.

Every selection or skip includes an inspectable reason.

## Follow-up retrieval and verification

Agents can request only typed operations exposed by `CodeRetrievalService`: exact symbol/text, references, callers, callees, shortest path, or bounded search. Equivalent requests are deduplicated. Limits cap rounds, requests, repeated keys, evidence, graph depth, model calls, approximate input tokens, repairs, and output tokens.

Claims may include a deterministic check and an expected presence/absence result. Verification prioritizes exact and graph operations. A deterministic rejection overrides model Verifier and Judge agreement. Claims without deterministic resolution can use the model Verifier and remain explicitly uncertain.

The final answer is generated from supported and clearly labeled uncertain claims. Rejected claims are excluded. Evidence references include repository path and exact line range; symbols remain available in the structured Verdict.

## Context and injection boundaries

Each role receives only its task slice. Repository excerpts are enclosed in explicit untrusted-data markers, while role instructions and adjudication records use separate trusted markers. Source text cannot change provider selection, budgets, permissions, or role behavior.

The Judge receives claims, challenges, and verification records—not cumulative agent conversation. Approximate input/output tokens are tracked per role and in aggregate.

## Observability

`ReasoningResult` includes:

- the structured Verdict and complete case state;
- selection, claim, retrieval, verification, budget, and completion trace events;
- per-role provider/model IDs, calls, approximate tokens, provider-reported usage, and latency;
- retrieval rounds, follow-up count, deterministic operations, evidence count, and final claim counts;
- a termination reason: completed, budget exhausted, no progress, or agent failure.

Trace records retain concise decisions and engineering metadata, never hidden reasoning.

## Evaluation

The fixed auth fixture includes a deliberately plausible but wrong claim: “The token is never persisted.” Follow-up caller retrieval finds `completeLogin -> persistToken`, so deterministic verification rejects it. A separate missing restoration path supports the surviving bootstrap explanation. The final answer contains the supported claim and exact source reference but not the rejected statement.

The Phase 3 harness compares single-pass, Investigator + Judge, and Conclave modes on the same cases. Scripted fake providers keep CI deterministic; configured-provider evaluation is optional and separate.

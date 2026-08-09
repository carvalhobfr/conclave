# Validation-first Review and Decision

Phase 9 makes validation a first-class product surface. It builds on the Phase 8 adaptive foundation; it does not create a fixed Review-agent pipeline.

```text
ChangeSet
  -> Project Knowledge
  -> deterministic diff, symbol, safety, and bounded impact analysis
  -> adaptive reasoning only where repository semantics remain unresolved
  -> deterministic verification
  -> ReviewVerdict

Proposal
  -> explicit Claims
  -> Project Knowledge
  -> challenge assumptions and consequences
  -> deterministic verification
  -> DecisionVerdict
```

## Structured ChangeSets

`GitChangeSetService` creates immutable, identified ChangeSets from:

- the working tree relative to `HEAD`, including safe untracked files;
- the staged index;
- a three-dot base/head branch comparison;
- a base/target commit comparison;
- an explicit unified diff.

Git refs are validated, subprocesses use fixed argument vectors with no shell, and output/path counts are bounded. Sensitive paths are removed before diff content is loaded. A verdict exposes those excluded paths as uncertainty rather than pretending the review was complete.

## ReviewVerdict semantics

Review status is about the supplied ChangeSet, not model-call count:

- `approved` means available deterministic and/or adaptively verified evidence found no material defect in a substantive change;
- `changes-requested` requires at least one concrete blocking repository consequence;
- `uncertain` preserves a material unresolved risk or excluded scope;
- `nothing-to-review` means no substantive change was supplied and is not implementation approval;
- `invalid` means the diff is malformed or incomplete enough that no implementation conclusion is valid.

Deterministic blockers include added merge-conflict markers and concrete credential/private-key formats. Secret evidence is redacted before it can reach a trace, UI, prompt, or handoff.

Documentation-only changes can be approved when their objective is documentation-compatible and bounded diff safety checks pass. A positive code fixture proves a stronger zero-call case: an added, parser-clean, type-only contract whose changed symbols have no runtime graph relationships. Semantic runtime changes use `intent: "review"` through the existing adaptive planner and conditional Investigator, Skeptic, Architect, Verifier, and Judge roles.

## Concrete findings and low-noise policy

`ReviewFinding` separates blocking findings, warnings, and suggestions. Every finding has a statement and a concrete consequence. Generic DRY, KISS, SOLID, or architecture slogans are not findings. A legitimate design choice is not rejected merely because another design is possible.

The verdict separately exposes:

- confirmed properties and how they were confirmed;
- unresolved uncertainty and affected paths;
- changed symbols resolved from actual parser/index ranges;
- bounded incoming/outgoing graph impact;
- traversal limitations and truncation;
- a redacted revision handoff only when revision is useful.

The deterministic impact ceiling is 100 changed symbols, 100 impacted symbols, and 250 graph edges. Reaching a ceiling produces explicit uncertainty.

## Decision Validation

`ReasoningEngine.decide(...)` decomposes a proposal into goal, assumption, constraint, and consequence Claims. Exact repository facts such as symbol existence, caller absence, and a caller relationship can be resolved with zero model calls. Broader architectural or behavioral claims use `intent: "decide"` through the Phase 8 adaptive path.

`DecisionVerdict` returns `proceed`, `revise`, `uncertain`, or `invalid`, together with supported/rejected/uncertain Claims, confirmed properties, challenged assumptions, evidence, metrics, and analysis routing. A supported decision produces an implementation handoff that retains the verified objective and asks implementation to re-run first-class Review. A contradicted or unresolved decision produces a revision handoff naming the claims that must change or become testable.

Decision Validation does not execute the proposal. Task remains the explicit mutation surface with its existing permissions and isolation.

## Product surface

The local web app includes dedicated Review and Decide workspaces. Review can select working tree, staged changes, branches, commits, or an explicit diff and shows findings, confirmed properties, uncertainty, changed symbols, impact, route, calls, and revision handoff. Decide accepts proposal and objective text and shows decomposed Claims plus implementation/revision handoff.

The local API exposes `POST /api/review` and `POST /api/decide`. Credentials, complete index state, and secret contents remain server-side.

## Evaluation

Run:

```bash
npm run eval:review
npm run eval:decision
npm run eval:validation
```

Review evaluation includes known-good documentation and code changes, deterministic blockers, and an adaptive missed-regression case. It measures status accuracy, false-positive rate, missed-regression rate, zero-model approvals, adaptive coverage, and generic-slogan findings. Decision evaluation measures status and claim resolution, zero-model and adaptive cases, and implementation/revision handoff generation.

The fixtures deliberately do not optimize zero-call rate. They require zero calls only where structural evidence supports a semantically correct result.

## Remaining limitations

- Static impact cannot prove runtime behavior involving dynamic dispatch, reflection, generated code, framework wiring, external systems, or configuration outside indexed safe files.
- Secret detection is pattern-based and has false positives and false negatives; sensitive-path exclusion remains a separate defense.
- Documentation approval validates bounded structure and safety, not prose truth.
- Type-only deterministic approval is intentionally narrow. Ordinary code changes require adaptive validation unless a future deterministic proof rule is both concrete and regression-tested.
- Git review is local and read-only. Phase 9 does not clone remote repositories, publish reviews, apply handoffs, or mutate the source repository.

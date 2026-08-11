# Super-validator design

## Product invariant

Conclave validates a resolution independently of the actor that produced it.

A model statement is never completion evidence. A successful model call is never a passing check. Timeout, missing evidence, ambiguous graph resolution, and unsupported analysis must remain visible and can never be silently converted to success.

## Inputs

A validation run has three explicit inputs:

- a Git change source: working tree, staged index, branch range, or checked-out commit;
- an objective describing the behavior the resolution is meant to deliver;
- an optional validation contract containing scope and deterministic completion claims.

The collected patch remains local in the deterministic gate. Reports expose patch byte size, changed files, hunks, and evidence, but not the complete patch.

## Project and impact graph

The current repository index supplies file and symbol nodes plus typed relations:

- symbol ownership and containment;
- imports and exports;
- references and calls;
- inheritance and implementation.

Changed line ranges are mapped to current symbols. Validation starts from changed files and symbols, then traverses a bounded graph to identify unchanged consumers and contracts outside the diff.

Missing edges mean unresolved static knowledge, not proof that no runtime relation exists.

## Validation contract

The contract is Conclave's concrete quality bar. It must describe facts that can be checked against actual artifacts.

```ts
interface ValidationContract {
  objective: string;
  allowedPathPrefixes: readonly string[];
  claims: readonly ValidationClaim[];
}
```

Claims use typed checks instead of free-form model agreement. A contradicted claim blocks. A claim whose target cannot be resolved is inconclusive.

## Challenge order

1. Git and scope invariants.
2. Parser and index health.
3. Changed-symbol mapping.
4. Graph impact outside the diff.
5. Public/exported behavior and test evidence.
6. Deterministic completion claims.
7. Bounded semantic challenge, once patch redaction and base/head evidence are available.

Deterministic findings must be preserved if a later semantic pass fails or times out.

## Verdict semantics

- `PASS`: all available required checks support the resolution.
- `WARN`: no contradiction, but evidence identifies reviewable risk.
- `BLOCK`: deterministic evidence contradicts the resolution or its allowed scope.
- `INCONCLUSIVE`: the system lacks enough trustworthy evidence to decide.

The semantic difference between `WARN` and `INCONCLUSIVE` is proof availability. Warning means known risk; inconclusive means the required fact could not be established.

## Gauntlet Loop influence

The design is informed by [robonuggets/gauntlet-loop](https://github.com/robonuggets/gauntlet-loop), licensed CC BY 4.0 and credited to Jay E / RoboNuggets, with the underlying technique credited there to Matt Shumer.

Conclave uses the ideas of a real comparison bar, independent harsh criticism, actual-output inspection, and a single largest remaining gap. It does not copy the prompt and does not adopt unbounded iteration.

For code validation:

| Gauntlet Loop | Conclave |
| --- | --- |
| Named, fetchable bar | Objective, contract, tests, base behavior, repository invariants |
| Separate builder and critic | Writer-independent validator |
| Blind A/B comparison | Base/head and claim/evidence comparison |
| Biggest remaining gap | Highest-severity actionable finding |
| Loop until ours wins | Bounded challenge; unresolved work is inconclusive |

## Next hardening steps

1. Index both base and head so removed symbols and call paths are first-class evidence.
2. Add type-checker and `tsconfig` resolution.
3. Run safe, permissioned checks and bind their results to the report.
4. Add redacted, bounded semantic challenges with fresh context.
5. Fingerprint findings across reruns and preserve deterministic findings.
6. Measure finding precision, false positives, wall time, model usage, and termination reason on real PRs.

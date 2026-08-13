# Validation report contract

The runner emits Conclave validation report schema v1. The canonical JSON Schema is `schemas/validation-report.v1.schema.json` in the Conclave distribution.

## Verdict and exit code

| Verdict | Exit | Interpretation |
| --- | ---: | --- |
| `pass` | 0 | No deterministic blocker or warning was found. This is bounded evidence, not a proof of all runtime behavior. |
| `warn` | 0 | The review completed, but one or more risks require attention. |
| `block` | 1 | A contradiction, scope violation, parser failure, or other deterministic blocker exists. |
| `inconclusive` | 2 | Available evidence cannot honestly prove the resolution. |

Runner errors use exit code 3 and do not constitute a Conclave verdict.

## Required interpretation

- `summary`: machine-produced executive result.
- `findings`: ordered evidence-backed risks. Prefer `blocking`, then `warning`, then `info`.
- `claims`: each declared completion claim is `supported`, `rejected`, or `inconclusive`.
- `impact`: changed symbols plus graph-reachable files and symbols, including unchanged consumers.
- `metrics`: bounded deterministic work performed; model calls are not implied.
- `trustBoundary`: exact reasoning-model and repository-script call counts, plus the parser, graph, and embedding strategy used to build validation knowledge.
- `changeSet`: exact comparison source and HEAD identity. The patch is represented by its byte count, not embedded in the report.
- `workspace` source: the merge-base-to-current-workspace comparison, including committed, staged, unstaged, and untracked files.

Do not infer evidence that is absent from these fields. A `pass` means the implemented deterministic checks passed; it does not mean arbitrary runtime, UX, security, or business behavior was executed.

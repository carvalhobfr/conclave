# Phase 4 — Task Execution

Phase 4 adds bounded code changes on top of the Phase 3 evidence and verdict model. It does not turn model text into shell input. Models may propose typed patches, claims, retrievals, reads, or checks; Conclave remains the authority that validates and executes each capability.

## Invariant

```text
LLM requests capability
        ↓
Conclave policy validates
        ↓
structured runner
        ↓
process executes
```

There is intentionally no `exec(modelResponse.command)`, shell-string parser, arbitrary executable field, or model-controlled argument vector.

## Workflow

1. The caller selects the explicit `task` intent and an objective.
2. Phase 3 investigates the repository and produces provenance-backed diagnosis claims.
3. Planner converts supported diagnosis into requirements, constraints, affected files, deterministic verification strategies, and ordered implementation steps.
4. With no edit permission, execution stops after the inspectable plan.
5. With edit permission, Conclave creates an isolated snapshot: a detached temporary worktree for clean Git repositories or a filtered temporary copy for non-Git folders.
6. Implementer proposes expected-hash-bound replacements, implementation claims, and typed capability requests.
7. Capability policy validates every request against plan scope, path policy, permissions, host allowlists, and budgets. Repository editor applies only approved patches.
8. The changed snapshot is incrementally reindexed. Approved checks run through the structured command runner.
9. Reviewer receives the actual diff, check results, and post-change evidence as untrusted data. Deterministic verification independently evaluates requirements and implementation claims.
10. Blocking gaps trigger at most the configured number of revisions. Repeated no-progress output, exhausted budgets, or uncertainty stop the loop without a false success.
11. Conclave returns the patch, decisions, checks, findings, evidence-backed verdict, trace, and usage metrics. The original repository remains unchanged.

## Permissions

Task Mode starts with all execution permissions disabled.

| CLI flag | Capability unlocked |
| --- | --- |
| `--plan-only` | Explicitly request diagnosis and plan only |
| `--allow-edits` | Apply approved scoped patches in the isolated workspace |
| `--allow-checks` | Permit low-privilege structured checks such as `node --check` |
| `--allow-repository-scripts` | Permit policy evaluation of Node tests and package scripts; requires checks |
| `--allow-network` | Acknowledge the absence of portable network isolation for repository code; requires repository scripts |

`CONCLAVE_ALLOWED_PACKAGE_SCRIPTS` is a host-controlled comma-separated allowlist. A model cannot add to it, and membership alone does not grant execution.

## Patch boundary

The editor accepts only replacements containing:

- a normalized repository-relative existing file path;
- the exact pre-edit SHA-256 hash;
- old and new text plus an exact expected occurrence count;
- a valid implementation step and an approved patch capability.

The editor rejects path escapes, symlinks, ignored/protected/secret-like files, stale hashes, ambiguous replacements, files outside the plan, and exceeded diff budgets. If a round fails or is rejected, its changes are rolled back before revision.

## Command boundary

The command domain is a closed union:

- `{ kind: "node-syntax", path }` maps to the current Node executable with `--check`;
- `{ kind: "node-test", path }` maps to the current Node executable with `--test`;
- `{ kind: "package-script", name }` maps to `npm run --ignore-scripts --silent <allowlisted-name>`.

The policy creates an approved-command object carrying an internal approval token. The runner rejects objects that did not pass policy. It then starts the fixed executable with `shell: false`, a fixed isolated working directory, a minimal environment, timeout/process-group termination, and bounded stdout/stderr.

Node tests and package scripts are privileged because they execute repository code. The current implementation has no portable filesystem or network sandbox for child processes, so both capabilities require explicit repository-script and network grants. They are inappropriate for untrusted repositories. Static syntax checking is the conservative default.

## Verification and revisions

Requirements and implementation claims use deterministic strategies: source presence/absence, symbol existence, graph paths, caller counts, changed/unchanged files, and approved check outcomes. Post-change verification uses the refreshed index and exact patch metadata.

Reviewer output is advisory evidence, not final authority. The engine synthesizes blocking findings for required gaps, unrelated edits, failed checks, and unsupported claims even when the Reviewer says `approved`. Historical rejected claims remain visible across revisions. Completion requires all required checks to be supported, no unrelated changes, no failed requested checks, and no blocking findings.

## CLI

Plan without mutation:

```bash
npm run dev -- task /path/to/repository "Persist the restored session" --plan-only
```

Generate an isolated, reviewed patch:

```bash
npm run dev -- task /path/to/repository "Persist the restored session" --allow-edits --json
```

Enable a trusted, host-allowlisted package check only when needed:

```bash
CONCLAVE_ALLOWED_PACKAGE_SCRIPTS=typecheck \
  npm run dev -- task /path/to/repository "Fix the type error" \
  --allow-edits --allow-checks --allow-repository-scripts --allow-network
```

Task CLI indexing is ephemeral, so plan-only mode does not create `.conclave` state in the target repository.

## Evaluation

`npm run eval:task` runs deterministic adversarial fixtures for a bad implementation, false completion, unrelated edits, prompt injection, dirty worktrees, and command-policy bypass attempts. The committed comparison fixture currently reports:

| Strategy | True success | False success | Unrelated edits | Revision success | Mean model calls | Mean context tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Single Implementer | 0.0000 | 1.0000 | 0.0000 | 0.0000 | 7 | 7046 |
| Planner + Implementer | 0.0000 | 1.0000 | 1.0000 | 0.0000 | 7 | 8252 |
| Conclave Task | 1.0000 | 0.0000 | 0.0000 | 1.0000 | 9 | 12877 |

This small scripted fixture validates orchestration and policy behavior; it does not estimate production model accuracy.

## Phase boundary

Phase 4 ends at an inspectable patch and verdict. It does not merge into the source repository, commit, push, open a pull request, or add a web UI. Phase 5 may present this state, but its default interaction must preserve explicit intent and default-deny capabilities.

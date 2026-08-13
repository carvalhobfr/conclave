# Conclave roadmap

Conclave is a read-only PR companion. The product gathers context and evidence, a coding agent or developer corrects the code, and a human decides whether it can merge. Autonomous code mutation is intentionally outside this roadmap.

## 0.3 — Natural review workflow

- `conclave check` as the recommended zero-ceremony entry point.
- Workspace comparison that includes branch commits, staged, unstaged, and untracked files.
- Automatic base detection and transparent fallback objective.
- `conclave setup` for agent and GitHub integration.
- `conclave doctor` for repository readiness.
- Clear “Nothing to review” state instead of a blocking false failure.

## 0.4 — Universal code review

- One multi-language review path for TypeScript, JavaScript, Python, and Java.
- Language-aware production/test file checks.
- Richer PR summary and exact changed-file evidence.
- Repository-language-independent GitHub workflow.
- PR comment, annotations, job summary, report artifact, and deterministic gate.

## 0.5 — Agent correction loop

- Primary Codex and Claude Code skill.
- Transient `npx` fallback: the skill can run without adding the package to the target repository.
- Portable correction handoff generated from findings and evidence.
- Full local reports and handoffs in review history.
- Explicit loop: review → agent correction → recheck → human approval.

## 0.6 — Review cockpit

- `conclave open .` launches the local UI and opens the selected repository automatically.
- Workspace/base selector with repository branch metadata.
- Summary, findings, claims, affected code, exact diff, raw report, and copyable handoff.
- Shared CLI/UI local review history.
- Read-only interface boundary; no patch application, repository scripts, commits, pushes, approvals, or merges.

## 0.7 — Trustworthy correction protocol — implemented

- Digest-bound review lineage across correction-loop rechecks.
- Contract drift detection: changed objectives, claims, or allowed scope require an explicit rebaseline instead of silently moving the finish line.
- Stable finding fingerprints and lifecycle states for duplicate rechecks, progress, stagnation, and regression.
- External evidence receipts bound to the exact artifact or diff, with stale, failed, invalid, and unbound states.
- Deterministic risk routing: the baseline plus at most three focused challenge strategies.
- Agent protocol through `--previous-report`, repeatable `--receipt`, `--series`, `--new-series`, and schema-v2 JSON.
- Correction handoffs that expose lineage, progress, receipts, selected challenges, and rebaseline requirements.

## After 0.7

Candidates are tracked by evidence rather than dates:

- deeper semantic resolution for Python and Java;
- Go, Rust, C#, Kotlin, and PHP structural parsers;
- a reusable first-party GitHub Action release and GitLab/Bitbucket adapters;
- SARIF and GitHub Checks output;
- configurable team policy files and protected baselines;
- richer large-repository graph summaries and incremental review performance;
- CI-verified and signed receipt/report attestations;
- permissioned local check execution with sandboxing and output capture;
- optional hosted collaboration, only after a dedicated security design.

# Changelog

All notable changes to Conclave are documented here. The project follows [Semantic Versioning](https://semver.org/) and the structure proposed by [Keep a Changelog](https://keepachangelog.com/).

[English](CHANGELOG.md) · [Português (Brasil)](CHANGELOG.pt-BR.md)

## [Unreleased] — planned for 0.7.0

This is the next release currently present in the repository. The latest version published to npm is `0.2.8`.

### Added

- Schema-v2 review lineage with objective, contract, diff, artifact, previous-report, and report digests.
- Contract drift gates, explicit rebaseline series, stable finding fingerprints, and correction-loop progress/stagnation tracking.
- External evidence receipts bound to the reviewed artifact plus deterministic risk-selected challenge plans.
- `--previous-report`, repeatable `--receipt`, `--series`, and `--new-series` support in the CLI and portable validation skill.
- `conclave check`, the recommended one-command PR pass. It detects the likely base and includes branch commits, staged, unstaged, and untracked files.
- `conclave compare`, with an interactive local and remote branch selector that does not change the current checkout.
- A complete `conclave help` catalog grouped by purpose, plus detailed guides such as `conclave help check` and `conclave help symbol`.
- Global CLI language preferences with English as the default, Brazilian Portuguese (`pt-BR`), and European Spanish (`es-ES`).
- `conclave config --language <language>` and an interactive language selector in the guided menu.
- A local review cockpit with summary, findings, changed code, exact diff, history, and copyable coding-agent handoff.
- Local review history and `conclave handoff` for the correct-and-recheck loop.
- Guided `conclave setup` and portable skills for Codex, Claude Code, GitHub Actions, and other agents.
- A pull-request GitHub Actions workflow with job summaries, annotations, one maintained PR comment, and JSON artifacts.
- Structural code parsing and graph evidence for Python and Java, alongside TypeScript and JavaScript.
- `conclave doctor` for repository integration diagnostics.

### Changed

- Positioned Conclave as a read-only PR companion: it supplies context, evidence, and next actions while humans retain merge authority.
- Removed autonomous Task Mode and all public repository-mutation behavior. Conclave points to problems; the developer or their coding agent performs corrections.
- Review now builds a fresh snapshot and no longer depends on `.conclave/code-index-v2.json`; the persistent index is only an optional cache for search, graph, Ask, and Investigate.
- No-change comparisons are reported as informational “Nothing to review” results instead of false blockers.
- The README is shorter, bilingual, task-oriented, and explicit about deterministic review versus optional provider-backed reasoning.
- JSON field names remain stable in English regardless of the selected human-interface language.

### Security

- Receipt trust claims are conservatively treated as self-reported; Conclave never claims to have run an externally reported command.
- Mutable-worktree receipts require an artifact or diff digest and cannot rely on `HEAD` alone.
- User language preferences are stored outside the repository with owner-only file permissions.
- A repository `.env` cannot redirect or silently replace global CLI preferences.
- PR review remains local and deterministic: it does not use an API key, call a model, or run repository scripts.

## [0.2.8] — 2026-08-12

### Added

- Human-readable PR summaries with comparison, risks, changed files, verdict, and next steps.
- Guided PR workflow built around explicit Git comparisons.
- Guided CLI navigation for the main PR workflow.

### Fixed

- Branch review documentation and comparison behavior were clarified to avoid reviewing the wrong diff.

## [0.2.6] — 2026-08-12

### Added

- `conclave update --check`, `--local`, and `--global`.

### Fixed

- Updating an already current installation now returns a clear explanation instead of an `ENOENT` failure.

## [0.2.5] — 2026-08-12

### Added

- Guided CLI navigation for common Conclave workflows.
- Structural review support and documentation for Python and Java.

### Changed

- Reframed deterministic validation as one evidence-producing step in the PR workflow rather than automatic code judgment.

## [0.2.4] — 2026-08-12

### Added

- Separate English and Brazilian Portuguese READMEs.
- Repository-hosted visual diagrams for the PR flow and deterministic review pipeline.

### Changed

- Simplified the product explanation around the path from code change to human-approved merge.

## [0.2.3] — 2026-08-12

### Changed

- Clarified the branch review workflow, deterministic boundaries, and meaning of code units previously called symbols.

## [0.2.2] — 2026-08-11

### Added

- Modern guided provider setup for optional Ask and Investigate modes.
- Portable agent-skill and web-workflow validation gates.

### Fixed

- CI self-validation compares against the event base instead of blocking on an empty diff.
- Package and repository naming were aligned on `conclave-ai`.

## [0.2.1] — 2026-08-11

### Changed

- Improved the provider onboarding experience and initial npm package metadata.

## [0.2.0] — 2026-08-11

### Added

- First public npm release as `conclave-ai`.
- Deterministic validation contracts, change collection, structural impact analysis, and evidence-backed verdicts.
- Optional API configuration and a portable validation skill.

[Unreleased]: https://github.com/carvalhobfr/conclave-ai/compare/b6c5418...HEAD
[0.2.8]: https://www.npmjs.com/package/conclave-ai/v/0.2.8
[0.2.6]: https://www.npmjs.com/package/conclave-ai/v/0.2.6
[0.2.5]: https://www.npmjs.com/package/conclave-ai/v/0.2.5
[0.2.4]: https://www.npmjs.com/package/conclave-ai/v/0.2.4
[0.2.3]: https://www.npmjs.com/package/conclave-ai/v/0.2.3
[0.2.2]: https://www.npmjs.com/package/conclave-ai/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/conclave-ai/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/conclave-ai/v/0.2.0

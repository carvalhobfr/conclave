# Contributing

Keep changes small, evidence-backed, and covered by deterministic tests. Conclave is a read-only reviewer: do not add repository mutation, patch application, merge, or autonomous task execution to its public surfaces.

Before opening a change, run `npm run verify`. New retrieval, reasoning, and validation fixtures must declare their expected outcomes before evaluation. Never add credentials, generated `.conclave` state, or machine-specific paths.

Add user-visible changes to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md). Move them into a dated version section only when that version is actually published.

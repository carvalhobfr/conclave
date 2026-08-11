<div align="center">

# Conclave

### AI writes. Conclave verifies.

**A local-first PR assistant that checks whether a code change did what it claims.**

[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![npm](https://img.shields.io/npm/v/conclave-ai?logo=npm&color=CB3837)](https://www.npmjs.com/package/conclave-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-4C1?logo=opensourceinitiative&logoColor=white)](LICENSE)

[Quick start](#quick-start) · [Agent skill](#agent-skill) · [CI](#github-actions) · [Provider setup](#optional-model-setup) · [Docs](#documentation)

</div>

---

Conclave sits between **code changed** and **ready to merge**:

```text
Developer or agent changes code → Conclave verifies the change → PR can move forward
```

Give it a Git change and its objective. Conclave inspects the diff, follows affected symbols beyond the edited files, checks optional machine-readable claims, and returns one verdict:

```text
PASS  ·  WARN  ·  BLOCK  ·  INCONCLUSIVE
```

`conclave review` is deterministic, runs locally, needs no API key, and makes zero model calls.

## Where it fits

| When | How Conclave helps |
| --- | --- |
| Before a PR | Review the working tree or staged change from the CLI |
| After an agent finishes | Let Codex or Claude Code run an independent validation skill |
| During a PR | Run the same check in CI and block unsupported changes |

It is not a replacement for tests or human review. It is the extra check that asks: **does the repository support what this change claims?**

## Quick start

Requirements: Node.js 20+ and Git.

Run Conclave once without installing it:

```bash
npx --yes --package=conclave-ai conclave review . --working \
  --objective "Restore the session after page refresh"
```

Or install it in a project:

```bash
npm install --save-dev conclave-ai
npx --no-install conclave review . --working --objective "..."
```

Yarn and pnpm work too:

```bash
yarn add --dev conclave-ai
yarn conclave review . --working --objective "..."

pnpm add --save-dev conclave-ai
pnpm exec conclave review . --working --objective "..."
```

For a global `conclave` command:

```bash
npm install --global conclave-ai
conclave review . --working --objective "..."
```

## What it reviews

Choose the Git snapshot that matches your workflow:

```bash
# Current working tree
conclave review . --working --objective "..."

# Only staged changes
conclave review . --staged --objective "..."

# Current branch compared with its base
conclave review . --branch origin/main --objective "..."

# One commit
conclave review . --commit HEAD --objective "..."
```

Add `--json` for CI, agents, or other tools.

| Verdict | Exit | Meaning |
| --- | ---: | --- |
| `PASS` | `0` | No blocker or warning was found |
| `WARN` | `0` | The result needs human attention |
| `BLOCK` | `1` | A deterministic problem contradicts the change |
| `INCONCLUSIVE` | `2` | There is not enough evidence to approve it |

Conclave intentionally blocks a comparison with no diff. A merged `main` compared with `origin/main` is not a change to validate.

## Make PR claims checkable

An objective provides context. A validation contract turns important completion claims into deterministic checks:

```json
{
  "objective": "Restore authentication after refresh",
  "claims": [
    {
      "id": "restore-exists",
      "statement": "bootstrapSession exists",
      "check": {
        "kind": "symbol-exists",
        "symbol": "bootstrapSession",
        "expectation": "present"
      }
    }
  ]
}
```

```bash
conclave review . --branch origin/main \
  --contract .conclave/review-contract.json
```

Contracts support symbol, caller, reference, text, and changed-file checks. The output follows the public [validation report schema](schemas/validation-report.v1.schema.json).

## Agent skill

Conclave ships a `conclave-validate` skill for Codex and Claude Code. The package provides the CLI; skill installation is explicit.

Install it in the current repository:

```bash
npm install --save-dev conclave-ai
npx --no-install conclave skill install \
  --target both --scope project --project .
```

This creates:

```text
.agents/skills/conclave-validate/  # Codex
.claude/skills/conclave-validate/  # Claude Code
```

Invoke it directly with `$conclave-validate` in Codex or `/conclave-validate` in Claude Code. You can also ask the agent to validate a working tree, staged change, branch, or commit before accepting its work.

For a user-wide installation:

```bash
npm install --global conclave-ai
export CONCLAVE_BIN=conclave
conclave skill install --target both --scope user
```

Preview any skill installation with `--dry-run`; use `--force` only when you intend to replace an existing copy.

## GitHub Actions

Run Conclave on each pull request using the PR's actual base branch:

```yaml
name: Conclave

on:
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: >-
          npx --no-install conclave review .
          --branch origin/${{ github.base_ref }}
          --contract .conclave/review-contract.json
          --json
```

For a `push` workflow, compare with `${{ github.event.before }}`. Do not compare a checked-out `main` with `origin/main`; both point to the same commit after the push.

## Optional model setup

You do **not** need a provider or API key for Review, CI, the agent skill, or MCP validation.

Models are used only by optional Ask, Investigate, and Task features:

```bash
conclave models
conclave init
conclave provider-check
```

`conclave init` guides you through provider, model, reasoning mode, and a hidden API-key prompt. Configuration stays local in the repository's ignored `.env`.

| Provider | Credential |
| --- | --- |
| OpenAI | Standard OpenAI Platform API key; it can call available Codex API models when the project has access. A ChatGPT/Codex login token is not an API key. |
| OpenRouter | OpenRouter inference key using that account's credits and limits. Management keys and subscriptions from other products do not work as inference keys. |
| Anthropic | Standard Anthropic Console API key tied to its workspace. |

Use a curated profile or any model ID supported by the provider:

```bash
conclave init --provider openai --profile coding
conclave init --provider openrouter --profile claude-sonnet-latest
conclave init --provider anthropic --profile deep
conclave init --provider openrouter --model "provider/custom-model"
```

## Other interfaces

Start the MCP server for one repository:

```bash
conclave mcp /absolute/path/to/repository
```

Run the local web interface from a source checkout:

```bash
npm install
npm run build
npm run start:web
# http://127.0.0.1:4317
```

Both expose the same validation result as the CLI.

## Language support and limits

- Git collection and file-level contract checks work at repository level.
- Deep symbol and dependency analysis currently supports TypeScript and JavaScript.
- Node.js is the Conclave runtime; the repository being reviewed does not need to be a Node project.
- Review does not execute repository tests or scripts.
- Deleted-only changes can be `INCONCLUSIVE` because validation indexes the resulting repository.

## Documentation

- [Super-validator design](docs/super-validator.md)
- [Security and trust boundaries](docs/security.md)
- [Validation report schema](schemas/validation-report.v1.schema.json)
- [Portable agent skill](skills/conclave-validate/SKILL.md)
- [Contributing](CONTRIBUTING.md)

## Contributing

```bash
git clone https://github.com/carvalhobfr/conclave.git
cd conclave
npm install
npm run verify
```

Conclave is released under the [MIT License](LICENSE).

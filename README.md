<div align="center">

# Conclave

### Simplify and protect every PR.

**Conclave is a PR companion: it provides context, evidence, and a safer path from code change to merge.**

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![npm](https://img.shields.io/npm/v/conclave-ai?logo=npm&color=CB3837)](https://www.npmjs.com/package/conclave-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-4C1?logo=opensourceinitiative&logoColor=white)](LICENSE)

[Quick start](#quick-start) · [Agent skill](#agent-skill) · [CI](#github-actions) · [Provider setup](#optional-model-setup) · [Docs](#documentation)

</div>

---

Conclave sits between **code changed** and **ready to merge**:

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/codex/readme-product-guide/docs/assets/conclave-pr-flow.svg" alt="A code change is checked by Conclave, produces evidence, and goes to human approval" width="900"></p>

**In one sentence:** Conclave helps agents and people understand what changed, what was affected, and what to do next before merging.

Conclave has two connected jobs. First, it gives an agent or developer local repository context for investigation and implementation. Then it checks the resulting change before the PR moves to human approval. Its validation step inspects the diff, follows affected code units (functions, classes, methods, interfaces, and similar declarations), checks optional machine-readable claims, and returns one verdict:

```text
PASS  ·  WARN  ·  BLOCK  ·  INCONCLUSIVE
```

The context and agent features (`ask`, `investigate`, and `task`) can use a provider that you configure. The `review`/`validate` command is the independent verification step inside that larger workflow; it runs locally and does not call a model. `conclave validate` is the more explicit alias.

> **Important:** `validate` is one step, not the whole product. It produces an independent evidence report for the next step. It does not compile the project, run the test suite, execute the application, or decide whether the product behavior is good. An agent or human uses its report together with tests, runtime checks, security review, and product judgment.

### The product in practice

| Stage | Conclave's job | Output |
| --- | --- | --- |
| Understand | Index the repository and expose search, code relationships, and evidence | Local code context |
| Work | Let a configured agent investigate, plan, or make a bounded change | A proposed implementation |
| Check | Compare the Git change with its objective and claims | Independent validation report |
| Decide | Give the agent, CI, and reviewer the same evidence | Fix, investigate, or approve |

### Where validation fits

`validate` is the independent evidence checkpoint in the PR workflow. Indexing is only its preparation step. Conclave builds a temporary local map of the repository so the next agent or reviewer can answer concrete questions with evidence:

| Step | What it does |
| --- | --- |
| Collect change | Reads the selected Git diff or branch comparison |
| Build local map | Finds files, functions, classes, methods, imports, calls, and dependencies |
| Trace impact | Follows which unchanged code uses or depends on the changed code |
| Validate | Checks the objective, changed scope, contracts, claims, and available evidence |
| Evidence step | Returns `PASS`, `WARN`, `BLOCK`, or `INCONCLUSIVE` with file/line evidence |

It performs deterministic checks that should remain independent from the agent that made the change: whether a claimed function exists, whether a change touches the requested scope, whether a deleted unit still has consumers, and whether the repository provides enough evidence. A `PASS` means **“the available structural checks found no blocker”**, not **“this code is guaranteed correct”**. The result is input to the next step, not the final PR decision.

Typical flow:

```text
1. Agent or developer changes code
2. Conclave indexes the repository and validates the change
3. Agent/reviewer reads the evidence, runs tests, and investigates open questions
4. Human approves or requests changes
```

Think of the result as a **change-readiness signal**:

| Conclave can say | Conclave cannot say by itself |
| --- | --- |
| “This claim is supported by the repository.” | “Users will love this behavior.” |
| “This branch changes these files and affected code units.” | “The application works in production.” |
| “A deterministic blocker or missing piece was found.” | “All tests and runtime paths pass.” |

## How review works

The verification step is a local evidence pipeline:

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/codex/readme-product-guide/docs/assets/conclave-review-pipeline.svg" alt="Conclave review pipeline from Git snapshot to evidence-backed verdict" width="900"></p>

When you run `conclave review`, Conclave:

1. collects the working tree, staged files, branch diff, or commit you selected;
2. excludes ignored, binary, secret-like, or unsafe files from the index;
3. parses supported source files and builds a local dependency graph of code units;
4. maps changed lines to functions, classes, methods, and other declarations, then follows their local impact;
5. checks the objective and any explicit validation contract; and
6. returns `PASS`, `WARN`, `BLOCK`, or `INCONCLUSIVE` with evidence and next actions.

The verification path does not send repository content anywhere, use provider credentials, call a model, execute repository scripts, or require network access. This separation keeps the report independent from the agent's own reasoning and makes it suitable for local development and CI.

API-backed providers are only for optional features such as `conclave ask` and `conclave task`. Those commands use the provider configured by `conclave init`; they are separate from the deterministic review gate.

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

### Compare branches and summarize the change

The branch mode compares the checked-out branch (`HEAD`) with any Git ref you provide. It is useful for a local pre-PR summary as well as for validation:

```bash
# While checked out on feature/login
conclave review . --branch origin/main \
  --objective "Add passwordless login"
```

The human-readable output includes the verdict, changed/impacted file and code-unit counts, and a compact list of each changed file with its status and number of diff hunks. In Conclave's JSON schema, these code units are represented as `symbols`: a symbol is simply a named piece of code such as a function, class, method, interface, or component. Add `--json` when another tool or a CI job needs the complete machine-readable change set, evidence, and summary:

```bash
conclave review . --branch origin/main \
  --objective "Add passwordless login" --json
```

This does not call an API or generate an LLM summary: Conclave derives the comparison from Git and its local code index. If you want a natural-language explanation, use the optional API-backed `conclave ask` separately after configuring a provider.

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
npx conclave skill install
```

That command defaults to the current repository and installs both agent adapters. Use `--target codex` or `--target claude` when you only want one.

If you only want the skill files and do not want to add Conclave to the project, use the one-shot installer:

```bash
npx --yes conclave-ai skill install
```

This installs the adapters without changing `package.json`. The validation engine still needs to be available through a project install, a global install, or an explicit `CONCLAVE_CLI_PATH` when the skill runs.

This creates:

```text
.agents/skills/conclave-validate/  # Codex
.claude/skills/conclave-validate/  # Claude Code
```

Invoke it directly with `$conclave-validate` in Codex or `/conclave-validate` in Claude Code. You can also ask the agent to validate a working tree, staged change, branch, or commit before accepting its work.

For a user-wide installation:

```bash
npm install --global conclave-ai
conclave skill install --scope user
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
- Deep structural analysis currently supports TypeScript, JavaScript, Python, and Java. Python and Java use deterministic source-structure parsers for declarations, imports, calls, exports, and inheritance; compiler-level type checking is outside Conclave's scope.
- Other languages still receive repository-level diff, text, changed-file, and contract validation while their deep symbol graph is being added.
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
git clone https://github.com/carvalhobfr/conclave-ai.git
cd conclave
npm install
npm run verify
```

Conclave is released under the [MIT License](LICENSE).

<div align="center">

# Conclave

### Simplify and protect every PR.

**Conclave is a PR companion: it gives your team context, evidence, and a safer path from code change to merge.**

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/conclave-ai?logo=npm&color=CB3837)](https://www.npmjs.com/package/conclave-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-4C1?logo=opensourceinitiative&logoColor=white)](LICENSE)

[Quick start](#quick-start) · [PR workflow](#the-recommended-pr-workflow) · [Agent skill](#use-it-from-codex-or-claude-code) · [Configuration](#optional-ai-configuration)

</div>

---

## A PR companion, not another black box

Conclave sits between **code changed** and **ready to merge**. It compares the change with its objective, follows the affected code, shows evidence and next actions, then leaves the decision with a human reviewer.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-pr-flow.svg" alt="A code change is checked by Conclave, produces context and evidence, and then goes to human approval before merge" width="900"></p>

The shortest explanation is:

```text
change → Conclave explains and checks it → agent/developer corrects open issues → human approves → merge
```

Conclave has two layers:

| Layer | What it does | Needs an API key? |
| --- | --- | ---: |
| PR pass (`pr`, `review`, `validate`) | Compares Git changes, builds a local code map, traces impact, checks claims, and reports evidence | No |
| Optional reasoning (`ask`, `task`, local web UI) | Uses a configured provider to investigate questions or plan/execute a bounded task | Only when you choose a hosted provider |

The PR pass is deliberately independent from the agent that wrote the code. It is not a test runner, a compiler, a production monitor, or an automatic approval. A `PASS` means that the available structural checks found no blocker; tests, runtime checks, security review, and human judgment still matter.

## Quick start

Requirements: Node.js 20+ and Git. The repository being reviewed can be TypeScript, JavaScript, Python, Java, or another language; Node.js is only Conclave's CLI runtime.

### Install in a project (recommended)

```bash
npm install --save-dev conclave-ai
npx --no-install conclave start
```

The package exposes one binary: `conclave`. There is no `conclave-ai` shell command.

Yarn and pnpm are also supported:

```bash
yarn add --dev conclave-ai
yarn conclave start

pnpm add --save-dev conclave-ai
pnpm exec conclave start
```

### Try it without changing `package.json`

```bash
npx --yes --package=conclave-ai conclave start
```

### Install globally (optional)

```bash
npm install --global conclave-ai
conclave start
```

Global installation is convenient for a personal CLI. A project install is usually better for teams and CI because everyone runs the version recorded in the repository.

## The guided CLI

Run `conclave` with no arguments in an interactive terminal, or run:

```bash
conclave start [path]
```

The menu is designed for the normal workflow. It lets you:

1. run a complete PR pass;
2. choose the source to check: branch, working tree, staged files, or one commit;
3. enter the change objective;
4. see progress while Conclave collects, indexes, and validates;
5. read the summary, evidence, risks, and next actions; and
6. inspect history, configure optional models, update Conclave, or open the full help.

The first option, **Run a complete PR pass**, is the recommended starting point. **Review evidence (advanced)** is the lower-level report for CI, contracts, and scripts.

### Compare branches without memorizing refs

For a branch-first workflow, run:

```bash
conclave compare .
```

Conclave lists local and remote-tracking branches, marks the checked-out branch, lets you select a comparison base and target, and then asks for the change objective. It never switches branches. You can type a ref manually when it is not in the list. The same selector is available from `conclave start` → **Compare branches**.

For scripts and CI, keep using the explicit form:

```bash
conclave compare . --base origin/main --head feature/login \
  --objective "Add passwordless login" --json
```

You do not need to run `conclave index` before a PR pass. The guided **Understand this repository** option and the `conclave index` command intentionally create a reusable local `.conclave/code-index-v2.json` for search, graph, and Ask workflows. `conclave pr` and `conclave review` build the exact target snapshot they need in memory (or in a temporary folder for an explicit `--head`) and do not use that persisted index as the change source.

## The recommended PR workflow

From the feature branch you want to inspect:

```bash
git fetch origin
git switch feature/login
git status --short

conclave pr . --base origin/main --head feature/login \
  --objective "Add passwordless login"
```

`--base` is the **comparison base** and `--head` is the **branch/commit being inspected**. Conclave never switches your checkout. If `--head` is omitted, it uses the checked-out `HEAD`:

- collects the Git comparison;
- builds a safe local map of files and code units;
- follows the local impact of changed code;
- checks the objective and optional contract claims;
- prints a human-readable PR summary with progress, changed files, risks, verdict, and next steps; and
- saves an owner-only record in `.conclave/review-history.json`.

This also works when your checkout is another branch or contains untracked files: Conclave reads the target ref into a temporary snapshot. The normal correction loop is explicit and easy to repeat:

```text
change → conclave pr → read evidence → correct → conclave pr again → human approval → merge
```

After `BLOCK` or `WARN`, open the cited files and lines, make the correction with your editor or coding agent, and run the same command again. Conclave does not post GitHub comments, apply patches, merge, or approve a PR in this release.

### Compare branches and understand what changed

The branch mode is also a concise local PR summary:

```bash
conclave pr . --base origin/main --head feature/login \
  --objective "Describe the behavior this branch must deliver"
```

For a machine-readable result, use `--json`. JSON mode contains only JSON, so it is safe for CI and agent integrations:

```bash
conclave pr . --base origin/main --head feature/login \
  --objective "Add passwordless login" --json > /tmp/conclave-pr.json
```

The local history is useful when iterating on a branch:

```bash
conclave history .
conclave history . --json
```

If the result says **No code change was collected**, check the comparison before changing anything:

```bash
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git merge-base origin/main HEAD
```

Fetch the remote or choose the correct base ref when those Git commands do not show the expected work. A merged `main` compared with `origin/main` normally has no diff because both refs point to the same commit.

## `review` and `validate`: the evidence report

`pr` is the friendly, complete workflow. `review` is the lower-level command; `validate` is its explicit alias. They use the same deterministic engine and return a JSON report when `--json` is supplied.

```bash
# Tracked unstaged working-tree changes (untracked files must be staged or ignored)
conclave review . --working --objective "..."

# Only staged changes
conclave review . --staged --objective "..."

# Branch/commit against an explicit base
conclave review . --base origin/main --head feature/login --objective "..."

# One existing commit
conclave validate . --commit HEAD --objective "..." --json
```

The source options are mutually exclusive. An objective is required because Conclave can check a change only against an intended outcome.

Internally, the report follows this pipeline:

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-review-pipeline.svg" alt="Git snapshot, local index, impact graph, checks, and evidence-backed verdict" width="900"></p>

It collects the selected Git snapshot, ignores unsafe or irrelevant files, parses supported source, maps changed lines to named code units, traces callers/imports/references, and evaluates optional contracts. A **symbol** is simply a named code unit such as a function, class, method, interface, or component.

| Verdict | Exit code | Meaning |
| --- | ---: | --- |
| `PASS` | `0` | No deterministic blocker was found in the available evidence |
| `WARN` | `0` | The result needs human attention before approval |
| `BLOCK` | `1` | A deterministic problem contradicts the objective or claim |
| `INCONCLUSIVE` | `2` | There is not enough evidence to make the structural check |

Review is local and independent: it does not send repository content anywhere, use provider credentials, call a model, execute repository scripts, or require network access.

## Make important PR claims checkable

An objective describes the goal. A contract adds explicit, machine-readable claims:

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
conclave pr . --base origin/main --head feature/login \
  --contract .conclave/review-contract.json \
  --objective "Restore authentication after refresh"
```

Contracts support symbol, caller, reference, text, and changed-file checks. See the [report schema](schemas/validation-report.v1.schema.json).

## Use it from Codex or Claude Code

Conclave ships a portable `conclave-validate` agent skill. The skill is not the whole package: the package contains the CLI and the skill installer; the skill is an adapter that asks the agent to run the same independent report.

Install the skill in the current repository:

```bash
npm install --save-dev conclave-ai
npx --no-install conclave skill install
```

This creates:

```text
.agents/skills/conclave-validate/  # Codex
.claude/skills/conclave-validate/  # Claude Code
```

Then invoke `$conclave-validate` in Codex or `/conclave-validate` in Claude Code. The skill asks for an objective, selects the requested working/staged/branch/commit source, runs the bundled validator, and presents verdict, claims, impact, evidence, limitations, and next action.

To install only the skill files without adding a dependency to `package.json`:

```bash
npx --yes --package=conclave-ai conclave skill install
```

That one-shot command installs the adapters, but the validator still needs a Conclave CLI available in the repository, globally, or through `CONCLAVE_CLI_PATH` when the skill runs. Preview first with `--dry-run`; use `--force` only after reviewing a replacement.

The skill is the agent-facing layer: it tells Codex or Claude how to select the correct change, run the independent validator, preserve its verdict, and explain the evidence. It does not replace the CLI and it does not approve, edit, or merge a pull request. Keep it installed in the repository when you want the workflow to be visible and versioned with the team.

For a user-wide installation:

```bash
conclave skill install --scope user
```

To add a ready-to-run GitHub Actions check to the current repository:

```bash
conclave skill install --target github-actions
```

This creates `.github/workflows/conclave-review.yml`. It compares the pull request base with the actual head SHA, writes a readable result to the GitHub job summary, uploads the JSON report as an artifact, and fails the check only when Conclave returns a blocking or inconclusive verdict. It requires `conclave-ai` in the repository's dev dependencies (`npm install --save-dev conclave-ai`). The workflow is deterministic and does not need an API key.

## Optional AI configuration

You do **not** need a key for `pr`, `review`, `validate`, CI, or the validation skill. Those paths are deterministic and local.

Configure a provider only for `ask`, `task`, or the optional local web interface:

```bash
conclave models
conclave init
conclave provider-check
```

`conclave init` is an interactive four-step setup: provider, model profile, reasoning style, and hidden key input. It writes only the managed `CONCLAVE_*` block to a Git-ignored `.env` with owner-only permissions. Run `conclave config` to inspect safe metadata without printing the key.

| Provider choice | What to use |
| --- | --- |
| OpenAI Platform / Codex API | An OpenAI Platform API key. It can call Codex API models available to the project. A ChatGPT/Codex subscription login token is not an API key. |
| OpenRouter | An OpenRouter inference key. Requests use that account's credits, limits, and free-model allowance. |
| Anthropic | An Anthropic Console API key. A Claude app subscription is separate from API access. |

Choose one of the four maintained profiles or pass an exact model ID:

```bash
conclave init --provider openai --profile coding
conclave init --provider openrouter --profile claude-sonnet-latest
conclave init --provider anthropic --profile deep
conclave init --provider openrouter --model "provider/custom-model"
```

The configured provider is never used by the deterministic PR pass.

## Updating Conclave

For a project install:

```bash
conclave update
```

For a global install:

```bash
conclave update --global
```

Check the registry without installing:

```bash
conclave update --check
```

If the installed version is already current, the command exits with an explicit “already on the latest release” message. You can also use `npm install --save-dev conclave-ai@latest` or `npm install --global conclave-ai@latest`. After a skill update, refresh a project copy with `npx --no-install conclave skill install --force`.

## CI and GitHub Actions

The agent skill is for an interactive coding agent; GitHub Actions is the unattended version of the same evidence gate. Both use the same CLI report and keep the human approval step intact. The recommended setup is to install the workflow template:

```bash
npx --no-install conclave skill install --target github-actions
```

Commit the generated workflow so every pull request runs the check. Do not use `--working` in CI: compare an explicit base and head so local files and the checkout state cannot change what is reviewed.

Run the same check on a pull request's actual base branch:

```yaml
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
    --base origin/${{ github.base_ref }}
    --head ${{ github.event.pull_request.head.sha }}
    --contract .conclave/review-contract.json
    --objective "Validate the pull request objective"
    --json
```

For pull requests, pass the base and head explicitly when possible. For a push workflow, use the event's previous SHA as the base and the pushed SHA as `--head`.

## Interfaces and language support

- **CLI:** complete guided workflow plus scriptable commands.
- **Agent skill:** Codex and Claude Code adapters for the independent report.
- **MCP:** `conclave mcp /absolute/path/to/repository` starts a read-only stdio server.
- **Web UI:** from a source checkout, run `npm run build && npm run start:web`, then open `http://127.0.0.1:4317`.

Deep structural analysis currently supports TypeScript, JavaScript, Python, and Java. Other languages still receive Git comparison, file/text checks, and repository-level contracts. Conclave does not run repository tests or scripts during review.

## Documentation

- [Portuguese guide](README.pt-BR.md)
- [SuperValidator design](docs/super-validator.md)
- [Security and trust boundaries](docs/security.md)
- [Validation report schema](schemas/validation-report.v1.schema.json)
- [Portable agent skill](skills/conclave-validate/SKILL.md)
- [Contributing](CONTRIBUTING.md)

Conclave is released under the [MIT License](LICENSE).

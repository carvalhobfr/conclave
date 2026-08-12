#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { TypeScriptCodeParser } from "./code-intelligence/typescript-parser.js";
import { describeRuntimeConfig, loadRuntimeConfig } from "./config/runtime-config.js";
import { loadReasoningConfiguration } from "./config/reasoning-config.js";
import { loadTaskConfiguration } from "./config/task-config.js";
import { loadConclaveEnvironment, writeConclaveEnvironment } from "./config/environment-file.js";
import {
  isGuidedProviderId,
  providerProfiles,
  REASONING_STYLES,
  type GuidedProviderId,
} from "./config/provider-profiles.js";
import { createSetupConfiguration } from "./config/setup.js";
import {
  providerSetupGuide,
  renderProviderGuide,
  renderSetupBanner,
  renderSetupChoice,
  renderSetupStep,
  renderSetupSuccess,
  terminalColorEnabled,
} from "./cli-setup-presentation.js";
import { createEmbeddingProvider } from "./embeddings/embedding-factory.js";
import type { EmbeddingProvider } from "./domain/embedding.js";
import {
  loadEvaluationCases,
  runGraphAwareRetrievalEvaluation,
  runRetrievalEvaluation,
} from "./evaluation/retrieval-evaluation.js";
import {
  loadReasoningEvaluationCases,
  runReasoningEvaluation,
} from "./evaluation/reasoning-evaluation.js";
import { FileSystemCodeIndexStore } from "./indexing/file-system-index-store.js";
import { InMemoryCodeIndexStore } from "./indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "./indexing/repository-indexer.js";
import { createProvider } from "./providers/provider-factory.js";
import { diagnoseProvider } from "./providers/provider-diagnostics.js";
import { ConclaveMcpService } from "./mcp/conclave-mcp-service.js";
import { runMcpStdio } from "./mcp/server.js";
import { ConclaveProductService } from "./web/product-service.js";
import { LocalFolderRepository } from "./repositories/local-folder-repository.js";
import { CodeRetrievalService } from "./retrieval/code-retrieval-service.js";
import type { RetrievalStrategy } from "./retrieval/hybrid-retriever.js";
import { StructuredAgentRuntime } from "./reasoning/agent-runtime.js";
import { ReasoningEngine } from "./reasoning/reasoning-engine.js";
import { DEFAULT_REASONING_LIMITS } from "./domain/reasoning.js";
import { DEFAULT_TASK_EXECUTION_LIMITS } from "./domain/task-execution.js";
import { StructuredTaskAgentRuntime } from "./execution/task-agent-runtime.js";
import { TaskExecutionEngine } from "./execution/task-execution-engine.js";
import { EnvironmentCredentialSource } from "./storage/environment-credential-source.js";
import type { ChangeSource, ValidationContract, ValidationReport } from "./domain/validation.js";
import { createValidationContract, parseValidationContract } from "./validation/contract-parser.js";
import { GitChangeSetService } from "./validation/git-change-set.js";
import { createDeterministicValidationIndex } from "./validation/deterministic-index.js";
import { SuperValidator } from "./validation/super-validator.js";
import { createPullRequestSummary } from "./domain/pr-summary.js";
import { listReviewHistory, saveReviewHistory, type ReviewHistoryRecord } from "./storage/review-history.js";

const HELP = `Conclave Code Intelligence CLI

Usage:
  conclave scan [path] [--json]
  conclave index [path] [--json]
  conclave search <path> <query> [--strategy hybrid|lexical|semantic] [--limit N] [--json]
  conclave retrieve <path> <query> [--depth N] [--limit N] [--source-bytes N] [--tokens N] [--json]
  conclave symbol <path> <symbol> [--json]
  conclave text <path> <exact text> [--json]
  conclave graph <path> <symbol-or-file> [--operation neighbors|callers|callees|imports|exports|references|containing|contained|related] [--depth N] [--limit N] [--json]
  conclave path <path> <from-symbol> <to-symbol> [--depth N] [--limit N] [--json]
  conclave ask <path> <question> [--json] [--debug]
  conclave review <path> [--working|--staged|--base <ref> [--head <ref>]|--commit <sha>] --objective <goal> [--contract <file.json>] [--json]
  conclave validate <path> [same options as review]
  conclave pr <path> [--base <ref> [--head <ref>]|--working|--staged|--commit <sha>] --objective <goal> [--json]
  conclave compare [path]                Guided branch comparison with selectable local/remote refs
  conclave history [path] [--json]
  conclave task <path> <objective> [--plan-only] [--allow-edits] [--allow-checks] [--allow-repository-scripts] [--allow-network] [--json] [--debug]
  conclave eval <path> <cases.json> [--json]
  conclave eval-graph <path> <phase2-cases.json> <graph-cases.json> [--json]
  conclave eval-reasoning <path> <reasoning-cases.json> [--json]
  conclave config [--json]
  conclave models [--provider openai|openrouter|anthropic] [--json]
  conclave init [--provider openai|openrouter|anthropic] [--profile id] [--model id] [--reasoning full|fast] [--api-key-stdin|--no-key] [--config-file path] [--json]
  conclave update [--local|--global|--check]
  conclave start [path]
  conclave skill install [--target codex|claude|both|portable] [--scope project|user] [--project path] [--destination path] [--force] [--dry-run]
  conclave provider-check
  conclave demo
  conclave mcp <path>
  conclave help

Workflow shortcuts:
  start      Guided menu for the complete PR workflow and common setup tasks
  compare    Interactive branch comparison; choose base and target from Git refs
  pr         Compare a Git source, summarize the PR, show evidence, and save local history
  review     Low-level deterministic evidence report for scripts and CI
  validate   Explicit alias for review
  history    List previous local PR passes for a repository
  update     Update the project or global CLI, or check the registry

index is an optional persistent context cache for search/graph/Ask. It is not required before pr or review.

Review sources are mutually exclusive: --working, --staged, --base <ref> [--head <ref>], or --commit <sha>.
Use --base for the comparison base and --head for the branch/commit to inspect. --branch is kept as a backwards-compatible alias for --base.
Use --objective to describe what the change should deliver. Use --json for machine-readable output.

Retrieval returns repository Evidence and deterministic graph context only. It does not generate an answer or run agents.`;

loadConclaveEnvironment();

type GraphOperation =
  | "neighbors"
  | "callers"
  | "callees"
  | "imports"
  | "exports"
  | "references"
  | "containing"
  | "contained"
  | "related";

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly strategy: RetrievalStrategy;
  readonly limit: number;
  readonly depth: number;
  readonly sourceBytes: number;
  readonly tokens: number;
  readonly graphOperation: GraphOperation;
  readonly debug: boolean;
  readonly planOnly: boolean;
  readonly allowEdits: boolean;
  readonly allowChecks: boolean;
  readonly allowRepositoryScripts: boolean;
  readonly allowNetwork: boolean;
  readonly working: boolean;
  readonly staged: boolean;
  readonly branch: string | undefined;
  readonly head: string | undefined;
  readonly commit: string | undefined;
  readonly objective: string | undefined;
  readonly contractPath: string | undefined;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  let json = false;
  let strategy: RetrievalStrategy = "hybrid";
  let limit = 10;
  let depth = 2;
  let sourceBytes = 24_000;
  let tokens = 6_000;
  let graphOperation: GraphOperation = "neighbors";
  let debug = false;
  let planOnly = false;
  let allowEdits = false;
  let allowChecks = false;
  let allowRepositoryScripts = false;
  let allowNetwork = false;
  let working = false;
  let staged = false;
  let branch: string | undefined;
  let head: string | undefined;
  let commit: string | undefined;
  let objective: string | undefined;
  let contractPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--debug") {
      debug = true;
      continue;
    }
    if (argument === "--plan-only") {
      planOnly = true;
      continue;
    }
    if (argument === "--allow-edits") {
      allowEdits = true;
      continue;
    }
    if (argument === "--allow-checks") {
      allowChecks = true;
      continue;
    }
    if (argument === "--allow-repository-scripts") {
      allowRepositoryScripts = true;
      continue;
    }
    if (argument === "--allow-network") {
      allowNetwork = true;
      continue;
    }
    if (argument === "--working") {
      working = true;
      continue;
    }
    if (argument === "--staged") {
      staged = true;
      continue;
    }
    if (argument === "--base" || argument === "--branch" || argument === "--head" || argument === "--commit" || argument === "--objective" || argument === "--contract") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(argument + " requires a value");
      }
      if (argument === "--base" || argument === "--branch") branch = value;
      else if (argument === "--head") head = value;
      else if (argument === "--commit") commit = value;
      else if (argument === "--objective") objective = value;
      else contractPath = value;
      index += 1;
      continue;
    }
    if (argument === "--strategy") {
      const value = args[index + 1];
      if (value !== "hybrid" && value !== "lexical" && value !== "semantic") {
        throw new Error("--strategy must be hybrid, lexical, or semantic");
      }
      strategy = value;
      index += 1;
      continue;
    }
    if (argument === "--limit") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 100) {
        throw new Error("--limit must be an integer between 1 and 100");
      }
      limit = value;
      index += 1;
      continue;
    }
    if (argument === "--depth") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 10) {
        throw new Error("--depth must be an integer between 1 and 10");
      }
      depth = value;
      index += 1;
      continue;
    }
    if (argument === "--source-bytes" || argument === "--tokens") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${argument} must be a positive integer`);
      }
      if (argument === "--source-bytes") sourceBytes = value;
      else tokens = value;
      index += 1;
      continue;
    }
    if (argument === "--operation") {
      const value = args[index + 1];
      const operations: readonly GraphOperation[] = [
        "neighbors",
        "callers",
        "callees",
        "imports",
        "exports",
        "references",
        "containing",
        "contained",
        "related",
      ];
      if (value === undefined || !operations.includes(value as GraphOperation)) {
        throw new Error(`--operation must be one of: ${operations.join(", ")}`);
      }
      graphOperation = value as GraphOperation;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--") === true) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (argument !== undefined) {
      positionals.push(argument);
    }
  }
  return {
    positionals,
    json,
    strategy,
    limit,
    depth,
    sourceBytes,
    tokens,
    graphOperation,
    debug,
    planOnly,
    allowEdits,
    allowChecks,
    allowRepositoryScripts,
    allowNetwork,
    working,
    staged,
    branch,
    head,
    commit,
    objective,
    contractPath,
  };
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, undefined, 2));
    return;
  }
  console.log(value);
}

function progress(label: string, detail: string): void {
  if (process.stdout.isTTY) console.log(`\x1b[36m›\x1b[0m ${label} ${detail}`);
  else console.log(`${label}: ${detail}`);
}

function requireObjective(parsed: ParsedArguments, command: "review" | "pr"): void {
  const objective = parsed.objective?.trim() ?? "";
  if (objective === "") {
    throw new Error(`${command} requires a non-empty --objective describing what the change should deliver`);
  }
}

async function scan(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0] ?? ".";
  const snapshot = await new LocalFolderRepository().load({ path: resolve(requestedPath) });
  const languageCounts = Object.fromEntries(
    [...new Set(snapshot.files.map((file) => file.language))]
      .sort()
      .map((language) => [
        language,
        snapshot.files.filter((file) => file.language === language).length,
      ]),
  );
  const report = {
    repository: snapshot.repository,
    scannedAt: snapshot.scannedAt,
    stats: snapshot.stats,
    languages: languageCounts,
  };

  if (parsed.json) {
    print(report, true);
    return;
  }
  console.log(`Repository: ${snapshot.repository.name} (${snapshot.repository.rootPath})`);
  console.log(
    `Loaded: ${String(snapshot.stats.filesLoaded)} files / ${String(snapshot.stats.bytesLoaded)} bytes`,
  );
  console.log(`Languages: ${JSON.stringify(languageCounts)}`);
  console.log(`External-context blocked: ${String(snapshot.stats.safetyBlockedFiles)} files`);
  console.log(
    `Skipped: ${String(snapshot.stats.ignoredEntries)} ignored, ${String(snapshot.stats.skippedBinaryFiles)} binary, ${String(snapshot.stats.skippedOversizedFiles)} oversized, ${String(snapshot.stats.skippedSymlinks)} symlinks`,
  );
}

function createIndexer(): {
  readonly indexer: RepositoryIndexer;
  readonly embeddingProvider: EmbeddingProvider;
} {
  const embeddingProvider = createEmbeddingProvider(process.env, new EnvironmentCredentialSource());
  return {
    embeddingProvider,
    indexer: new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new TypeScriptCodeParser(),
      embeddingProvider,
      indexStore: new FileSystemCodeIndexStore(),
    }),
  };
}

async function updateIndex(requestedPath: string) {
  const rootPath = resolve(requestedPath);
  const { indexer, embeddingProvider } = createIndexer();
  const result = await indexer.index(rootPath);
  return { ...result, embeddingProvider };
}

async function createEphemeralIndex(requestedPath: string) {
  const rootPath = resolve(requestedPath);
  const embeddingProvider = createEmbeddingProvider(process.env, new EnvironmentCredentialSource());
  const result = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(rootPath);
  return { ...result, embeddingProvider };
}

async function indexRepository(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const result = await updateIndex(parsed.positionals[0] ?? ".");
  const report = {
    repository: result.index.repository,
    stats: result.stats,
    files: Object.keys(result.index.files).length,
    symbols: Object.keys(result.index.units).length,
    graphEdges: result.index.graphEdges.length,
    embedding: result.index.embedding,
  };
  if (parsed.json) {
    print(report, true);
    return;
  }
  console.log(`Persistent repository index ready: ${report.repository.name}`);
  console.log(
    `${String(report.files)} files, ${String(report.symbols)} symbols, ${String(report.graphEdges)} graph edges`,
  );
  console.log(`Changes: ${JSON.stringify(result.stats)}`);
  console.log("Saved: .conclave/code-index-v2.json (used by search, graph, and Ask; PR review builds its own snapshot)");
}

function printEvidenceResults(results: readonly {
  readonly evidence: {
    readonly path: string;
    readonly symbol?: string;
    readonly symbolKind?: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly excerpt: string;
  };
  readonly rank?: number;
  readonly score?: number;
  readonly signals?: unknown;
  readonly reasons?: unknown;
}[]): void {
  for (const [index, result] of results.entries()) {
    const rank = result.rank ?? index + 1;
    const symbol = result.evidence.symbol === undefined ? "<file>" : result.evidence.symbol;
    const kind = result.evidence.symbolKind === undefined ? "" : ` [${result.evidence.symbolKind}]`;
    console.log(
      `#${String(rank)} ${result.evidence.path} :: ${symbol}${kind} lines ${String(result.evidence.startLine)}-${String(result.evidence.endLine)}`,
    );
    if (result.score !== undefined) {
      console.log(`score: ${result.score.toFixed(6)} signals: ${JSON.stringify(result.signals)}`);
    }
    if (result.reasons !== undefined) {
      console.log(`reasons: ${JSON.stringify(result.reasons)}`);
    }
    console.log(result.evidence.excerpt);
    console.log("");
  }
}

async function searchRepository(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const query = parsed.positionals.slice(1).join(" ").trim();
  if (requestedPath === undefined || query === "") {
    throw new Error("search requires a repository path and query");
  }
  const indexed = await updateIndex(requestedPath);
  const service = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const results = await service.search(query, { strategy: parsed.strategy, limit: parsed.limit });
  if (parsed.json) {
    print({ query, strategy: parsed.strategy, indexStats: indexed.stats, results }, true);
    return;
  }
  printEvidenceResults(results);
}

async function retrievePlannedContext(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const query = parsed.positionals.slice(1).join(" ").trim();
  if (requestedPath === undefined || query === "") {
    throw new Error("retrieve requires a repository path and query");
  }
  const indexed = await updateIndex(requestedPath);
  const service = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const retrieval = await service.retrieve(query, {
    budget: {
      graphDepth: parsed.depth,
      finalEvidence: parsed.limit,
      sourceBytes: parsed.sourceBytes,
      approximateTokens: parsed.tokens,
    },
  });
  const context = service.packContext(retrieval);
  if (parsed.json) {
    print({ query, indexStats: indexed.stats, retrieval, context }, true);
    return;
  }
  console.log(`Plan: ${retrieval.plan.reasons.join("; ")}`);
  for (const item of retrieval.plan.operations) {
    console.log(`${item.status}: ${item.kind} (${String(item.resultCount)}) — ${item.reason}`);
  }
  console.log(`Context: ${JSON.stringify(context.stats)}`);
  printEvidenceResults(
    context.evidence.map((item) => ({
      evidence: {
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        excerpt: item.excerpt,
        ...(item.symbols[0]?.name === undefined ? {} : { symbol: item.symbols[0].name }),
      },
      rank: item.rank,
      reasons: item.reasons,
    })),
  );
}

async function queryGraph(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const entity = parsed.positionals[1];
  if (requestedPath === undefined || entity === undefined) {
    throw new Error("graph requires a repository path and symbol or indexed file");
  }
  const indexed = await updateIndex(requestedPath);
  const graph = new CodeRetrievalService(indexed.index, indexed.embeddingProvider).graph;
  const fileResolution = graph.getNodeByFile(entity);
  const resolution = fileResolution.status === "resolved" ? fileResolution : graph.getNodeBySymbol(entity);
  if (resolution.status !== "resolved") {
    print({ entity, resolution }, parsed.json);
    return;
  }
  const limits = { maxDepth: parsed.depth, maxNodes: parsed.limit };
  const reference = resolution.node.reference;
  const results = (() => {
    switch (parsed.graphOperation) {
      case "neighbors":
        return graph.neighbors(reference, limits);
      case "callers":
        return graph.callers(reference, limits);
      case "callees":
        return graph.callees(reference, limits);
      case "imports":
        return graph.imports(reference, limits);
      case "exports":
        return graph.exports(reference, limits);
      case "references":
        return graph.references(reference, limits);
      case "containing":
        return graph.containingSymbol(reference, limits);
      case "contained":
        return graph.containedSymbols(reference, limits);
      case "related":
        return graph.relatedFiles(reference, limits);
    }
  })();
  if (parsed.json) {
    print({ entity, operation: parsed.graphOperation, resolution, limits, results }, true);
    return;
  }
  console.log(`${resolution.node.path} :: ${resolution.node.symbol ?? "<file>"}`);
  for (const result of results) {
    console.log(
      `${result.direction} ${result.edge.relation} -> ${result.node.path} :: ${result.node.symbol ?? "<file>"}`,
    );
    console.log(
      `  ${result.edge.provenance.kind}/${result.edge.provenance.resolutionMethod} at ${result.edge.provenance.path}:${String(result.edge.provenance.line ?? 1)} — ${result.edge.provenance.reason}`,
    );
  }
}

async function queryPath(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const from = parsed.positionals[1];
  const to = parsed.positionals[2];
  if (requestedPath === undefined || from === undefined || to === undefined) {
    throw new Error("path requires a repository path, source symbol, and target symbol");
  }
  const indexed = await updateIndex(requestedPath);
  const graph = new CodeRetrievalService(indexed.index, indexed.embeddingProvider).graph;
  const result = graph.shortestPathBetweenSymbols(from, to, {
    maxDepth: parsed.depth,
    maxNodes: parsed.limit,
  });
  if (parsed.json) {
    print({ from, to, result }, true);
    return;
  }
  if (result.status !== "found") {
    print(result, false);
    return;
  }
  console.log(result.nodes.map((node) => node.symbol ?? node.path).join(" -> "));
  for (const edge of result.edges) {
    console.log(
      `${edge.relation} at ${edge.provenance.path}:${String(edge.provenance.line ?? 1)} (${edge.provenance.kind}/${edge.provenance.resolutionMethod})`,
    );
  }
}

async function findSymbol(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const symbol = parsed.positionals[1];
  if (requestedPath === undefined || symbol === undefined) {
    throw new Error("symbol requires a repository path and symbol name");
  }
  const indexed = await updateIndex(requestedPath);
  const evidence = new CodeRetrievalService(indexed.index, indexed.embeddingProvider).findSymbol(symbol);
  if (parsed.json) {
    print({ symbol, evidence }, true);
    return;
  }
  printEvidenceResults(evidence.map((item, index) => ({ evidence: item, rank: index + 1 })));
}

async function searchExactText(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const text = parsed.positionals.slice(1).join(" ");
  if (requestedPath === undefined || text === "") {
    throw new Error("text requires a repository path and exact text");
  }
  const indexed = await updateIndex(requestedPath);
  const evidence = new CodeRetrievalService(indexed.index, indexed.embeddingProvider).searchText(text, {
    limit: parsed.limit,
  });
  if (parsed.json) {
    print({ text, evidence }, true);
    return;
  }
  printEvidenceResults(evidence.map((item, index) => ({ evidence: item, rank: index + 1 })));
}

async function evaluateRetrieval(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const casesPath = parsed.positionals[1];
  if (requestedPath === undefined || casesPath === undefined) {
    throw new Error("eval requires a repository path and evaluation-cases JSON path");
  }
  const indexed = await updateIndex(requestedPath);
  const service = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const report = await runRetrievalEvaluation(service, await loadEvaluationCases(resolve(casesPath)));
  print(report, parsed.json);
}

async function evaluateGraphRetrieval(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const casePaths = parsed.positionals.slice(1);
  if (requestedPath === undefined || casePaths.length === 0) {
    throw new Error("eval-graph requires a repository path and one or more evaluation-case JSON paths");
  }
  const indexed = await updateIndex(requestedPath);
  const service = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const caseGroups = await Promise.all(casePaths.map((path) => loadEvaluationCases(resolve(path))));
  const report = await runGraphAwareRetrievalEvaluation(service, caseGroups.flat());
  print(report, parsed.json);
}

async function askRepository(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const question = parsed.positionals.slice(1).join(" ").trim();
  if (requestedPath === undefined || question === "") {
    throw new Error("ask requires a repository path and question");
  }
  const runtimeConfig = loadRuntimeConfig();
  const reasoningConfig = loadReasoningConfiguration(runtimeConfig);
  const provider = createProvider(runtimeConfig, new EnvironmentCredentialSource());
  const indexed = await updateIndex(requestedPath);
  const runtime = new StructuredAgentRuntime(
    new Map([[provider.id, provider]]),
    reasoningConfig.assignments,
    DEFAULT_REASONING_LIMITS,
  );
  const result = await new ReasoningEngine({
    retrieval: new CodeRetrievalService(indexed.index, indexed.embeddingProvider),
    runtime,
    preset: reasoningConfig.preset,
  }).ask(question);
  if (parsed.json) {
    print(parsed.debug ? result : { verdict: result.verdict, metrics: result.metrics, terminationReason: result.terminationReason }, true);
    return;
  }
  console.log(result.verdict.answer);
  console.log("");
  for (const [label, claims] of [
    ["Supported claims", result.verdict.claims.supported],
    ["Rejected claims", result.verdict.claims.rejected],
    ["Uncertain claims", result.verdict.claims.uncertain],
  ] as const) {
    console.log(`${label}:`);
    for (const claim of claims) console.log(`- ${claim.statement}`);
  }
  console.log("Evidence:");
  for (const evidence of result.verdict.evidence) {
    console.log(
      `- ${evidence.path}:${String(evidence.startLine)}-${String(evidence.endLine)}${evidence.symbol === undefined ? "" : ` — ${evidence.symbol}`}`,
    );
  }
  console.log(`Agents executed: ${result.verdict.traceSummary.agentsExecuted.join(", ")}`);
  for (const skipped of result.verdict.traceSummary.agentsSkipped) {
    console.log(`Agent skipped: ${skipped.role} — ${skipped.reason}`);
  }
  console.log(
    `Follow-ups: ${String(result.metrics.followUpRequests)}; retrieval rounds: ${String(result.metrics.retrievalRounds)}; model calls: ${String(result.metrics.modelCalls)}`,
  );
  console.log(
    `Approximate model context: ${String(result.metrics.approximateInputTokens)} input / ${String(result.metrics.approximateOutputTokens)} output tokens`,
  );
  if (parsed.debug) {
    console.log("Trace:");
    for (const event of result.trace) {
      console.log(`${String(event.sequence)} ${event.type}: ${event.detail}`);
    }
  }
}

async function evaluateReasoning(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const casesPath = parsed.positionals[1];
  if (requestedPath === undefined || casesPath === undefined) {
    throw new Error("eval-reasoning requires a repository path and reasoning-cases JSON path");
  }
  const runtimeConfig = loadRuntimeConfig();
  const reasoningConfig = loadReasoningConfiguration(runtimeConfig);
  const provider = createProvider(runtimeConfig, new EnvironmentCredentialSource());
  const indexed = await updateIndex(requestedPath);
  const retrieval = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const report = await runReasoningEvaluation(
    await loadReasoningEvaluationCases(resolve(casesPath)),
    () =>
      Promise.resolve(new ReasoningEngine({
        retrieval,
        runtime: new StructuredAgentRuntime(
          new Map([[provider.id, provider]]),
          reasoningConfig.assignments,
          DEFAULT_REASONING_LIMITS,
        ),
        preset: reasoningConfig.preset,
      })),
  );
  print(report, parsed.json);
}

function selectedChangeSource(parsed: ParsedArguments): ChangeSource {
  const selected: ChangeSource[] = [];
  if (parsed.working) selected.push({ kind: "working" });
  if (parsed.staged) selected.push({ kind: "staged" });
  if (parsed.head !== undefined && parsed.branch === undefined) {
      throw new Error("--head requires --base <ref>; use --head to name the branch being inspected");
  }
  if (parsed.branch !== undefined) {
    selected.push(parsed.head === undefined
      ? { kind: "branch", base: parsed.branch }
      : { kind: "branch", base: parsed.branch, head: parsed.head });
  }
  if (parsed.commit !== undefined) selected.push({ kind: "commit", commit: parsed.commit });
  if (selected.length > 1) {
    throw new Error("review accepts exactly one of --working, --staged, --base, or --commit");
  }
  return selected[0] ?? { kind: "working" };
}

function runExternalCommand(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} was terminated by ${signal}`));
      } else {
        resolvePromise(code ?? 1);
      }
    });
  });
}

function captureExternalCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: cwd === undefined ? undefined : resolve(cwd),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`${command} was terminated by ${signal}`));
      else resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] => value.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

async function updateConclave(args: readonly string[]): Promise<void> {
  const modes = args.filter((argument): argument is "--local" | "--global" | "--check" =>
    argument === "--local" || argument === "--global" || argument === "--check");
  const unknown = args.filter((argument) => argument !== "--local" && argument !== "--global" && argument !== "--check");
  if (unknown.length > 0 || modes.length > 1) {
    throw new Error("update accepts one of --local, --global, or --check");
  }
  const mode = modes[0] ?? "--local";
  if (mode === "--check") {
    const result = await captureExternalCommand("npm", ["view", "conclave-ai", "version"]);
    if (result.code !== 0) {
      process.stderr.write(result.stderr);
      process.exitCode = result.code;
    } else console.log(result.stdout.trim());
    return;
  }
  const latest = await captureExternalCommand("npm", ["view", "conclave-ai", "version"]);
  if (latest.code !== 0) {
    process.stderr.write(latest.stderr);
    process.exitCode = latest.code;
    return;
  }
  const current = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version?: string };
  const currentVersion = current.version ?? "0.0.0";
  const latestVersion = latest.stdout.trim();
  if (compareVersions(currentVersion, latestVersion) >= 0) {
    throw new Error(`Conclave já está na versão mais recente (${currentVersion}). Nenhuma atualização foi necessária.`);
  }
  const commandArgs = mode === "--global"
    ? ["install", "--global", "conclave-ai@latest"]
    : ["install", "--save-dev", "conclave-ai@latest"];
  console.log(`Updating Conclave ${mode === "--global" ? "globally" : "in this project"}...`);
  const code = await runExternalCommand("npm", commandArgs);
  if (code !== 0) process.exitCode = code;
  else console.log("Conclave updated. Run `conclave --version` or `npm list conclave-ai` to confirm.");
}

async function showVersion(): Promise<void> {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { version?: string };
  console.log(packageJson.version ?? "unknown");
}

type GuidedChoice = { readonly id: string; readonly label: string; readonly description: string };

async function gitBranchChoices(root: string): Promise<readonly GuidedChoice[]> {
  const result = await captureExternalCommand(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "--sort=refname", "refs/heads", "refs/remotes"],
    root,
  );
  if (result.code !== 0) {
    throw new Error(`Could not list Git branches: ${result.stderr.trim() || "this folder is not a Git repository"}`);
  }
  const currentResult = await captureExternalCommand("git", ["branch", "--show-current"], root);
  const current = currentResult.code === 0 ? currentResult.stdout.trim() : "";
  const refs = [...new Set(result.stdout
    .split(/\r?\n/u)
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "" && !ref.endsWith("/HEAD")))];
  if (current !== "" && refs.includes(current)) {
    refs.splice(refs.indexOf(current), 1);
    refs.unshift(current);
  }
  return refs.map((ref) => ({
    id: ref,
    label: ref === current ? `${ref} (checked out)` : ref,
    description: ref.startsWith("remotes/") ? "Remote-tracking branch" : "Local branch",
  }));
}

async function promptBranch(root: string, label: string, exclude?: string): Promise<string> {
  const choices = (await gitBranchChoices(root)).filter((choice) => choice.id !== exclude);
  if (choices.length === 0) {
    return promptLine(`${label} (Git ref)`, exclude === undefined ? "" : "HEAD");
  }
  const manual: GuidedChoice = {
    id: "__manual__",
    label: "Enter another Git ref",
    description: "Type a branch, tag, commit, or remote ref manually",
  };
  const selected = await promptChoice(label, [...choices, manual], terminalColorEnabled());
  return selected.id === manual.id ? promptLine("Git ref") : selected.id;
}

async function compareBranches(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const root = resolve(parsed.positionals[0] ?? ".");
  let base = parsed.branch;
  let head = parsed.head;
  if ((base === undefined) !== (head === undefined)) {
    throw new Error("compare needs both --base and --head, or no flags for the interactive selector");
  }
  if (base === undefined || head === undefined) {
    base = await promptBranch(root, "Choose the comparison base branch");
    head = await promptBranch(root, "Choose the branch to inspect", base);
  }
  if (base === head) throw new Error("Base and target must be different branches");
  const objective = parsed.objective?.trim() === "" || parsed.objective === undefined
    ? await promptLine("What should this change deliver?")
    : parsed.objective;
  const forwarded = [root, "--base", base, "--head", head, "--objective", objective];
  if (parsed.json) forwarded.push("--json");
  await pullRequestSummary(forwarded);
}

async function guidedChangeSource(root: string, color: boolean): Promise<readonly string[]> {
  const source = await promptChoice(
    "Which change should Conclave check?",
    [
      { id: "branch", label: "Compare two branches", description: "Choose a base and target branch without changing checkout (recommended for PRs)" },
      { id: "working", label: "Working tree", description: "Check tracked unstaged changes; stage or ignore untracked files first" },
      { id: "staged", label: "Staged files", description: "Check only what is in the Git index" },
      { id: "commit", label: "One commit", description: "Check a commit that already exists in Git" },
    ],
    color,
  );
  if (source.id === "branch") {
    const base = await promptBranch(root, "Choose the comparison base branch");
    const head = await promptBranch(root, "Choose the branch to inspect", base);
    return [
      root,
      "--base",
      base,
      "--head",
      head,
    ];
  }
  if (source.id === "commit") {
    return [root, "--commit", await promptLine("Commit", "HEAD")];
  }
  return [root, `--${source.id}`];
}

async function startGuided(path = "."): Promise<void> {
  const root = resolve(path);
  const choices: readonly GuidedChoice[] = [
    { id: "pr", label: "Run a complete PR pass", description: "Compare a branch, summarize the change, show evidence, and save history" },
    { id: "compare", label: "Compare branches", description: "Choose the base and target branch from a list, then run the PR pass" },
    { id: "review", label: "Review evidence (advanced)", description: "Run the low-level deterministic report for a working tree, branch, staged change, or commit" },
    { id: "understand", label: "Understand this repository", description: "Build a local index and inspect files, code units, and relationships" },
    { id: "ask", label: "Ask about the code", description: "Use a configured provider to investigate a repository question" },
    { id: "task", label: "Plan or execute a task", description: "Use a configured agent with explicit permissions and a final check" },
    { id: "setup", label: "Configure a provider", description: "Choose OpenAI/Codex, OpenRouter, or Anthropic and a model" },
    { id: "update", label: "Update Conclave", description: "Install the latest CLI version" },
    { id: "history", label: "Show PR history", description: "List previous local PR passes for this repository" },
    { id: "help", label: "Show all commands", description: "Print the complete CLI reference" },
  ];
  console.log("\nConclave — your PR companion\n");
  console.log(`Repository: ${root}`);
  const choice = await promptChoice("What do you want to do?", choices, terminalColorEnabled());
  const color = terminalColorEnabled();
  switch (choice.id) {
    case "compare":
      await compareBranches([root]);
      return;
    case "pr": {
      const source = await guidedChangeSource(root, color);
      const objective = await promptLine("What should this change deliver?");
      await pullRequestSummary([...source, "--objective", objective]);
      return;
    }
    case "review": {
      const source = await guidedChangeSource(root, color);
      const objective = await promptLine("What should this change deliver?");
      await reviewChanges([...source, "--objective", objective]);
      return;
    }
    case "understand":
      await indexRepository([root]);
      console.log("\nNext: use `conclave search`, `conclave graph`, or choose Ask from this menu.");
      return;
    case "ask": {
      const question = await promptLine("Question");
      await askRepository([root, question]);
      return;
    }
    case "task": {
      const objective = await promptLine("What should the agent do?");
      await executeTask([root, objective, "--plan-only"]);
      return;
    }
    case "setup":
      await initializeConclave([]);
      return;
    case "update":
      await updateConclave([]);
      return;
    case "history":
      await showReviewHistory([root]);
      return;
    default:
      console.log(HELP);
  }
}

async function loadValidationContract(parsed: ParsedArguments): Promise<ValidationContract> {
  if (parsed.contractPath === undefined) {
    return createValidationContract(parsed.objective ?? "");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(parsed.contractPath), "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown contract error";
    throw new Error("Could not load validation contract: " + message, { cause: error });
  }
  return parseValidationContract(value, parsed.objective);
}

async function reviewChanges(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  if (requestedPath === undefined || parsed.positionals.length !== 1) {
    throw new Error("review requires exactly one repository path; use --objective for the goal");
  }
  requireObjective(parsed, "review");
  const repositoryRoot = resolve(requestedPath);
  const contract = await loadValidationContract(parsed);
  const changeService = new GitChangeSetService();
  const source = selectedChangeSource(parsed);
  const changeSet = await changeService.collect(repositoryRoot, source);
  const materialized = await changeService.materializeValidationRoot(repositoryRoot, source);
  try {
    const indexed = await createDeterministicValidationIndex(materialized.rootPath);
    const report = new SuperValidator().validate(indexed.index, changeSet, contract);

    if (parsed.json) {
      print(report, true);
    } else {
      printValidationReport(report);
    }

    if (report.verdict === "block") process.exitCode = 1;
    else if (report.verdict === "inconclusive") process.exitCode = 2;
  } finally {
    await materialized.cleanup();
  }
}

function printValidationReport(report: ValidationReport): void {
    console.log("Validation verdict: " + report.verdict.toUpperCase());
    console.log(report.summary);
    console.log("Objective: " + (report.objective === "" ? "<missing>" : report.objective));
    if (report.changeSet.source.kind === "branch") {
      const head = report.changeSet.source.head ?? "HEAD (checked-out branch)";
      console.log("Comparison: " + head + " against " + report.changeSet.source.base + " (base branch)");
    }
    console.log(
      "Changed: " + String(report.metrics.filesChanged) + " files / " +
      String(report.metrics.symbolsChanged) + " symbols",
    );
    console.log(
      "Impact: " + String(report.metrics.impactedFiles) + " files / " +
      String(report.metrics.impactedSymbols) + " symbols",
    );
    if (report.changeSet.files.length > 0) {
      console.log("Changed files:");
      for (const file of report.changeSet.files) {
        const hunks = file.hunks.length === 0
          ? "no hunks"
          : String(file.hunks.length) + " hunk" + (file.hunks.length === 1 ? "" : "s");
        const previous = file.previousPath === undefined ? "" : ` (from ${file.previousPath})`;
        console.log(`- ${file.status}: ${file.path}${previous} — ${hunks}`);
      }
    }
    for (const item of report.findings) {
      console.log("");
      console.log(item.severity.toUpperCase() + " " + item.kind + ": " + item.title);
      console.log(item.detail);
      for (const evidence of item.evidence) {
        const range = evidence.startLine === undefined
          ? ""
          : ":" + String(evidence.startLine) +
            (evidence.endLine === undefined ? "" : "-" + String(evidence.endLine));
        console.log("- " + evidence.path + range + " — " + evidence.reason);
      }
      console.log("Next: " + item.remediation);
    }
    for (const result of report.claims) {
      console.log("");
      console.log("CLAIM " + result.outcome.toUpperCase() + ": " + result.claim.statement);
      console.log(result.explanation);
    }
}

async function pullRequestSummary(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  if (requestedPath === undefined || parsed.positionals.length !== 1) {
    throw new Error("pr requires exactly one repository path and an objective");
  }
  requireObjective(parsed, "pr");
  const repositoryRoot = resolve(requestedPath);
  const contract = await loadValidationContract(parsed);
  if (!parsed.json) progress("Collecting", "Git change");
  const changeService = new GitChangeSetService();
  const source = selectedChangeSource(parsed);
  const changeSet = await changeService.collect(repositoryRoot, source);
  if (!parsed.json) progress("Indexing", "local repository context");
  const materialized = await changeService.materializeValidationRoot(repositoryRoot, source);
  try {
    const indexed = await createDeterministicValidationIndex(materialized.rootPath);
    if (!parsed.json) progress("Validating", "objective, impact, and claims");
    const report = new SuperValidator().validate(indexed.index, changeSet, contract);
  const summary = createPullRequestSummary(report);
  const record: ReviewHistoryRecord = {
    id: createHash("sha256").update(JSON.stringify({ headSha: report.changeSet.headSha, source: report.changeSet.source, objective: report.objective })).digest("hex").slice(0, 24),
    createdAt: new Date().toISOString(),
    repository: repositoryRoot,
    objective: report.objective,
    headSha: report.changeSet.headSha,
    summary,
  };
  await saveReviewHistory(repositoryRoot, record);
    if (parsed.json) {
      print({ summary, report }, true);
    } else {
    console.log(`\nPR summary: ${summary.title}`);
    console.log(`Comparison: ${summary.comparison}`);
    console.log(summary.summary);
    console.log(`Verdict: ${summary.verdict.toUpperCase()}`);
    if (summary.changedFiles.length > 0) {
      console.log("\nChanged files:");
      for (const file of summary.changedFiles) console.log(`- ${file.status}: ${file.path} (${String(file.hunks)} hunks)`);
    }
    if (summary.risks.length > 0) {
      console.log("\nRisks:");
      for (const risk of summary.risks) console.log(`- ${risk}`);
    }
    console.log("\nNext steps:");
    for (const step of summary.nextSteps) console.log(`- ${step}`);
    console.log("\nFull evidence: run the same command with --json.");
    }
    if (report.verdict === "block") process.exitCode = 1;
    else if (report.verdict === "inconclusive") process.exitCode = 2;
  } finally {
    await materialized.cleanup();
  }
}

async function showReviewHistory(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const repositoryRoot = resolve(parsed.positionals[0] ?? ".");
  const records = await listReviewHistory(repositoryRoot);
  if (parsed.json) {
    print(records, true);
    return;
  }
  if (records.length === 0) {
    console.log("No Conclave PR reviews recorded for this repository yet.");
    return;
  }
  console.log(`Review history: ${repositoryRoot}`);
  for (const record of records) {
    console.log(`- ${record.createdAt} ${record.summary.verdict.toUpperCase()} ${record.summary.title} — ${record.objective}`);
  }
}

async function executeTask(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const objective = parsed.positionals.slice(1).join(" ").trim();
  if (requestedPath === undefined || objective === "") {
    throw new Error("task requires a repository path and explicit objective");
  }
  if (parsed.allowRepositoryScripts && !parsed.allowChecks) {
    throw new Error("--allow-repository-scripts requires --allow-checks");
  }
  if (parsed.allowNetwork && !parsed.allowRepositoryScripts) {
    throw new Error("--allow-network requires --allow-repository-scripts");
  }
  const runtimeConfig = loadRuntimeConfig();
  const reasoningConfig = loadReasoningConfiguration(runtimeConfig);
  const taskConfig = loadTaskConfiguration(runtimeConfig);
  const provider = createProvider(runtimeConfig, new EnvironmentCredentialSource());
  const indexed = await createEphemeralIndex(requestedPath);
  const providers = new Map([[provider.id, provider]]);
  const reasoning = new ReasoningEngine({
    retrieval: new CodeRetrievalService(indexed.index, indexed.embeddingProvider),
    runtime: new StructuredAgentRuntime(
      providers,
      reasoningConfig.assignments,
      DEFAULT_REASONING_LIMITS,
    ),
    preset: reasoningConfig.preset,
  });
  const result = await new TaskExecutionEngine({
    investigator: reasoning,
    taskRuntime: new StructuredTaskAgentRuntime(
      providers,
      taskConfig.assignments,
      DEFAULT_TASK_EXECUTION_LIMITS,
    ),
    permissions: {
      allowFileEdits: parsed.allowEdits && !parsed.planOnly,
      allowCommands: parsed.allowChecks && !parsed.planOnly,
      allowRepositoryScripts: parsed.allowRepositoryScripts && !parsed.planOnly,
      allowNetwork: parsed.allowNetwork && !parsed.planOnly,
    },
    limits: DEFAULT_TASK_EXECUTION_LIMITS,
    allowedPackageScripts: taskConfig.allowedPackageScripts,
  }).execute({
    intent: "task",
    repositoryRoot: requestedPath,
    objective,
    planOnly: parsed.planOnly,
  });
  if (parsed.json) {
    print(
      parsed.debug
        ? result
        : {
            task: result.task,
            diagnosisClaims: result.diagnosisClaims,
            patchRecords: result.patchRecords,
            review: result.review,
            verdict: result.verdict,
            metrics: result.metrics,
          },
      true,
    );
    return;
  }
  console.log(`Task verdict: ${result.verdict.status}`);
  console.log(result.verdict.summary);
  console.log(`Plan: ${result.task.plan.summary}`);
  for (const requirement of result.verdict.requirements) {
    console.log(`Requirement ${requirement.outcome}: ${requirement.requirementId} — ${requirement.explanation}`);
  }
  for (const file of result.verdict.changedFiles) {
    console.log(
      `Changed: ${file.path} (+${String(file.additions)}/-${String(file.deletions)})${file.expectedByPlan ? "" : " [unexpected]"}`,
    );
  }
  for (const record of result.patchRecords) console.log(record.unifiedDiff);
  for (const check of result.verdict.checks) {
    console.log(`Check ${check.status}: ${check.requestId} (${check.command.kind})`);
  }
  for (const finding of result.review.findings) {
    console.log(`Review ${finding.severity}: ${finding.statement}`);
  }
  console.log(
    `Usage: investigation ${String(result.metrics.investigation.modelCalls)} calls; task ${String(result.metrics.taskModelCalls)} calls; ${String(result.metrics.commandCount)} commands; ${String(result.metrics.approximateInputTokens)} approximate task input tokens`,
  );
  if (parsed.debug) {
    console.log("Trace:");
    for (const event of result.trace) console.log(`${String(event.sequence)} ${event.type}: ${event.detail}`);
  }
}

function showConfig(args: readonly string[]): void {
  const credentials = new EnvironmentCredentialSource();
  const report = describeRuntimeConfig(loadRuntimeConfig(), credentials);
  print(report, args.includes("--json"));
}

interface InitArguments {
  readonly provider: GuidedProviderId | undefined;
  readonly profile: string | undefined;
  readonly model: string | undefined;
  readonly reasoning: "full" | "fast" | undefined;
  readonly apiKeyStdin: boolean;
  readonly noKey: boolean;
  readonly envFile: string;
  readonly json: boolean;
}

function parseInitArguments(args: readonly string[]): InitArguments {
  let provider: GuidedProviderId | undefined;
  let profile: string | undefined;
  let model: string | undefined;
  let reasoning: "full" | "fast" | undefined;
  let apiKeyStdin = false;
  let noKey = false;
  let envFile = resolve(".env");
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--api-key-stdin") {
      apiKeyStdin = true;
      continue;
    }
    if (argument === "--no-key") {
      noKey = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument !== "--provider" && argument !== "--profile" && argument !== "--model" && argument !== "--reasoning" && argument !== "--config-file") {
      throw new Error(`Unknown init option: ${argument ?? ""}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--provider") {
      if (!isGuidedProviderId(value)) throw new Error("--provider must be openai, openrouter, or anthropic");
      provider = value;
    } else if (argument === "--profile") {
      profile = value;
    } else if (argument === "--model") {
      model = value;
    } else if (argument === "--reasoning") {
      if (value !== "full" && value !== "fast") throw new Error("--reasoning must be full or fast");
      reasoning = value;
    } else {
      envFile = resolve(value);
    }
    index += 1;
  }
  if (apiKeyStdin && noKey) throw new Error("--api-key-stdin and --no-key cannot be used together");
  return { provider, profile, model, reasoning, apiKeyStdin, noKey, envFile, json };
}

async function promptLine(label: string, fallback?: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("init needs --provider and --api-key-stdin/--no-key when stdin is not a TTY");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(fallback === undefined ? `${label}: ` : `${label} [${fallback}]: `);
    const value = answer.trim();
    return value === "" && fallback !== undefined ? fallback : value;
  } finally {
    readline.close();
  }
}

async function promptChoice<T extends { readonly id: string; readonly label: string; readonly description: string }>(
  label: string,
  choices: readonly T[],
  color = false,
): Promise<T> {
  console.log(label);
  for (const [index, choice] of choices.entries()) {
    console.log(renderSetupChoice(index + 1, choice, color));
  }
  const answer = await promptLine("Choose", "1");
  const numeric = Number(answer);
  const selected = Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length
    ? choices[numeric - 1]
    : choices.find((choice) => choice.id === answer);
  if (selected === undefined) throw new Error(`Unknown selection: ${answer}`);
  return selected;
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Use --api-key-stdin to provide a key in a non-interactive environment");
  }
  process.stdout.write(`${label}: `);
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const input = process.stdin;
    const finish = (): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Setup cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolvePromise(value);
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function readApiKeyFromStandardInput(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) {
    if (typeof chunk === "string") {
      value += chunk;
    } else if (chunk instanceof Uint8Array) {
      value += new TextDecoder().decode(chunk);
    } else {
      throw new Error("API key input must be text");
    }
  }
  return value.trim();
}

async function initializeConclave(args: readonly string[]): Promise<void> {
  const parsed = parseInitArguments(args);
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const color = terminalColorEnabled();
  const providerChoices = (["openai", "openrouter", "anthropic"] as const).map((id) => {
    const guide = providerSetupGuide(id);
    return { id, label: guide.label, description: guide.summary };
  });
  if (interactive && !parsed.json) console.log(renderSetupBanner(color));
  const provider = parsed.provider ?? (await promptChoice(
    renderSetupStep(1, 4, "Provider", "Choose who should power optional Ask and Task reasoning. Review never uses this key.", color),
    providerChoices,
    color,
  )).id;
  if (interactive && parsed.provider !== undefined && !parsed.json) {
    console.log(renderSetupStep(1, 4, "Provider", `${providerSetupGuide(provider).label} selected from --provider.`, color));
  }
  const selectedProfile = interactive && parsed.profile === undefined && parsed.model === undefined
    ? await promptChoice(
      renderSetupStep(2, 4, "Model profile", "Start from a maintained profile or pass --model for an exact provider model ID.", color),
      providerProfiles(provider),
      color,
    )
    : undefined;
  const selectedStyle = interactive && parsed.reasoning === undefined
    ? await promptChoice(
      renderSetupStep(3, 4, "Reasoning", "Choose the depth used by optional API-backed repository reasoning.", color),
      REASONING_STYLES,
      color,
    )
    : undefined;
  let apiKey: string | undefined;
  if (interactive && !parsed.json) {
    console.log(renderSetupStep(4, 4, "Credentials", "The value is hidden and saved only in the local configuration file.", color));
    console.log(renderProviderGuide(provider, color));
  }
  if (!parsed.noKey) {
    apiKey = parsed.apiKeyStdin
      ? await readApiKeyFromStandardInput()
      : await promptSecret("Paste API key (hidden)");
  }
  const profileId = parsed.profile ?? selectedProfile?.id;
  const reasoningStyleId = parsed.reasoning ?? selectedStyle?.id;
  const setup = createSetupConfiguration({
    provider,
    ...(profileId === undefined ? {} : { profileId }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(reasoningStyleId === undefined ? {} : { reasoningStyleId }),
    ...(apiKey === undefined ? {} : { apiKey }),
  });
  const write = await writeConclaveEnvironment(parsed.envFile, setup.environment);
  const report = {
    configFile: write.path,
    updated: write.updated,
    provider: setup.provider,
    model: setup.model,
    reasoningPreset: setup.reasoningPreset,
    credentialSaved: setup.credentialSaved,
    validation: "conclave review is deterministic and never sends repository data or API keys to a model",
    next: setup.credentialSaved ? "Run `conclave provider-check` to test the selected provider." : "Set CONCLAVE_API_KEY later, then run `conclave provider-check`.",
  };
  if (parsed.json) {
    print(report, true);
    return;
  }
  console.log(renderSetupSuccess(report, color));
}

function showModels(args: readonly string[]): void {
  const providerFlagIndex = args.indexOf("--provider");
  const requested = providerFlagIndex === -1 ? undefined : args[providerFlagIndex + 1];
  if (providerFlagIndex !== -1 && (requested === undefined || !isGuidedProviderId(requested))) {
    throw new Error("models --provider must be openai, openrouter, or anthropic");
  }
  if (args.some((argument, index) => argument.startsWith("--") && argument !== "--json" && !(argument === "--provider" && index === providerFlagIndex))) {
    throw new Error("models accepts only --provider and --json");
  }
  const providers: readonly GuidedProviderId[] = requested === undefined
    ? ["openai", "openrouter", "anthropic"]
    : [requested as GuidedProviderId];
  const report = providers.map((provider) => ({ provider, profiles: providerProfiles(provider) }));
  if (args.includes("--json")) {
    print({ providers: report, reasoningStyles: REASONING_STYLES }, true);
    return;
  }
  for (const item of report) {
    console.log(item.provider);
    for (const profile of item.profiles) console.log(`  ${profile.id}: ${profile.model} — ${profile.description}`);
  }
  console.log("Reasoning: full includes architecture review for complex cross-module questions; fast skips that role.");
}

async function installSkill(args: readonly string[]): Promise<void> {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/install-agent-skill.mjs");
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Skill installation failed with exit code ${String(exitCode)}`);
}

async function providerCheck(): Promise<void> {
  const credentials = new EnvironmentCredentialSource();
  const config = loadRuntimeConfig();
  print(await diagnoseProvider(config, credentials), true);
}

async function startMcp(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  if (requestedPath === undefined) throw new Error("mcp requires one repository path; clients cannot select arbitrary host paths");
  const taskRequested = args.includes("--allow-task-mode");
  if (taskRequested) throw new Error("MCP Task Mode is not exposed in this release; the MCP server is read-only");
  const createReasoning = (() => {
    try {
      const runtimeConfig = loadRuntimeConfig();
      const reasoningConfig = loadReasoningConfiguration(runtimeConfig);
      const provider = createProvider(runtimeConfig, new EnvironmentCredentialSource());
      return (retrieval: CodeRetrievalService) => new ReasoningEngine({
        retrieval,
        runtime: new StructuredAgentRuntime(new Map([[provider.id, provider]]), reasoningConfig.assignments, DEFAULT_REASONING_LIMITS),
        preset: reasoningConfig.preset,
      });
    } catch {
      return undefined;
    }
  })();
  const service = await ConclaveMcpService.open({
    repositoryRoot: requestedPath,
    allowedRoot: process.env["CONCLAVE_MCP_ALLOWED_ROOT"] ?? requestedPath,
    ...(createReasoning === undefined ? {} : { createReasoning }),
  });
  await runMcpStdio(service);
}

async function runDemo(): Promise<void> {
  const product = new ConclaveProductService();
  const project = await product.openDemo();
  const ask = await product.run(project.id, "ask", "Where is bootstrapSession called?");
  const investigate = await product.run(project.id, "investigate", "Why might authentication disappear after refresh?");
  const task = await product.task(project.id, "Fix authentication disappearing after refresh.", false, { allowFileEdits: true, allowCommands: false, allowRepositoryScripts: false, allowNetwork: false });
  print({ deterministicDemo: true, project, ask, investigate, task }, true);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (process.argv.length === 2 && process.stdin.isTTY && process.stdout.isTTY) {
    await startGuided();
    return;
  }
  switch (command) {
    case "--version":
    case "-v":
      await showVersion();
      return;
    case "scan":
      await scan(args);
      return;
    case "index":
      await indexRepository(args);
      return;
    case "search":
      await searchRepository(args);
      return;
    case "retrieve":
      await retrievePlannedContext(args);
      return;
    case "symbol":
      await findSymbol(args);
      return;
    case "text":
      await searchExactText(args);
      return;
    case "graph":
      await queryGraph(args);
      return;
    case "path":
      await queryPath(args);
      return;
    case "ask":
      await askRepository(args);
      return;
    case "review":
      await reviewChanges(args);
      return;
    case "validate":
      await reviewChanges(args);
      return;
    case "pr":
      await pullRequestSummary(args);
      return;
    case "compare":
      await compareBranches(args);
      return;
    case "history":
      await showReviewHistory(args);
      return;
    case "update":
      await updateConclave(args);
      return;
    case "start":
      await startGuided(args[0] ?? ".");
      return;
    case "task":
      await executeTask(args);
      return;
    case "eval":
      await evaluateRetrieval(args);
      return;
    case "eval-graph":
      await evaluateGraphRetrieval(args);
      return;
    case "eval-reasoning":
      await evaluateReasoning(args);
      return;
    case "config":
      showConfig(args);
      return;
    case "models":
      showModels(args);
      return;
    case "init":
      await initializeConclave(args);
      return;
    case "skill":
      if (args[0] !== "install") throw new Error("skill requires the install subcommand");
      await installSkill(args.slice(1));
      return;
    case "provider-check":
      await providerCheck();
      return;
    case "mcp":
      await startMcp(args);
      return;
    case "demo":
      await runDemo();
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Conclave error: ${message}`);
  process.exitCode = 1;
});

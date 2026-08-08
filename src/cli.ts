#!/usr/bin/env node

import { resolve } from "node:path";

import { TypeScriptCodeParser } from "./code-intelligence/typescript-parser.js";
import { describeRuntimeConfig, loadRuntimeConfig } from "./config/runtime-config.js";
import { loadReasoningConfiguration } from "./config/reasoning-config.js";
import { LocalHashEmbeddingProvider } from "./embeddings/local-hash-embedding.js";
import {
  loadEvaluationCases,
  runGraphAwareRetrievalEvaluation,
  runRetrievalEvaluation,
} from "./evaluation/retrieval-evaluation.js";
import { FileSystemCodeIndexStore } from "./indexing/file-system-index-store.js";
import { RepositoryIndexer } from "./indexing/repository-indexer.js";
import { createProvider } from "./providers/provider-factory.js";
import { LocalFolderRepository } from "./repositories/local-folder-repository.js";
import { CodeRetrievalService } from "./retrieval/code-retrieval-service.js";
import type { RetrievalStrategy } from "./retrieval/hybrid-retriever.js";
import { StructuredAgentRuntime } from "./reasoning/agent-runtime.js";
import { ReasoningEngine } from "./reasoning/reasoning-engine.js";
import { DEFAULT_REASONING_LIMITS } from "./domain/reasoning.js";
import { EnvironmentCredentialSource } from "./storage/environment-credential-source.js";

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
  conclave eval <path> <cases.json> [--json]
  conclave eval-graph <path> <phase2-cases.json> <graph-cases.json> [--json]
  conclave config [--json]
  conclave provider-check
  conclave help

Retrieval returns repository Evidence and deterministic graph context only. It does not generate an answer or run agents.`;

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
  return { positionals, json, strategy, limit, depth, sourceBytes, tokens, graphOperation, debug };
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, undefined, 2));
    return;
  }
  console.log(value);
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
  readonly embeddingProvider: LocalHashEmbeddingProvider;
} {
  const embeddingProvider = new LocalHashEmbeddingProvider();
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
  console.log(`Indexed ${report.repository.name}`);
  console.log(
    `${String(report.files)} files, ${String(report.symbols)} symbols, ${String(report.graphEdges)} graph edges`,
  );
  console.log(`Changes: ${JSON.stringify(result.stats)}`);
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

function showConfig(args: readonly string[]): void {
  const credentials = new EnvironmentCredentialSource();
  const report = describeRuntimeConfig(loadRuntimeConfig(), credentials);
  print(report, args.includes("--json"));
}

async function providerCheck(): Promise<void> {
  const credentials = new EnvironmentCredentialSource();
  const config = loadRuntimeConfig();
  const model = config.providerSelection.model;
  if (model === undefined) {
    throw new Error(
      config.mode === "free"
        ? "CONCLAVE_FREE_MODEL is required for provider-check"
        : "CONCLAVE_MODEL is required for provider-check",
    );
  }
  const provider = createProvider(config, credentials);
  const response = await provider.generate({
    model,
    messages: [
      {
        role: "system",
        content: "This is a connectivity check. Reply with exactly CONCLAVE_PROVIDER_OK.",
      },
      { role: "user", content: "Check provider connectivity." },
    ],
    maxOutputTokens: 32,
  });
  console.log(`${response.provider}/${response.model}: ${response.text}`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
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
    case "eval":
      await evaluateRetrieval(args);
      return;
    case "eval-graph":
      await evaluateGraphRetrieval(args);
      return;
    case "config":
      showConfig(args);
      return;
    case "provider-check":
      await providerCheck();
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

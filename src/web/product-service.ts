import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { TypeScriptCodeParser } from "../code-intelligence/typescript-parser.js";
import { loadReasoningConfiguration } from "../config/reasoning-config.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { loadTaskConfiguration } from "../config/task-config.js";
import type { Evidence } from "../domain/evidence.js";
import { DEFAULT_REASONING_LIMITS, type ReasoningResult } from "../domain/reasoning.js";
import type { ExecutionPermissions, TaskExecutionResult } from "../domain/task-execution.js";
import { DEFAULT_TASK_EXECUTION_LIMITS } from "../domain/task-execution.js";
import { createEmbeddingProvider } from "../embeddings/embedding-factory.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { TaskExecutionEngine } from "../execution/task-execution-engine.js";
import { StructuredTaskAgentRuntime } from "../execution/task-agent-runtime.js";
import { InMemoryCodeIndexStore } from "../indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../indexing/repository-indexer.js";
import { createProvider } from "../providers/provider-factory.js";
import { LocalFolderRepository } from "../repositories/local-folder-repository.js";
import { StructuredAgentRuntime } from "../reasoning/agent-runtime.js";
import { ReasoningEngine, type ReasoningMode } from "../reasoning/reasoning-engine.js";
import { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";
import { EnvironmentCredentialSource } from "../storage/environment-credential-source.js";
import { createDemoReasoningEngine, createDemoTaskEngine } from "./demo-runtime.js";
import type {
  ClaimView,
  EvidenceView,
  GraphView,
  ProductIntent,
  ProductRunView,
  ProjectView,
  RuntimeModeView,
  TaskView,
  TraceView,
} from "./contracts.js";

interface ProjectSession {
  readonly id: string;
  readonly root: string;
  readonly source: "demo" | "local";
  readonly project: ProjectView;
  readonly retrieval: CodeRetrievalService;
  readonly reasoning?: ReasoningEngine;
}

export class ProductServiceError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly action: string,
  ) {
    super(message);
    this.name = "ProductServiceError";
  }
}

function viewEvidence(item: Evidence): EvidenceView {
  return {
    id: item.id,
    path: item.path,
    startLine: item.startLine,
    endLine: item.endLine,
    ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
    excerpt: item.excerpt,
    origin: item.provenance.origin,
  };
}

function viewClaims(result: ReasoningResult): readonly ClaimView[] {
  return [
    ...result.verdict.claims.supported.map((claim) => ({ ...claim, status: "supported" as const })),
    ...result.verdict.claims.rejected.map((claim) => ({ ...claim, status: "rejected" as const })),
    ...result.verdict.claims.uncertain.map((claim) => ({ ...claim, status: "uncertain" as const })),
  ].map((claim) => ({
    id: claim.id,
    statement: claim.statement,
    status: claim.status,
    role: claim.origin.role,
    evidenceIds: claim.evidenceIds,
    challengeCount: claim.challengeIds.length,
    verificationCount: claim.verificationIds.length,
  }));
}

function trace(result: ReasoningResult): readonly TraceView[] {
  const roles = ["investigator", "skeptic", "architect", "verifier", "judge"];
  return roles.map((role) => {
    const executed = result.verdict.traceSummary.agentsExecuted.includes(role as never);
    const skipped = result.verdict.traceSummary.agentsSkipped.find((item) => item.role === role);
    return {
      role,
      status: executed ? "ran" : "skipped",
      reason: executed ? "Ran within the bounded reasoning route." : (skipped?.reason ?? "Not selected for this route."),
    };
  });
}

function graph(retrieval: CodeRetrievalService, query: string): GraphView {
  const resolved = retrieval.graph.getNodeBySymbol(query);
  if (resolved.status === "not-found") return { query, status: "not-found", nodes: [], edges: [], message: `No unique symbol named ${query} was found.` };
  if (resolved.status === "ambiguous") {
    return {
      query,
      status: "ambiguous",
      nodes: resolved.candidates.map((node) => ({ id: node.reference.id, label: node.symbol ?? node.path, path: node.path })),
      edges: [],
      message: "Choose a path-qualified symbol to inspect graph relations.",
    };
  }
  const relations = retrieval.graph.neighbors(resolved.node.reference, { maxDepth: 1, maxNodes: 16, maxEdges: 24 });
  const nodes = new Map<string, { readonly id: string; readonly label: string; readonly path: string }>();
  nodes.set(resolved.node.reference.id, { id: resolved.node.reference.id, label: resolved.node.symbol ?? resolved.node.path, path: resolved.node.path });
  for (const relation of relations) nodes.set(relation.node.reference.id, { id: relation.node.reference.id, label: relation.node.symbol ?? relation.node.path, path: relation.node.path });
  return {
    query,
    status: "resolved",
    nodes: [...nodes.values()],
    edges: relations.map((relation) => ({
      id: relation.edge.id,
      from: relation.direction === "incoming" ? relation.node.reference.id : resolved.node.reference.id,
      to: relation.direction === "incoming" ? resolved.node.reference.id : relation.node.reference.id,
      relation: relation.edge.relation,
      provenance: relation.edge.provenance.kind,
    })),
  };
}

function reasoningView(intent: Exclude<ProductIntent, "task">, result: ReasoningResult, retrieval: CodeRetrievalService): ProductRunView {
  const sourceBytes = result.state.initialContext.stats.sourceBytes;
  return {
    intent,
    status: "completed",
    title: intent === "ask" ? "Evidence-backed answer" : "Investigated verdict",
    answer: result.verdict.answer,
    claims: viewClaims(result),
    evidence: result.verdict.evidence.map(viewEvidence),
    trace: trace(result),
    retrieval: {
      operations: result.state.initialRetrieval.plan.operations.map((operation) => ({ label: operation.kind, status: operation.status === "executed" ? "executed" : "skipped" })),
      evidenceCount: result.metrics.evidenceCount,
      sourceBytes,
      approximateTokens: result.state.initialContext.stats.approximateTokens,
    },
    metrics: [
      { label: "Model calls", value: String(result.metrics.modelCalls) },
      { label: "Retrieval rounds", value: String(result.metrics.retrievalRounds) },
      { label: "Deterministic operations", value: String(result.metrics.deterministicOperations) },
      { label: "Latency", value: `${String(Math.round(result.metrics.latencyMs))} ms` },
    ],
    graph: graph(retrieval, "bootstrapSession"),
  };
}

function taskView(result: TaskExecutionResult, permissions: ExecutionPermissions): TaskView {
  const trace = result.trace;
  const stage = (name: string, types: readonly string[]): TaskView["progress"][number] => {
    const event = trace.find((item) => types.includes(item.type));
    return { stage: name, detail: event?.detail ?? "Not reached", state: event === undefined ? "blocked" : "completed" };
  };
  const latestDiffs = new Map<string, TaskView["diff"][number]>();
  for (const record of result.patchRecords) {
    for (const file of record.changedFiles) {
      latestDiffs.set(file.path, {
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        expected: file.expectedByPlan,
        patch: record.unifiedDiff,
      });
    }
  }
  return {
    plan: {
      summary: result.task.plan.summary,
      requirements: result.task.plan.requirements.map((item) => item.statement),
      steps: result.task.plan.steps.map((item) => ({ description: item.description, files: item.targetFiles })),
    },
    permissions,
    progress: [
      stage("Investigating", ["task_started"]),
      stage("Planning", ["implementation_plan_created"]),
      stage("Creating isolated worktree", ["repository_snapshot_created"]),
      stage("Implementing", ["patch_applied", "patch_proposed"]),
      stage("Re-indexing", ["repository_reindexed"]),
      stage("Reviewing", ["reviewer_started"]),
      stage("Verifying", ["post_change_evidence_created"]),
      stage("Final verdict", ["execution_verdict_completed"]),
    ],
    diff: [...latestDiffs.values()],
    revisionRounds: result.verdict.revisionRounds,
    checks: result.verdict.checks.map((check) => ({ id: check.requestId, status: check.status, kind: check.command.kind, reason: check.policyReason })),
  };
}

function taskRun(result: TaskExecutionResult, permissions: ExecutionPermissions, retrieval: CodeRetrievalService): ProductRunView {
  const status = result.verdict.status;
  return {
    intent: "task",
    status,
    title: status === "planned" ? "Verified implementation plan" : "Task verdict",
    answer: result.verdict.summary,
    claims: [
      ...result.verdict.supportedClaims.map((claim) => ({ id: claim.id, statement: claim.statement, status: "supported" as const, role: "implementer", evidenceIds: claim.evidenceIds, challengeCount: 0, verificationCount: 1 })),
      ...result.verdict.rejectedClaims.map((claim) => ({ id: claim.id, statement: claim.statement, status: "rejected" as const, role: "implementer", evidenceIds: claim.evidenceIds, challengeCount: 0, verificationCount: 1 })),
      ...result.verdict.uncertainClaims.map((claim) => ({ id: claim.id, statement: claim.statement, status: "uncertain" as const, role: "implementer", evidenceIds: claim.evidenceIds, challengeCount: 0, verificationCount: 1 })),
    ],
    evidence: [...result.preChangeEvidence, ...result.postChangeEvidence].map(viewEvidence),
    trace: result.metrics.roleUsage.map((usage) => ({ role: usage.role, status: usage.calls > 0 ? "ran" as const : "skipped" as const, reason: usage.calls > 0 ? `${String(usage.calls)} bounded calls` : "Not reached" })),
    retrieval: { operations: [{ label: "post-change incremental reindex", status: result.patchRecords.length > 0 ? "executed" : "skipped" }], evidenceCount: result.postChangeEvidence.length, sourceBytes: result.postChangeEvidence.reduce((total, item) => total + Buffer.byteLength(item.excerpt), 0), approximateTokens: result.metrics.approximateInputTokens },
    metrics: [
      { label: "Task model calls", value: String(result.metrics.taskModelCalls) },
      { label: "Revisions", value: String(result.metrics.revisionRounds) },
      { label: "Files changed", value: String(result.metrics.filesChanged) },
      { label: "Changed lines", value: String(result.metrics.changedLines) },
    ],
    graph: graph(retrieval, "bootstrapSession"),
    task: taskView(result, permissions),
  };
}

export class ConclaveProductService {
  readonly #sessions = new Map<string, ProjectSession>();
  readonly #demoRoot: string;
  readonly #allowedRoot: string;

  public constructor(options: { readonly demoRoot?: string; readonly allowedRoot?: string } = {}) {
    this.#demoRoot = resolve(options.demoRoot ?? "demo/auth-repository");
    this.#allowedRoot = resolve(options.allowedRoot ?? process.env["CONCLAVE_WEB_ALLOWED_ROOT"] ?? process.cwd());
  }

  public async openDemo(): Promise<ProjectView> {
    return this.#open(this.#demoRoot, "demo");
  }

  public async openLocal(path: string): Promise<ProjectView> {
    const root = await resolveRepositoryRoot(path).catch(() => undefined);
    if (root === undefined || !isPathInside(this.#allowedRoot, root)) {
      throw new ProductServiceError("repository_denied", "This local server only opens folders beneath its configured allowed root.", "Set CONCLAVE_WEB_ALLOWED_ROOT, then choose a repository inside it.");
    }
    return this.#open(root, "local");
  }

  public project(id: string): ProjectView {
    return this.#session(id).project;
  }

  public async run(id: string, intent: Exclude<ProductIntent, "task">, question: string): Promise<ProductRunView> {
    if (question.trim() === "") throw new ProductServiceError("empty_query", "Enter a repository question before running Conclave.", "Write a specific code question.");
    const session = this.#session(id);
    try {
      const engine = session.source === "demo" ? await createDemoReasoningEngine(session.root) : this.#liveReasoning(session.retrieval);
      const mode: ReasoningMode = intent === "ask" ? "investigator-judge" : "conclave";
      return reasoningView(intent, await engine.ask(question, mode), session.retrieval);
    } catch (error) {
      return this.#error(intent, error, "Configure a supported provider in the local server environment, or switch to Demo Mode.", session.retrieval);
    }
  }

  public async task(id: string, objective: string, planOnly: boolean, permissions: ExecutionPermissions): Promise<ProductRunView> {
    if (objective.trim() === "") throw new ProductServiceError("empty_task", "Enter an explicit task objective.", "Describe the bounded code change you want.");
    if (permissions.allowRepositoryScripts && !permissions.allowCommands) throw new ProductServiceError("permission_invalid", "Repository scripts require static-check permission.", "Enable checks first, then explicitly enable repository scripts.");
    if (permissions.allowNetwork && !permissions.allowRepositoryScripts) throw new ProductServiceError("permission_invalid", "Network permission requires repository-script permission.", "Repository code remains default-deny.");
    const session = this.#session(id);
    try {
      const result = session.source === "demo"
        ? await this.#demoTask(session.root, objective, planOnly, permissions)
        : await this.#liveTask(session.retrieval, permissions).execute({ intent: "task", repositoryRoot: session.root, objective, planOnly });
      return taskRun(result, permissions, session.retrieval);
    } catch (error) {
      return this.#error("task", error, "Review the task permissions, repository state, and provider configuration.", session.retrieval);
    }
  }

  public graph(id: string, symbol: string): GraphView {
    return graph(this.#session(id).retrieval, symbol);
  }

  public runtime(): RuntimeModeView {
    try {
      const config = loadRuntimeConfig();
      const reasoning = loadReasoningConfiguration(config);
      return {
        active: config.mode,
        available: true,
        provider: config.providerSelection.provider,
        ...(config.providerSelection.model === undefined ? {} : { model: config.providerSelection.model }),
        message: config.mode === "local" ? "Configured loopback model endpoint; repository excerpts stay on this machine when every selected component is local." : "Provider configuration is held by the local server process.",
        roles: reasoning.assignments.map((assignment) => ({ role: assignment.role, provider: assignment.providerId, model: assignment.modelId })),
      };
    } catch (error) {
      return { active: "demo", available: false, message: error instanceof Error ? error.message : "Provider configuration is unavailable.", roles: [] };
    }
  }

  async #open(root: string, source: "demo" | "local"): Promise<ProjectView> {
    const embedding = source === "demo"
      ? new LocalHashEmbeddingProvider()
      : createEmbeddingProvider(process.env, new EnvironmentCredentialSource());
    const indexed = await new RepositoryIndexer({ repositorySource: new LocalFolderRepository(), parser: new TypeScriptCodeParser(), embeddingProvider: embedding, indexStore: new InMemoryCodeIndexStore() }).index(root);
    const id = `${source}:${indexed.index.repository.id}`;
    const languages = [...new Set(Object.values(indexed.index.files).map((file) => file.language))].sort();
    const project: ProjectView = {
      id,
      name: basename(root),
      path: source === "demo" ? "Demo repository · auth lifecycle" : root,
      source,
      gitStatus: source === "demo" ? "demo" : "unknown",
      languages,
      indexedFiles: Object.keys(indexed.index.files).length,
      symbols: Object.keys(indexed.index.units).length,
      graphNodes: Object.keys(indexed.index.files).length + Object.keys(indexed.index.units).length,
      graphEdges: indexed.index.graphEdges.length,
      updatedAt: indexed.index.updatedAt,
    };
    this.#sessions.set(id, { id, root, source, project, retrieval: new CodeRetrievalService(indexed.index, embedding) });
    return project;
  }

  #session(id: string): ProjectSession {
    const session = this.#sessions.get(id);
    if (session === undefined) throw new ProductServiceError("project_missing", "This project session is no longer available.", "Open the repository again.");
    return session;
  }

  #liveReasoning(retrieval: CodeRetrievalService): ReasoningEngine {
    const runtime = loadRuntimeConfig();
    const reasoning = loadReasoningConfiguration(runtime);
    const provider = createProvider(runtime, new EnvironmentCredentialSource());
    return new ReasoningEngine({ retrieval, runtime: new StructuredAgentRuntime(new Map([[provider.id, provider]]), reasoning.assignments, DEFAULT_REASONING_LIMITS), preset: reasoning.preset });
  }

  #liveTask(retrieval: CodeRetrievalService, permissions: ExecutionPermissions): TaskExecutionEngine {
    const runtime = loadRuntimeConfig();
    const reasoning = loadReasoningConfiguration(runtime);
    const task = loadTaskConfiguration(runtime);
    const provider = createProvider(runtime, new EnvironmentCredentialSource());
    const investigator = new ReasoningEngine({ retrieval, runtime: new StructuredAgentRuntime(new Map([[provider.id, provider]]), reasoning.assignments, DEFAULT_REASONING_LIMITS), preset: reasoning.preset });
    return new TaskExecutionEngine({ investigator, taskRuntime: new StructuredTaskAgentRuntime(new Map([[provider.id, provider]]), task.assignments, DEFAULT_TASK_EXECUTION_LIMITS), permissions, limits: DEFAULT_TASK_EXECUTION_LIMITS, allowedPackageScripts: task.allowedPackageScripts });
  }

  async #demoTask(
    root: string,
    objective: string,
    planOnly: boolean,
    permissions: ExecutionPermissions,
  ): Promise<TaskExecutionResult> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "conclave-web-demo-"));
    const repositoryRoot = join(temporaryRoot, "repository");
    await cp(root, repositoryRoot, { recursive: true, dereference: false });
    try {
      const engine = await createDemoTaskEngine(repositoryRoot, permissions);
      return await engine.execute({ intent: "task", repositoryRoot, objective, planOnly });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  #error(intent: ProductIntent, error: unknown, action: string, retrieval: CodeRetrievalService): ProductRunView {
    const message = error instanceof ProductServiceError ? error.message : error instanceof Error ? "Conclave could not complete this bounded run." : "Conclave could not complete this bounded run.";
    return {
      intent,
      status: "error",
      title: "Run unavailable",
      answer: "No provider response or repository mutation was accepted.",
      claims: [], evidence: [], trace: [],
      retrieval: { operations: [], evidenceCount: 0, sourceBytes: 0, approximateTokens: 0 },
      metrics: [], graph: graph(retrieval, "bootstrapSession"),
      error: { code: error instanceof ProductServiceError ? error.code : "provider_or_runtime_failure", message, action: error instanceof ProductServiceError ? error.action : action },
    };
  }
}

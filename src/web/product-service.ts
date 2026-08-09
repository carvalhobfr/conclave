import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { TypeScriptCodeParser } from "../code-intelligence/typescript-parser.js";
import { loadReasoningConfiguration } from "../config/reasoning-config.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { loadTaskConfiguration } from "../config/task-config.js";
import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { Evidence } from "../domain/evidence.js";
import type { AnalysisSnapshot } from "../domain/adaptive-reasoning.js";
import type { LlmProvider } from "../domain/provider.js";
import { DEFAULT_REASONING_LIMITS, type ReasoningResult, type ReasoningTraceEvent } from "../domain/reasoning.js";
import type { ExecutionPermissions, TaskExecutionResult, TaskTraceEvent } from "../domain/task-execution.js";
import { DEFAULT_TASK_EXECUTION_LIMITS } from "../domain/task-execution.js";
import { createEmbeddingProvider } from "../embeddings/embedding-factory.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { TaskExecutionEngine } from "../execution/task-execution-engine.js";
import { StructuredTaskAgentRuntime } from "../execution/task-agent-runtime.js";
import { InMemoryCodeIndexStore } from "../indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../indexing/repository-indexer.js";
import { createFreeUsageController, FreeUsageError, type FreeUsageController } from "../hosted/free-usage-controller.js";
import { DEFAULT_FREE_MODEL_ALLOWLIST, parseFreeModelAllowlist } from "../config/free-mode-config.js";
import { createProvider } from "../providers/provider-factory.js";
import { createProviderRuntime } from "../providers/provider-runtime.js";
import { LocalFolderRepository } from "../repositories/local-folder-repository.js";
import { StructuredAgentRuntime } from "../reasoning/agent-runtime.js";
import { ReasoningEngine, type ReasoningMode } from "../reasoning/reasoning-engine.js";
import { AdaptiveMetricsAccumulator, type AdaptiveMetricsSummary } from "../reasoning/adaptive-metrics.js";
import { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";
import { isSensitiveRepositoryPath } from "../security/sensitive-repository-path.js";
import { EnvironmentCredentialSource } from "../storage/environment-credential-source.js";
import { createDemoReasoningEngine, createDemoTaskEngine } from "./demo-runtime.js";
import type {
  ClaimView,
  EvidenceView,
  GraphView,
  ProductIntent,
  ProductRunJobView,
  ProductRunProgressView,
  ProductRunView,
  ProviderSettingsView,
  ProviderModelsInput,
  ProviderModelsView,
  ProjectView,
  RuntimeModeView,
  SaveProviderSettingsInput,
  TaskView,
  TraceView,
  ImportedRepositoryFile,
  ProductAnalysisDepth,
} from "./contracts.js";
import { ProviderModelCatalog, ProviderModelCatalogError } from "./provider-model-catalog.js";
import { ProviderSettingsError, ProviderSettingsStore, type StoredProviderConnection, type StoredProviderSet } from "./provider-settings.js";

interface ProjectSession {
  readonly id: string;
  readonly root: string;
  readonly source: "demo" | "local";
  readonly project: ProjectView;
  readonly retrieval: CodeRetrievalService;
  readonly reasoning?: ReasoningEngine;
}

interface RunJob {
  readonly id: string;
  readonly intent: ProductIntent;
  readonly startedAt: string;
  updatedAt: string;
  readonly depth: ProductAnalysisDepth;
  readonly controller: AbortController;
  status: "running" | "cancelling" | "completed";
  readonly progress: ProductRunProgressView[];
  snapshot?: ProductRunJobView["snapshot"];
  result?: ProductRunView;
}

const REASONING_ROLES = new Set(["investigator", "skeptic", "architect", "verifier", "judge"]);
const TASK_ROLES = new Set(["planner", "implementer", "reviewer"]);
const LOCAL_PROVIDER_IDS = new Set(["ollama", "lm-studio"]);
const MAX_IMPORTED_FILES = 4_000;
const MAX_IMPORTED_FILE_BYTES = 2_000_000;
const MAX_IMPORTED_TOTAL_BYTES = 16_000_000;

function runtimeForConnection(connection: StoredProviderConnection): RuntimeConfig {
  const providerSelection = {
    provider: connection.provider,
    model: connection.model,
    ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
  };
  if (LOCAL_PROVIDER_IDS.has(connection.provider)) {
    return { mode: "local", privacyBoundary: "local-only", providerSelection };
  }
  return { mode: "api", privacyBoundary: "external", credentialEnvironmentVariable: "CONCLAVE_API_KEY", providerSelection };
}

function providersForSet(set: StoredProviderSet): ReadonlyMap<string, LlmProvider> {
  const providers = new Map<string, LlmProvider>();
  for (const connection of set.providers) {
    const credential = { get: () => connection.apiKey };
    providers.set(connection.id, createProvider(runtimeForConnection(connection), credential));
  }
  return providers;
}

function safeImportedPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "" || normalized.includes("\0") || isAbsolute(normalized)) {
    throw new ProductServiceError("invalid_repository_file", "The selected folder contains an invalid file path.", "Choose a different repository folder.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ProductServiceError("invalid_repository_file", "The selected folder contains an unsafe relative path.", "Choose a different repository folder.");
  }
  return segments.join("/");
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

function snapshotView(snapshot: AnalysisSnapshot): NonNullable<ProductRunJobView["snapshot"]> {
  const claim = (status: ClaimView["status"]) => (item: AnalysisSnapshot["supportedClaims"][number]): ClaimView => ({
    id: item.id,
    statement: item.statement,
    status,
    role: item.origin.role,
    evidenceIds: item.evidenceIds,
    challengeCount: item.challengeIds.length,
    verificationCount: item.verificationIds.length,
  });
  return {
    status: snapshot.status,
    ...(snapshot.provisionalConclusion === undefined ? {} : { provisionalConclusion: snapshot.provisionalConclusion }),
    supportedClaims: snapshot.supportedClaims.map(claim("supported")),
    rejectedClaims: snapshot.rejectedClaims.map(claim("rejected")),
    uncertainClaims: snapshot.uncertainClaims.map(claim("uncertain")),
    evidence: snapshot.evidence.map(viewEvidence),
    remainingChecks: snapshot.remainingChecks,
  };
}

function trace(result: ReasoningResult): readonly TraceView[] {
  const roles = ["conductor", "investigator", "skeptic", "architect", "verifier", "judge"];
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
  const hasClaims = result.state.claims.length > 0;
  const incomplete = result.terminationReason !== "completed" || !hasClaims;
  const failedWithoutResult = result.terminationReason === "agent-failure" && !hasClaims;
  const failureDetail = [...result.trace]
    .reverse()
    .find((event) => event.type === "agent_completed" && /failed|provider|invalid|did not produce|no assignment/i.test(event.detail))
    ?.detail.slice(0, 500);
  return {
    intent,
    status: result.terminationReason === "cancelled"
      ? "cancelled"
      : result.terminationReason === "timed-out"
        ? "timed-out"
        : failedWithoutResult ? "error" : incomplete ? "completed-with-uncertainty" : "completed",
    title: failedWithoutResult
      ? "Analysis unavailable"
      : intent === "ask" ? "Evidence-backed answer" : "Investigated verdict",
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
      { label: "Cumulative input context", value: `${String(result.metrics.approximateInputTokens)} tokens` },
      { label: "Cumulative output", value: `${String(result.metrics.approximateOutputTokens)} tokens` },
      { label: "Latency", value: `${String(Math.round(result.metrics.latencyMs))} ms` },
    ],
    graph: graph(retrieval, "bootstrapSession"),
    analysis: {
      requestedDepth: result.analysis.requestedDepth,
      selectedDepth: result.analysis.selectedDepth,
      why: result.analysis.plan.reasonCodes,
      deterministicAnswer: result.analysis.deterministicAnswer,
      conductorInvoked: result.analysis.conductorInvoked,
      conductorReason: result.analysis.conductorReason,
      ...(result.analysis.earlyExitReason === undefined ? {} : { earlyExitReason: result.analysis.earlyExitReason }),
      timeoutMs: result.analysis.timeoutMs,
      cumulativeInputTokens: result.metrics.approximateInputTokens,
      cumulativeOutputTokens: result.metrics.approximateOutputTokens,
      reviewRecommended: result.analysis.review.recommended,
      reviewReasons: result.analysis.review.reasons,
      ...(result.analysis.review.handoff === undefined ? {} : { reviewHandoff: result.analysis.review.handoff }),
      models: result.metrics.roleUsage.filter((usage) => usage.calls > 0).map((usage) => {
        const requirement = result.analysis.plan.modelRequirements[usage.role];
        const selected = result.trace.find((event) => event.type === "model_selected" && event.role === usage.role);
        return {
          role: usage.role,
          provider: usage.providerIds.join(", "),
          model: usage.modelIds.join(", "),
          calls: usage.calls,
          latencyMs: usage.latencyMs,
          requirement: requirement === undefined
            ? "configured role assignment"
            : Object.entries(requirement).map(([key, value]) => `${key}: ${String(value)}`).join(" · "),
          selectionReason: selected?.detail ?? "Selected from configured, available models.",
        };
      }),
    },
    suggestedNextAction: result.verdict.claims.uncertain.length > 0
      ? "Run deeper analysis or inspect the remaining uncertain claims."
      : result.analysis.review.recommended
        ? "Use the independent-review handoff before making a high-impact change."
        : "Open the cited evidence or inspect the resolved graph relationship.",
    ...(failedWithoutResult ? {
      error: {
        code: "reasoning_agent_failure",
        message: failureDetail ?? "The configured model did not return an accepted reasoning result.",
        action: "Retry the run or choose a model with reliable structured JSON output.",
      },
    } : {}),
  };
}

function progressForTrace(event: ReasoningTraceEvent): ProductRunProgressView | undefined {
  const role = event.role === undefined ? undefined : event.role.charAt(0).toUpperCase() + event.role.slice(1);
  const agentFailed = event.type === "agent_completed" && /failed|invalid structured output|did not produce output/i.test(event.detail);
  const stage = (() => {
    switch (event.type) {
      case "reasoning_started": return "Reading existing Project Knowledge";
      case "query_assessed": return "Choosing the smallest useful analysis";
      case "deterministic_answer_completed": return "Resolved from static repository knowledge";
      case "conductor_started": return "Planning an ambiguous investigation";
      case "conductor_completed": return "Investigation route selected";
      case "conductor_skipped": return "Direct route selected";
      case "initial_retrieval_started": return "Finding relevant symbols and relationships";
      case "initial_retrieval_completed": return "Relevant repository evidence found";
      case "context_packed": return "Preparing bounded source evidence";
      case "agent_started": return event.role === "investigator" ? "Forming testable explanations" : event.role === "skeptic" ? "Testing an alternative explanation" : event.role === "architect" ? "Checking the cross-module lifecycle" : event.role === "verifier" ? "Checking unresolved claims" : event.role === "judge" ? "Adjudicating competing claims" : "Planning the reasoning route";
      case "agent_completed": return agentFailed ? `${role ?? "Model"} step unavailable` : `${role ?? "Reasoning"} check completed`;
      case "agent_selected": return `${role ?? "Role"} is useful for this question`;
      case "agent_skipped": return `${role ?? "Role"} was not needed`;
      case "retrieval_requested": return "A material claim needs another repository check";
      case "retrieval_completed": return "Additional repository evidence found";
      case "verification_started": return "Verifying claims against static code relationships";
      case "judge_started": return "Resolving a meaningful disagreement";
      case "reasoning_early_exit": return "Evidence is sufficient; stopping early";
      case "reasoning_cancelled": return "Stopping analysis and preserving verified work";
      case "reasoning_timed_out": return "Provider time budget reached; preserving evidence";
      case "verdict_completed": return "Verdict completed";
      case "reasoning_budget_exhausted": return "Reasoning budget reached";
      case "reasoning_no_progress": return "No additional evidence requested";
      case "snapshot_emitted":
      case "model_selected":
      default: return undefined;
    }
  })();
  if (stage === undefined) return undefined;
  const state: ProductRunProgressView["state"] = agentFailed ? "failed" : event.type === "agent_skipped" ? "skipped" : event.type === "agent_completed" || event.type === "initial_retrieval_completed" || event.type === "retrieval_completed" || event.type === "verdict_completed" ? "completed" : "current";
  const detail = agentFailed
    ? "The provider response was not accepted. Check the endpoint, model, credentials, or provider limits."
    : event.type === "agent_started"
    ? "Working from bounded repository evidence. Private model reasoning is never displayed."
    : event.type === "initial_retrieval_started"
      ? "Searching code, symbols, and bounded graph relationships."
      : event.type === "verification_started"
        ? "Checking proposed claims against deterministic repository evidence."
        : event.detail;
  return { sequence: event.sequence, occurredAt: event.occurredAt, stage, detail, state };
}

function progressForTaskTrace(event: TaskTraceEvent): ProductRunProgressView | undefined {
  const stage = (() => {
    switch (event.type) {
      case "task_started": return "Reading Project Knowledge for the task";
      case "implementation_plan_created": return "Verified change plan prepared";
      case "execution_permission_checked": return "Checking the explicit task boundary";
      case "repository_snapshot_created": return "Creating an isolated execution workspace";
      case "implementer_started": return "Preparing the scoped implementation";
      case "patch_applied": return "Applying an approved patch in isolation";
      case "repository_reindexed": return "Refreshing Project Knowledge after the patch";
      case "post_change_evidence_created": return "Checking the changed repository state";
      case "reviewer_started": return "Reviewing the bounded patch";
      case "revision_requested": return "Revising a failed requirement";
      case "execution_verdict_completed": return "Task verdict completed";
      case "execution_blocked": return "Task stopped at a safety boundary";
      case "command_started": return "Running an approved bounded check";
      case "command_completed": return "Approved check completed";
      default: return undefined;
    }
  })();
  if (stage === undefined) return undefined;
  return {
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    stage,
    detail: event.detail,
    state: event.type === "execution_blocked" ? "failed"
      : event.type === "implementer_started" || event.type === "reviewer_started" || event.type === "command_started" ? "current"
        : "completed",
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
  readonly #jobs = new Map<string, RunJob>();
  readonly #indexStore = new InMemoryCodeIndexStore();
  readonly #demoRoot: string;
  readonly #allowedRoot: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #providerSettings: ProviderSettingsStore;
  readonly #providerModelCatalog: ProviderModelCatalog;
  readonly #freeUsage: FreeUsageController;
  readonly #adaptiveMetrics = new AdaptiveMetricsAccumulator();

  public constructor(options: { readonly demoRoot?: string; readonly allowedRoot?: string; readonly settingsFile?: string; readonly environment?: NodeJS.ProcessEnv; readonly freeUsageController?: FreeUsageController; readonly providerModelCatalog?: ProviderModelCatalog } = {}) {
    this.#environment = options.environment ?? process.env;
    this.#demoRoot = resolve(options.demoRoot ?? "demo/auth-repository");
    this.#allowedRoot = resolve(options.allowedRoot ?? this.#environment["CONCLAVE_WEB_ALLOWED_ROOT"] ?? process.cwd());
    this.#providerSettings = new ProviderSettingsStore({ ...(options.settingsFile === undefined ? {} : { filePath: options.settingsFile }), environment: this.#environment });
    this.#providerModelCatalog = options.providerModelCatalog ?? new ProviderModelCatalog();
    const freeModeSelected = (this.#environment["CONCLAVE_MODE"]?.trim() || "free") === "free";
    const freeModels = freeModeSelected
      ? parseFreeModelAllowlist(this.#environment["CONCLAVE_FREE_MODEL_ALLOWLIST"])
      : DEFAULT_FREE_MODEL_ALLOWLIST;
    this.#freeUsage = options.freeUsageController ?? createFreeUsageController(freeModeSelected ? this.#environment : {}, freeModels);
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

  public async importLocal(name: string, files: readonly ImportedRepositoryFile[]): Promise<ProjectView> {
    if (files.length < 1 || files.length > MAX_IMPORTED_FILES) {
      throw new ProductServiceError("invalid_repository_import", `Choose a folder containing between 1 and ${String(MAX_IMPORTED_FILES)} files.`, "Choose a smaller source repository.");
    }
    let totalBytes = 0;
    const validated: ImportedRepositoryFile[] = [];
    for (const file of files) {
      if (typeof file.content !== "string") throw new ProductServiceError("invalid_repository_file", "A selected repository file could not be read.", "Choose the folder again.");
      const path = safeImportedPath(file.path);
      if (isSensitiveRepositoryPath(path)) continue;
      const bytes = Buffer.byteLength(file.content);
      if (bytes > MAX_IMPORTED_FILE_BYTES) throw new ProductServiceError("repository_file_too_large", `${file.path} is too large for browser import.`, "Use the Electron app for large repositories.");
      totalBytes += bytes;
      validated.push({ path, content: file.content });
    }
    if (validated.length === 0) {
      throw new ProductServiceError("invalid_repository_import", "The selected folder contains no safe source files to import.", "Choose a source repository containing non-sensitive files.");
    }
    if (totalBytes > MAX_IMPORTED_TOTAL_BYTES) {
      throw new ProductServiceError("repository_import_too_large", "The selected repository is too large for browser import.", "Use the Electron app to open this repository without copying it.");
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), "conclave-browser-repository-"));
    const safeName = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "imported-repository";
    const repositoryRoot = join(temporaryRoot, safeName);
    await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
    for (const file of validated) {
      const destination = join(repositoryRoot, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, { mode: 0o600 });
    }
    return this.#open(repositoryRoot, "local");
  }

  public async providerSettings(): Promise<ProviderSettingsView> {
    try {
      return await this.#providerSettings.view();
    } catch (error) {
      throw new ProductServiceError("provider_settings_unavailable", error instanceof Error ? error.message : "Provider settings are unavailable.", "Review the local settings file and retry.");
    }
  }

  public async saveProviderSettings(input: SaveProviderSettingsInput): Promise<ProviderSettingsView> {
    try {
      return await this.#providerSettings.save(input);
    } catch (error) {
      if (error instanceof ProviderSettingsError) {
        throw new ProductServiceError("invalid_provider_settings", error.message, "Review the provider set and try again.");
      }
      throw new ProductServiceError("provider_settings_unavailable", "Provider settings could not be saved locally.", "Check access to the Conclave settings directory.");
    }
  }

  public async providerModels(input: ProviderModelsInput): Promise<ProviderModelsView> {
    if (input.provider !== "openai" && input.provider !== "openrouter") {
      throw new ProductServiceError("model_catalog_unavailable", "Automatic model discovery is available for OpenAI and OpenRouter.", "Enter this provider's model name in Advanced routing.");
    }
    const transientKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const storedKey = transientKey === "" && typeof input.setId === "string" && typeof input.connectionId === "string"
      ? await this.#providerSettings.catalogCredential(input.setId, input.connectionId, input.provider)
      : undefined;
    const apiKey = transientKey || storedKey;
    if (apiKey === undefined || apiKey === "") {
      throw new ProductServiceError("personal_api_key_required", "Enter or save your own API key before loading models.", "Add the personal key for this provider. The host Free key cannot be used here.");
    }
    try {
      return await this.#providerModelCatalog.list(input.provider, apiKey, input.connectionId?.trim() || "provider");
    } catch (error) {
      if (error instanceof ProviderModelCatalogError) {
        throw new ProductServiceError("model_catalog_unavailable", error.message, "Check your personal key and try loading the models again.");
      }
      throw new ProductServiceError("model_catalog_unavailable", "The provider model catalog could not be loaded.", "Check the local server connection and try again.");
    }
  }

  public project(id: string): ProjectView {
    return this.#session(id).project;
  }

  public adaptiveMetrics(): AdaptiveMetricsSummary {
    return this.#adaptiveMetrics.summary();
  }

  public async run(id: string, intent: Exclude<ProductIntent, "task">, question: string, depth: ProductAnalysisDepth = "auto"): Promise<ProductRunView> {
    return this.#executeRun(id, intent, question, depth);
  }

  public startRun(id: string, intent: Exclude<ProductIntent, "task">, question: string, depth: ProductAnalysisDepth = "auto"): ProductRunJobView {
    if (question.trim() === "") throw new ProductServiceError("empty_query", "Enter a repository question before running Conclave.", "Write a specific code question.");
    this.#session(id);
    const startedAt = new Date().toISOString();
    const job: RunJob = { id: randomUUID(), intent, depth, controller: new AbortController(), status: "running", startedAt, updatedAt: startedAt, progress: [] };
    this.#jobs.set(job.id, job);
    this.#trimJobs();
    void this.#executeRun(id, intent, question, depth, (event) => {
      const progress = progressForTrace(event);
      if (progress === undefined) return;
      job.progress.push(progress);
      job.updatedAt = new Date().toISOString();
    }, (snapshot) => {
      job.snapshot = snapshotView(snapshot);
      job.updatedAt = new Date().toISOString();
    }, job.controller.signal).then((result) => {
      job.result = result;
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      if (result.status === "error") {
        job.progress.push({
          sequence: job.progress.length + 1,
          occurredAt: job.updatedAt,
          stage: "Run unavailable",
          detail: result.error?.message ?? "Conclave could not complete this run.",
          state: "failed",
        });
      }
    });
    return this.#jobView(job);
  }

  public startTask(
    id: string,
    objective: string,
    planOnly: boolean,
    permissions: ExecutionPermissions,
    depth: ProductAnalysisDepth = "auto",
  ): ProductRunJobView {
    if (objective.trim() === "") throw new ProductServiceError("empty_task", "Enter an explicit task objective.", "Describe the bounded code change you want.");
    if (permissions.allowRepositoryScripts && !permissions.allowCommands) throw new ProductServiceError("permission_invalid", "Repository scripts require static-check permission.", "Enable checks first, then explicitly enable repository scripts.");
    if (permissions.allowNetwork && !permissions.allowRepositoryScripts) throw new ProductServiceError("permission_invalid", "Network permission requires repository-script permission.", "Repository code remains default-deny.");
    this.#session(id);
    const startedAt = new Date().toISOString();
    const job: RunJob = {
      id: randomUUID(), intent: "task", depth, controller: new AbortController(), status: "running", startedAt, updatedAt: startedAt,
      progress: [{
        sequence: 1,
        occurredAt: startedAt,
        stage: "Investigating before planning",
        detail: "Building an evidence-backed diagnosis before any isolated mutation is considered.",
        state: "current",
      }],
    };
    this.#jobs.set(job.id, job);
    this.#trimJobs();
    void this.task(
      id,
      objective,
      planOnly,
      permissions,
      depth,
      job.controller.signal,
      (event) => {
        const progress = progressForTaskTrace(event);
        if (progress !== undefined) job.progress.push(progress);
        job.updatedAt = new Date().toISOString();
      },
      (snapshot) => {
        job.snapshot = snapshotView(snapshot);
        job.updatedAt = new Date().toISOString();
      },
    ).then((result) => {
      job.result = result.status === "cancelled" && job.snapshot !== undefined
        ? {
            ...result,
            answer: job.snapshot.provisionalConclusion ?? result.answer,
            claims: [...job.snapshot.supportedClaims, ...job.snapshot.rejectedClaims, ...job.snapshot.uncertainClaims],
            evidence: job.snapshot.evidence,
          }
        : result;
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      job.progress.push({
        sequence: job.progress.length + 1,
        occurredAt: job.updatedAt,
        stage: result.status === "cancelled" ? "Task cancelled safely" : "Task workflow completed",
        detail: result.status === "cancelled"
          ? "Pending provider or command work stopped; the original repository was not modified."
          : "The bounded Task verdict and any isolated patch are ready.",
        state: result.status === "cancelled" ? "skipped" : "completed",
      });
    });
    return this.#jobView(job);
  }

  public runStatus(id: string): ProductRunJobView {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new ProductServiceError("run_missing", "This run is no longer available.", "Start the analysis again.");
    return this.#jobView(job);
  }

  public cancelRun(id: string): ProductRunJobView {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new ProductServiceError("run_missing", "This run is no longer available.", "Start the analysis again.");
    if (job.status === "running") {
      job.status = "cancelling";
      job.updatedAt = new Date().toISOString();
      job.progress.push({
        sequence: job.progress.length + 1,
        occurredAt: job.updatedAt,
        stage: "Cancelling analysis",
        detail: "Stopping pending provider work and preserving evidence-backed partial results.",
        state: "current",
      });
      job.controller.abort(new DOMException("Analysis cancelled by user", "AbortError"));
    }
    return this.#jobView(job);
  }

  async #executeRun(
    id: string,
    intent: Exclude<ProductIntent, "task">,
    question: string,
    depth: ProductAnalysisDepth,
    onTrace?: (event: ReasoningTraceEvent) => void,
    onSnapshot?: (snapshot: AnalysisSnapshot) => void,
    signal?: AbortSignal,
  ): Promise<ProductRunView> {
    if (question.trim() === "") throw new ProductServiceError("empty_query", "Enter a repository question before running Conclave.", "Write a specific code question.");
    const session = this.#session(id);
    try {
      const mode: ReasoningMode = "conclave";
      const execute = async () => {
        const direct = session.retrieval.knowledge.answer(question);
        const directAllowed = direct !== undefined && (depth === "auto" || depth === "fast");
        const engine = directAllowed
          ? new ReasoningEngine({ retrieval: session.retrieval, runtime: new StructuredAgentRuntime(new Map(), [], DEFAULT_REASONING_LIMITS), preset: "full", ...(onTrace === undefined ? {} : { onTrace }) })
          : session.source === "demo" ? await createDemoReasoningEngine(session.root, onTrace, session.retrieval) : await this.#liveReasoning(session.retrieval, onTrace);
        const result = await engine.ask(question, mode, {
          depth,
          intent,
          ...(signal === undefined ? {} : { signal }),
          ...(onSnapshot === undefined ? {} : { onSnapshot }),
        });
        this.#adaptiveMetrics.record(result);
        return reasoningView(intent, result, session.retrieval);
      };
      const direct = session.retrieval.knowledge.answer(question);
      return session.source === "demo" || (direct !== undefined && (depth === "auto" || depth === "fast"))
        ? await execute()
        : await this.#withFreeUsage(intent, execute);
    } catch (error) {
      if (signal?.aborted === true) {
        return {
          intent,
          status: "cancelled",
          title: "Analysis cancelled",
          answer: "Analysis was cancelled before a verified conclusion was available.",
          claims: [], evidence: [], trace: [],
          retrieval: { operations: [], evidenceCount: 0, sourceBytes: 0, approximateTokens: 0 },
          metrics: [], graph: graph(session.retrieval, "bootstrapSession"),
          suggestedNextAction: "Run the analysis again when you are ready.",
        };
      }
      return this.#error(intent, error, "Configure a supported provider in the local server environment, or switch to Demo Mode.", session.retrieval);
    }
  }

  #jobView(job: RunJob): ProductRunJobView {
    return {
      id: job.id,
      intent: job.intent,
      status: job.status,
      depth: job.depth,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      progress: job.progress,
      ...(job.snapshot === undefined ? {} : { snapshot: job.snapshot }),
      ...(job.result === undefined ? {} : { result: job.result }),
    };
  }

  #trimJobs(): void {
    while (this.#jobs.size > 32) {
      const oldest = this.#jobs.keys().next().value;
      if (oldest === undefined) return;
      this.#jobs.delete(oldest);
    }
  }

  public async task(
    id: string,
    objective: string,
    planOnly: boolean,
    permissions: ExecutionPermissions,
    depth: ProductAnalysisDepth = "auto",
    signal?: AbortSignal,
    onTrace?: (event: TaskTraceEvent) => void,
    onSnapshot?: (snapshot: AnalysisSnapshot) => void,
  ): Promise<ProductRunView> {
    if (objective.trim() === "") throw new ProductServiceError("empty_task", "Enter an explicit task objective.", "Describe the bounded code change you want.");
    if (permissions.allowRepositoryScripts && !permissions.allowCommands) throw new ProductServiceError("permission_invalid", "Repository scripts require static-check permission.", "Enable checks first, then explicitly enable repository scripts.");
    if (permissions.allowNetwork && !permissions.allowRepositoryScripts) throw new ProductServiceError("permission_invalid", "Network permission requires repository-script permission.", "Repository code remains default-deny.");
    const session = this.#session(id);
    try {
      const execute = async () => session.source === "demo"
        ? this.#demoTask(session.root, objective, planOnly, permissions, depth, signal, onTrace, onSnapshot)
        : (await this.#liveTask(session.retrieval, permissions)).execute({ intent: "task", repositoryRoot: session.root, objective, planOnly, analysisDepth: depth, ...(signal === undefined ? {} : { signal }), ...(onTrace === undefined ? {} : { onTrace }), ...(onSnapshot === undefined ? {} : { onSnapshot }) });
      const result = session.source === "demo" ? await execute() : await this.#withFreeUsage("task", execute);
      return taskRun(result, permissions, session.retrieval);
    } catch (error) {
      if (signal?.aborted === true) {
        return {
          intent: "task",
          status: "cancelled",
          title: "Task cancelled",
          answer: "Pending work stopped. No change was applied to the original repository.",
          claims: [], evidence: [], trace: [],
          retrieval: { operations: [], evidenceCount: 0, sourceBytes: 0, approximateTokens: 0 },
          metrics: [], graph: graph(session.retrieval, "bootstrapSession"),
          suggestedNextAction: "Review the objective or restart the task when you are ready.",
        };
      }
      return this.#error("task", error, "Review the task permissions, repository state, and provider configuration.", session.retrieval);
    }
  }

  public graph(id: string, symbol: string): GraphView {
    return graph(this.#session(id).retrieval, symbol);
  }

  public async runtime(): Promise<RuntimeModeView> {
    try {
      const activeSet = await this.#providerSettings.activeSet();
      if (activeSet !== undefined) {
        providersForSet(activeSet);
        const localOnly = activeSet.providers.every((provider) => LOCAL_PROVIDER_IDS.has(provider.provider));
        const primaryProvider = activeSet.providers.length === 1 ? activeSet.providers[0]?.provider : "multiple";
        return {
          active: localOnly ? "local" : "api",
          available: true,
          source: "provider-set",
          activeSetName: activeSet.name,
          ...(primaryProvider === undefined ? {} : { provider: primaryProvider }),
          message: `${activeSet.name} overrides the .env fallback and uses only the credentials saved in this set.`,
          roles: activeSet.roles.map((assignment) => {
            const connection = activeSet.providers.find((provider) => provider.id === assignment.connectionId);
            return { role: assignment.role, provider: connection?.provider ?? assignment.connectionId, model: assignment.model };
          }),
        };
      }
      const config = loadRuntimeConfig(this.#environment);
      const reasoning = loadReasoningConfiguration(config, this.#environment);
      const task = loadTaskConfiguration(config, this.#environment);
      createProviderRuntime(config, new EnvironmentCredentialSource(this.#environment), [...reasoning.assignments, ...reasoning.modelProfiles, ...task.assignments]);
      return {
        active: config.mode,
        available: true,
        source: "environment",
        provider: config.providerSelection.provider,
        ...(config.providerSelection.model === undefined ? {} : { model: config.providerSelection.model }),
        message: config.mode === "local"
          ? "Configured loopback model endpoint; repository excerpts stay on this machine when every selected component is local."
          : config.mode === "free"
            ? "Free Mode uses external inference. Selected repository excerpts may be sent to OpenCode Zen; use Local Mode when repository content must remain on this machine."
            : "Provider configuration is held by the local server process.",
        roles: [...reasoning.assignments, ...task.assignments].map((assignment) => ({ role: assignment.role, provider: assignment.providerId, model: assignment.modelId })),
      };
    } catch (error) {
      return { active: "demo", available: false, message: error instanceof Error ? error.message : "Provider configuration is unavailable.", roles: [] };
    }
  }

  async #open(root: string, source: "demo" | "local"): Promise<ProjectView> {
    const embedding = source === "demo"
      ? new LocalHashEmbeddingProvider()
      : createEmbeddingProvider(this.#environment, new EnvironmentCredentialSource(this.#environment));
    const indexed = await new RepositoryIndexer({ repositorySource: new LocalFolderRepository(), parser: new TypeScriptCodeParser(), embeddingProvider: embedding, indexStore: this.#indexStore }).index(root);
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
      knowledgeStatus: "ready",
    };
    this.#sessions.set(id, { id, root, source, project, retrieval: new CodeRetrievalService(indexed.index, embedding) });
    return project;
  }

  #session(id: string): ProjectSession {
    const session = this.#sessions.get(id);
    if (session === undefined) throw new ProductServiceError("project_missing", "This project session is no longer available.", "Open the repository again.");
    return session;
  }

  async #withFreeUsage<T>(operation: "ask" | "investigate" | "task", execute: () => Promise<T>): Promise<T> {
    if (await this.#providerSettings.activeSet() !== undefined) return execute();
    const runtime = loadRuntimeConfig(this.#environment);
    if (runtime.mode !== "free") return execute();
    const reasoning = loadReasoningConfiguration(runtime, this.#environment);
    const assignments = operation === "task"
      ? [...reasoning.assignments, ...loadTaskConfiguration(runtime, this.#environment).assignments]
      : reasoning.assignments;
    try {
      return await this.#freeUsage.run(
        { clientId: "loopback", operation, models: assignments.map((assignment) => assignment.modelId) },
        execute,
      );
    } catch (error) {
      if (error instanceof FreeUsageError) {
        throw new ProductServiceError(error.code, error.message, "Review the host Free Mode limits or wait before retrying.");
      }
      throw error;
    }
  }

  async #liveReasoning(retrieval: CodeRetrievalService, onTrace?: (event: ReasoningTraceEvent) => void): Promise<ReasoningEngine> {
    const activeSet = await this.#providerSettings.activeSet();
    if (activeSet !== undefined) {
      const assignments = activeSet.roles
        .filter((assignment) => REASONING_ROLES.has(assignment.role))
        .map((assignment) => ({ role: assignment.role as "investigator" | "skeptic" | "architect" | "verifier" | "judge", providerId: assignment.connectionId, modelId: assignment.model }));
      const localOnly = activeSet.providers.every((provider) => LOCAL_PROVIDER_IDS.has(provider.provider));
      return new ReasoningEngine({ retrieval, runtime: new StructuredAgentRuntime(providersForSet(activeSet), assignments, DEFAULT_REASONING_LIMITS), preset: localOnly ? "local" : "full", ...(onTrace === undefined ? {} : { onTrace }) });
    }
    const runtime = loadRuntimeConfig(this.#environment);
    const reasoning = loadReasoningConfiguration(runtime, this.#environment);
    const providers = createProviderRuntime(runtime, new EnvironmentCredentialSource(this.#environment), [...reasoning.assignments, ...reasoning.modelProfiles]);
    return new ReasoningEngine({ retrieval, runtime: new StructuredAgentRuntime(providers, reasoning.assignments, DEFAULT_REASONING_LIMITS, { profiles: reasoning.modelProfiles, fallbackPolicy: reasoning.fallbackPolicy }), preset: reasoning.preset, ...(onTrace === undefined ? {} : { onTrace }) });
  }

  async #liveTask(retrieval: CodeRetrievalService, permissions: ExecutionPermissions): Promise<TaskExecutionEngine> {
    const activeSet = await this.#providerSettings.activeSet();
    if (activeSet !== undefined) {
      const providers = providersForSet(activeSet);
      const reasoningAssignments = activeSet.roles
        .filter((assignment) => REASONING_ROLES.has(assignment.role))
        .map((assignment) => ({ role: assignment.role as "investigator" | "skeptic" | "architect" | "verifier" | "judge", providerId: assignment.connectionId, modelId: assignment.model }));
      const taskAssignments = activeSet.roles
        .filter((assignment) => TASK_ROLES.has(assignment.role))
        .map((assignment) => ({ role: assignment.role as "planner" | "implementer" | "reviewer", providerId: assignment.connectionId, modelId: assignment.model }));
      const localOnly = activeSet.providers.every((provider) => LOCAL_PROVIDER_IDS.has(provider.provider));
      const allowedPackageScripts = loadTaskConfiguration(runtimeForConnection(activeSet.providers[0] as StoredProviderConnection), this.#environment).allowedPackageScripts;
      const investigator = new ReasoningEngine({ retrieval, runtime: new StructuredAgentRuntime(providers, reasoningAssignments, DEFAULT_REASONING_LIMITS), preset: localOnly ? "local" : "full" });
      return new TaskExecutionEngine({ investigator, taskRuntime: new StructuredTaskAgentRuntime(providers, taskAssignments, DEFAULT_TASK_EXECUTION_LIMITS), permissions, limits: DEFAULT_TASK_EXECUTION_LIMITS, allowedPackageScripts });
    }
    const runtime = loadRuntimeConfig(this.#environment);
    const reasoning = loadReasoningConfiguration(runtime, this.#environment);
    const task = loadTaskConfiguration(runtime, this.#environment);
    const providers = createProviderRuntime(runtime, new EnvironmentCredentialSource(this.#environment), [...reasoning.assignments, ...reasoning.modelProfiles, ...task.assignments]);
    const investigator = new ReasoningEngine({ retrieval, runtime: new StructuredAgentRuntime(providers, reasoning.assignments, DEFAULT_REASONING_LIMITS, { profiles: reasoning.modelProfiles, fallbackPolicy: reasoning.fallbackPolicy }), preset: reasoning.preset });
    return new TaskExecutionEngine({ investigator, taskRuntime: new StructuredTaskAgentRuntime(providers, task.assignments, DEFAULT_TASK_EXECUTION_LIMITS), permissions, limits: DEFAULT_TASK_EXECUTION_LIMITS, allowedPackageScripts: task.allowedPackageScripts });
  }

  async #demoTask(
    root: string,
    objective: string,
    planOnly: boolean,
    permissions: ExecutionPermissions,
    depth: ProductAnalysisDepth,
    signal?: AbortSignal,
    onTrace?: (event: TaskTraceEvent) => void,
    onSnapshot?: (snapshot: AnalysisSnapshot) => void,
  ): Promise<TaskExecutionResult> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "conclave-web-demo-"));
    const repositoryRoot = join(temporaryRoot, "repository");
    await cp(root, repositoryRoot, { recursive: true, dereference: false });
    try {
      const engine = await createDemoTaskEngine(repositoryRoot, permissions);
      return await engine.execute({ intent: "task", repositoryRoot, objective, planOnly, analysisDepth: depth, ...(signal === undefined ? {} : { signal }), ...(onTrace === undefined ? {} : { onTrace }), ...(onSnapshot === undefined ? {} : { onSnapshot }) });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  #error(intent: ProductIntent, error: unknown, action: string, retrieval: CodeRetrievalService): ProductRunView {
    // ProviderError and AgentExecutionError already redact credentials; preserve their
    // bounded diagnostic here so CLI smoke tests and the local UI can explain failures.
    const message = error instanceof Error
      ? error.message.slice(0, 500)
      : "Conclave could not complete this bounded run.";
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

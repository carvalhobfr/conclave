import { createHash } from "node:crypto";

import { TypeScriptCodeParser } from "../code-intelligence/typescript-parser.js";
import type { Evidence } from "../domain/evidence.js";
import type { AnalysisDepth, AnalysisSnapshot } from "../domain/adaptive-reasoning.js";
import type { ReasoningResult } from "../domain/reasoning.js";
import type {
  CapabilityDecision,
  ChangedFile,
  CheckResult,
  ConclaveIntent,
  ExecutionPermissions,
  ExecutionVerdict,
  ImplementationClaim,
  ImplementationTask,
  PatchRecord,
  RepositoryExecutionSnapshot,
  RequirementVerification,
  ReviewFinding,
  ReviewResult,
  RevisionRequest,
  TaskAgentRole,
  TaskExecutionLimits,
  TaskExecutionMetrics,
  TaskExecutionResult,
  TaskRoleUsage,
  TaskTraceEvent,
  TaskTraceEventType,
} from "../domain/task-execution.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../indexing/repository-indexer.js";
import { LocalFolderRepository } from "../repositories/local-folder-repository.js";
import type { ReasoningEngine } from "../reasoning/reasoning-engine.js";
import { FollowUpRetrievalExecutor } from "../reasoning/retrieval-executor.js";
import { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import { resolveRepositoryRoot } from "../security/path-policy.js";
import { ExecutionCapabilityPolicy } from "./capability-policy.js";
import { CommandPolicy } from "./command-policy.js";
import { ExecutionWorkspaceManager } from "./execution-workspace.js";
import { RepositoryEditError, RepositoryEditor } from "./repository-editor.js";
import { StructuredCommandRunner } from "./structured-command-runner.js";
import type { StructuredTaskAgentRuntime, TaskAgentCallRecord } from "./task-agent-runtime.js";
import { TaskAgentExecutionError } from "./task-agent-runtime.js";
import { implementerPrompt, plannerPrompt, reviewerPrompt } from "./task-prompts.js";
import {
  parseImplementationPlan,
  parseImplementerResult,
  parseReviewResult,
} from "./task-structured-outputs.js";
import { TaskDeterministicVerifier } from "./task-verifier.js";

export interface TaskExecutionRequest {
  readonly intent: ConclaveIntent;
  readonly repositoryRoot: string;
  readonly objective: string;
  readonly planOnly?: boolean;
  readonly signal?: AbortSignal;
  readonly analysisDepth?: AnalysisDepth;
  readonly onTrace?: (event: TaskTraceEvent) => void;
  readonly onSnapshot?: (snapshot: AnalysisSnapshot) => void;
}

export interface TaskExecutionEngineOptions {
  readonly investigator: Pick<ReasoningEngine, "ask">;
  readonly taskRuntime: StructuredTaskAgentRuntime;
  readonly permissions: ExecutionPermissions;
  readonly limits: TaskExecutionLimits;
  readonly allowedPackageScripts?: readonly string[];
  readonly workspaceManager?: ExecutionWorkspaceManager;
}

export class TaskExecutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TaskExecutionError";
  }
}

function stableId(prefix: string, ...parts: readonly (string | number)[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

function dedupeEvidence(items: readonly Evidence[]): readonly Evidence[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function usage(records: readonly TaskAgentCallRecord[]): readonly TaskRoleUsage[] {
  const roles: readonly TaskAgentRole[] = ["planner", "implementer", "reviewer"];
  return roles.map((role) => {
    const selected = records.filter((record) => record.role === role);
    return {
      role,
      providerIds: [...new Set(selected.map((record) => record.providerId))],
      modelIds: [...new Set(selected.map((record) => record.modelId))],
      calls: selected.length,
      approximateInputTokens: selected.reduce((total, record) => total + record.approximateInputTokens, 0),
      approximateOutputTokens: selected.reduce((total, record) => total + record.approximateOutputTokens, 0),
      providerReportedInputTokens: selected.reduce(
        (total, record) => total + (record.providerUsage?.inputTokens ?? 0),
        0,
      ),
      providerReportedOutputTokens: selected.reduce(
        (total, record) => total + (record.providerUsage?.outputTokens ?? 0),
        0,
      ),
      latencyMs: selected.reduce((total, record) => total + record.latencyMs, 0),
    };
  });
}

function emptyReview(summary: string): ReviewResult {
  return { status: "uncertain", summary, findings: [] };
}

function plannedSnapshot(root: string): RepositoryExecutionSnapshot {
  return {
    originalRoot: root,
    isolation: "none",
    gitBacked: false,
    dirtyPaths: [],
  };
}

interface MutableExecutionState {
  patchRecords: PatchRecord[];
  decisions: CapabilityDecision[];
  checks: CheckResult[];
  revisions: RevisionRequest[];
  postEvidence: Evidence[];
  claims: ImplementationClaim[];
  review: ReviewResult;
  finalRequirements: RequirementVerification[];
  finalChangedFiles: ChangedFile[];
  finalClaimOutcomes: Map<string, RequirementVerification["outcome"]>;
}

export class TaskExecutionEngine {
  readonly #investigator: Pick<ReasoningEngine, "ask">;
  readonly #runtime: StructuredTaskAgentRuntime;
  readonly #permissions: ExecutionPermissions;
  readonly #limits: TaskExecutionLimits;
  readonly #allowedPackageScripts: readonly string[];
  readonly #workspaceManager: ExecutionWorkspaceManager;

  public constructor(options: TaskExecutionEngineOptions) {
    this.#investigator = options.investigator;
    this.#runtime = options.taskRuntime;
    this.#permissions = options.permissions;
    this.#limits = options.limits;
    this.#allowedPackageScripts = options.allowedPackageScripts ?? [];
    this.#workspaceManager = options.workspaceManager ?? new ExecutionWorkspaceManager();
  }

  public async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    if (request.intent !== "task") throw new TaskExecutionError("Repository edits require explicit task intent");
    if (request.objective.trim() === "") throw new TaskExecutionError("Task objective cannot be empty");
    const started = performance.now();
    const trace: TaskTraceEvent[] = [];
    const calls: TaskAgentCallRecord[] = [];
    let round = 0;
    const emit = (
      type: TaskTraceEventType,
      detail: string,
      data?: Readonly<Record<string, string | number | boolean>>,
    ): void => {
      trace.push({
        sequence: trace.length + 1,
        type,
        occurredAt: new Date().toISOString(),
        round,
        detail,
        ...(data === undefined ? {} : { data }),
      });
      request.onTrace?.(trace[trace.length - 1] as TaskTraceEvent);
    };
    emit("task_started", request.objective);
    request.signal?.throwIfAborted();
    const originalRoot = await resolveRepositoryRoot(request.repositoryRoot);
    const investigation = await this.#investigator.ask(request.objective, "conclave", {
      depth: request.analysisDepth ?? "balanced",
      intent: "task",
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.onSnapshot === undefined ? {} : { onSnapshot: request.onSnapshot }),
    });
    request.signal?.throwIfAborted();
    const diagnosisClaims = investigation.verdict.claims.supported;
    if (diagnosisClaims.length === 0) {
      throw new TaskExecutionError("Task Mode requires at least one supported diagnosis claim");
    }
    const preChangeEvidence = investigation.state.evidence;
    const baseline = await this.#createIndexer().index(originalRoot);
    request.signal?.throwIfAborted();
    const repositoryPaths = Object.keys(baseline.index.files).sort();
    const plan = await this.#executeRole(
      "planner",
      plannerPrompt(request.objective, diagnosisClaims, preChangeEvidence, repositoryPaths),
      (raw) =>
        parseImplementationPlan(
          raw,
          new Set(diagnosisClaims.map((claim) => claim.id)),
          new Set(preChangeEvidence.map((item) => item.id)),
          new Set(repositoryPaths),
        ),
      calls,
      request.signal,
    );
    const task: ImplementationTask = {
      id: stableId("task", originalRoot, request.objective),
      objective: request.objective,
      diagnosisClaimIds: diagnosisClaims.map((claim) => claim.id),
      targetEvidenceIds: plan.evidenceIds,
      affectedAreas: [...new Set(plan.steps.flatMap((step) => step.targetFiles))],
      plan,
    };
    emit("implementation_plan_created", plan.summary, {
      requirements: plan.requirements.length,
      steps: plan.steps.length,
    });
    const state: MutableExecutionState = {
      patchRecords: [],
      decisions: [],
      checks: [],
      revisions: [],
      postEvidence: [],
      claims: [],
      review: emptyReview("Review has not run"),
      finalRequirements: [],
      finalChangedFiles: [],
      finalClaimOutcomes: new Map(),
    };
    if (request.planOnly === true) {
      emit("execution_verdict_completed", "Plan-only mode completed without repository mutation");
      return this.#result(
        task,
        diagnosisClaims,
        preChangeEvidence,
        plannedSnapshot(originalRoot),
        state,
        {
          status: "planned",
          summary: "Verified implementation plan created; no repository mutation was permitted",
          requirements: [],
          changedFiles: [],
          supportedClaims: [],
          rejectedClaims: [],
          uncertainClaims: [],
          checks: [],
          revisionRounds: 0,
        },
        investigation,
        trace,
        calls,
        started,
      );
    }
    emit("execution_permission_checked", "Checked Task Mode permissions", {
      allowFileEdits: this.#permissions.allowFileEdits,
      allowCommands: this.#permissions.allowCommands,
      allowRepositoryScripts: this.#permissions.allowRepositoryScripts,
      allowNetwork: this.#permissions.allowNetwork,
    });
    if (!this.#permissions.allowFileEdits) {
      emit("execution_blocked", "File edit permission is required");
      return this.#result(
        task,
        diagnosisClaims,
        preChangeEvidence,
        plannedSnapshot(originalRoot),
        state,
        this.#blockedVerdict("Task Mode file edit permission is disabled"),
        investigation,
        trace,
        calls,
        started,
      );
    }

    const workspace = await this.#workspaceManager.prepare(originalRoot);
    emit("repository_snapshot_created", `Repository isolation: ${workspace.snapshot.isolation}`, {
      dirtyPaths: workspace.snapshot.dirtyPaths.length,
    });
    if (workspace.status === "blocked" || workspace.snapshot.executionRoot === undefined) {
      emit("execution_blocked", "Safe execution workspace could not be created");
      return this.#result(
        task,
        diagnosisClaims,
        preChangeEvidence,
        workspace.snapshot,
        state,
        this.#blockedVerdict(
          workspace.snapshot.dirtyPaths.length > 0
            ? "Target repository has user changes; Task Mode preserved them and blocked execution"
            : "Safe execution workspace could not be created",
        ),
        investigation,
        trace,
        calls,
        started,
      );
    }

    try {
      const executionRoot = workspace.snapshot.executionRoot;
      const editor = await RepositoryEditor.create(executionRoot, this.#limits);
      const indexer = this.#createIndexer();
      const initialWorkspaceIndex = await indexer.index(executionRoot);
      let retrieval = new CodeRetrievalService(
        initialWorkspaceIndex.index,
        new LocalHashEmbeddingProvider(),
      );
      const commandPolicy = await CommandPolicy.create({
        repositoryRoot: executionRoot,
        permissions: this.#permissions,
        limits: this.#limits,
        allowedPackageScripts: this.#allowedPackageScripts,
      });
      const capabilityPolicy = new ExecutionCapabilityPolicy(this.#permissions, commandPolicy);
      const runner = new StructuredCommandRunner();
      const allowedPaths = new Set(Object.keys(initialWorkspaceIndex.index.files));
      const plannedFiles = new Set(task.affectedAreas);
      const originalHashes = new Map<string, string>();
      const seenSignatures = new Set<string>();
      let revision: RevisionRequest | undefined;
      let verdict: ExecutionVerdict | undefined;

      for (round = 1; round <= this.#limits.maxImplementationRounds; round += 1) {
        request.signal?.throwIfAborted();
        if (performance.now() - started > this.#limits.maxExecutionDurationMs) {
          emit("execution_blocked", "Task execution duration budget exhausted");
          break;
        }
        emit("implementer_started", `Implementation round ${String(round)}`);
        const visiblePaths = new Set([
          ...task.affectedAreas,
          ...(revision?.allowedFiles ?? []),
        ]);
        const files = await Promise.all([...visiblePaths].map((path) => editor.read(path)));
        const implementer = await this.#executeRole(
          "implementer",
          implementerPrompt(
            task,
            files,
            round,
            revision,
            state.patchRecords,
            state.checks,
            state.postEvidence,
          ),
          (raw) =>
            parseImplementerResult(
              raw,
              plan,
              new Set([...preChangeEvidence, ...state.postEvidence].map((item) => item.id)),
              allowedPaths,
            ),
          calls,
          request.signal,
        );
        state.claims.push(...implementer.claims);
        for (const claim of implementer.claims) {
          emit("implementation_claim_proposed", claim.statement);
        }
        for (const patch of implementer.patches) emit("patch_proposed", `${patch.path}: ${patch.id}`);

        const patchIds = new Set(implementer.patches.map((patch) => patch.id));
        const authorizations = await Promise.all(
          implementer.capabilityRequests.map(async (capability) => {
            if (capability.kind === "run-command") emit("command_requested", capability.reason);
            const authorization = await capabilityPolicy.authorize(capability, {
              knownPatchIds: patchIds,
              allowedReadPaths: visiblePaths,
              retrievalRequestsRemaining: Math.max(
                0,
                this.#limits.maxAdditionalEvidence - state.postEvidence.length,
              ),
            });
            state.decisions.push(authorization.decision);
            if (capability.kind === "run-command") {
              emit(
                authorization.decision.outcome === "allowed" ? "command_allowed" : "command_rejected",
                authorization.decision.reason,
              );
            }
            return { capability, authorization };
          }),
        );

        const approvedPatchIds = new Set(
          authorizations
            .filter(
              (item) =>
                item.capability.kind === "apply-patches" &&
                item.authorization.decision.outcome === "allowed",
            )
            .flatMap((item) =>
              item.capability.kind === "apply-patches" ? item.capability.patchIds : [],
            ),
        );
        const approvedPatches = implementer.patches.filter((patch) => approvedPatchIds.has(patch.id));
        let patchRecord: PatchRecord | undefined;
        let patchApplicationFailed = false;
        let patchApplicationError: string | undefined;
        if (approvedPatches.length > 0) {
          request.signal?.throwIfAborted();
          for (const path of new Set(approvedPatches.map((patch) => patch.path))) {
            if (!originalHashes.has(path)) originalHashes.set(path, (await editor.read(path)).hash);
          }
          try {
            emit("patch_validated", `Validated ${String(approvedPatches.length)} structured patches`);
            patchRecord = await editor.apply(approvedPatches, plannedFiles);
            state.patchRecords.push(patchRecord);
            emit("patch_applied", patchRecord.id, {
              files: patchRecord.changedFiles.length,
              changedLines: patchRecord.totalChangedLines,
            });
          } catch (error) {
            if (!(error instanceof RepositoryEditError)) throw error;
            patchApplicationFailed = true;
            patchApplicationError = error.message;
            state.review = {
              status: "revision-required",
              summary: error.message,
              findings: [
                {
                  id: stableId("finding", round, error.message),
                  type: "security",
                  severity: "blocking",
                  statement: error.message,
                  requirementIds: [],
                  paths: approvedPatches.map((patch) => patch.path),
                  evidenceIds: [],
                },
              ],
            };
          }
        }

        if (patchRecord !== undefined) {
          const reindexed = await indexer.index(executionRoot);
          retrieval = new CodeRetrievalService(reindexed.index, new LocalHashEmbeddingProvider());
          emit("repository_reindexed", "Incrementally reindexed execution workspace", {
            changed: reindexed.stats.filesChanged,
            unchanged: reindexed.stats.filesUnchanged,
          });
        }

        const roundChecks: CheckResult[] = [];
        for (const item of authorizations.filter((entry) => entry.capability.kind === "run-command")) {
          if (item.capability.kind !== "run-command") continue;
          const approved = item.authorization.commandAuthorization?.approved;
          if (approved === undefined || patchApplicationFailed) {
            const rejected: CheckResult = {
              requestId: item.capability.id,
              command: item.capability.command,
              status: "rejected",
              stdout: "",
              stderr: "",
              outputTruncated: false,
              durationMs: 0,
              policyReason: patchApplicationFailed
                ? "Check was not executed because patch application failed"
                : item.authorization.decision.reason,
            };
            roundChecks.push(rejected);
            state.checks.push(rejected);
            continue;
          }
          if (state.checks.length >= this.#limits.maxCommands) {
            const rejected: CheckResult = {
              requestId: item.capability.id,
              command: item.capability.command,
              status: "rejected",
              stdout: "",
              stderr: "",
              outputTruncated: false,
              durationMs: 0,
              policyReason: "Task command-count budget exhausted",
            };
            roundChecks.push(rejected);
            state.checks.push(rejected);
            continue;
          }
          emit("command_started", item.capability.id);
          const command = item.capability.command;
          const check = await runner.run(approved, request.signal).catch(
            (error: unknown): CheckResult => ({
              requestId: item.capability.id,
              command,
              status: "failed",
              stdout: "",
              stderr: error instanceof Error ? error.message : "Command runner failed",
              outputTruncated: false,
              durationMs: 0,
              policyReason: approved.policyReason,
            }),
          );
          roundChecks.push(check);
          state.checks.push(check);
          emit("command_completed", `${item.capability.id}: ${check.status}`);
        }

        for (const item of authorizations.filter((entry) => entry.capability.kind === "retrieve")) {
          if (item.capability.kind !== "retrieve" || item.authorization.decision.outcome !== "allowed") continue;
          const existingEvidenceIds = new Set(state.postEvidence.map((evidence) => evidence.id));
          const remainingEvidence = Math.max(
            0,
            this.#limits.maxAdditionalEvidence - existingEvidenceIds.size,
          );
          if (remainingEvidence === 0) continue;
          const result = await new FollowUpRetrievalExecutor(
            retrieval,
            remainingEvidence,
            4,
          ).execute({
            id: item.capability.id,
            request: item.capability.request,
            requestedBy: "verifier",
            iteration: round,
          }, request.signal);
          state.postEvidence.push(
            ...result.evidence.filter((evidence) => !existingEvidenceIds.has(evidence.id)).slice(0, remainingEvidence),
          );
        }

        state.finalChangedFiles = await this.#netChangedFiles(
          editor,
          originalHashes,
          state.patchRecords,
          plannedFiles,
        );
        const verifier = new TaskDeterministicVerifier(
          retrieval,
          state.finalChangedFiles,
          state.checks,
        );
        const requirementExecutions = plan.requirements.map((requirement) =>
          verifier.verifyRequirement(requirement),
        );
        state.finalRequirements = requirementExecutions.map((execution) => execution.result);
        state.postEvidence.push(...requirementExecutions.flatMap((execution) => execution.evidence));
        state.postEvidence = [...dedupeEvidence(state.postEvidence)];
        const claimExecutions = state.claims.map((claim) => ({
          claim,
          execution: verifier.verifyClaim(claim),
        }));
        const currentClaimIds = new Set(implementer.claims.map((claim) => claim.id));
        const currentClaimExecutions = claimExecutions.filter(({ claim }) => currentClaimIds.has(claim.id));
        for (const { claim, execution } of claimExecutions) {
          if (!state.finalClaimOutcomes.has(claim.id)) {
            state.finalClaimOutcomes.set(claim.id, execution.result.outcome);
          }
        }
        state.postEvidence.push(...claimExecutions.flatMap(({ execution }) => execution.evidence));
        emit("post_change_evidence_created", "Created post-change deterministic evidence", {
          evidence: state.postEvidence.length,
        });

        emit("reviewer_started", `Review round ${String(round)}`);
        const modelReview = await this.#executeRole(
          "reviewer",
          reviewerPrompt(
            task,
            diagnosisClaims,
            state.patchRecords,
            state.checks,
            state.postEvidence,
            state.claims,
          ),
          (raw) =>
            parseReviewResult(
              raw,
              new Set(plan.requirements.map((requirement) => requirement.id)),
              new Set([...allowedPaths, ...state.finalChangedFiles.map((file) => file.path)]),
              new Set(state.postEvidence.map((item) => item.id)),
            ),
          calls,
          request.signal,
        );
        state.review = this.#enforceReview(
          modelReview,
          plan.requirements.map((requirement) => requirement.id),
          state.finalRequirements,
          state.finalChangedFiles,
          roundChecks,
          currentClaimExecutions.map(({ claim, execution }) => ({ claim, result: execution.result })),
          patchApplicationError,
          round,
        );
        const requiredSatisfied = plan.requirements
          .filter((requirement) => requirement.required)
          .every(
            (requirement) =>
              state.finalRequirements.find((result) => result.requirementId === requirement.id)
                ?.outcome === "supported",
          );
        const blocking = state.review.findings.some((finding) => finding.severity === "blocking");
        if (requiredSatisfied && !blocking && state.review.status !== "revision-required") {
          const uncertain =
            state.review.status === "uncertain" ||
            state.finalRequirements.some((result) => result.outcome === "uncertain");
          verdict = this.#verdict(
            uncertain ? "completed-with-uncertainty" : "completed",
            uncertain
              ? "Required changes are supported, with explicitly retained uncertainty"
              : "All required changes are supported by post-change repository state",
            state,
          );
          break;
        }

        const signature = state.finalChangedFiles
          .map((file) => `${file.path}:${file.resultingHash ?? ""}`)
          .sort()
          .join("|");
        if (seenSignatures.has(signature)) {
          emit("execution_blocked", "Revision produced no new repository state");
          break;
        }
        seenSignatures.add(signature);
        if (round < this.#limits.maxImplementationRounds) {
          const failedRequirements = state.finalRequirements
            .filter((result) => result.outcome !== "supported")
            .map((result) => result.requirementId);
          const rejectedClaims = claimExecutions
            .filter(({ execution }) => execution.result.outcome === "rejected")
            .map(({ claim }) => claim.id);
          revision = {
            id: stableId("revision", task.id, round, ...failedRequirements),
            round,
            failedRequirementIds: failedRequirements,
            rejectedClaimIds: rejectedClaims,
            findingIds: state.review.findings.map((finding) => finding.id),
            evidenceIds: [...new Set(state.review.findings.flatMap((finding) => finding.evidenceIds))],
            allowedFiles: [...new Set([...task.affectedAreas, ...state.finalChangedFiles.map((file) => file.path)])],
            instructions: state.review.findings.map((finding) => finding.statement).join("; "),
          };
          state.revisions.push(revision);
          emit("revision_requested", revision.instructions);
        }
      }

      if (verdict === undefined) {
        verdict = this.#verdict(
          "failed",
          "Task requirements were not fully supported within bounded revision limits",
          state,
        );
      }
      emit("execution_verdict_completed", verdict.summary, {
        status: verdict.status,
        revisions: state.revisions.length,
      });
      return this.#result(
        task,
        diagnosisClaims,
        preChangeEvidence,
        workspace.snapshot,
        state,
        verdict,
        investigation,
        trace,
        calls,
        started,
      );
    } finally {
      await workspace.cleanup();
    }
  }

  async #executeRole<T>(
    role: TaskAgentRole,
    prompt: string,
    validate: (raw: string) => T,
    calls: TaskAgentCallRecord[],
    signal?: AbortSignal,
  ): Promise<T> {
    const remaining = this.#limits.maxModelCalls - calls.length;
    try {
      const execution = await this.#runtime.execute(role, prompt, validate, remaining, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 60_000,
      });
      calls.push(...execution.calls);
      return execution.output;
    } catch (error) {
      if (error instanceof TaskAgentExecutionError) calls.push(...error.calls);
      throw new TaskExecutionError(error instanceof Error ? error.message : `${role} failed`);
    }
  }

  #createIndexer(): RepositoryIndexer {
    return new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new TypeScriptCodeParser(),
      embeddingProvider: new LocalHashEmbeddingProvider(),
      indexStore: new InMemoryCodeIndexStore(),
    });
  }

  async #netChangedFiles(
    editor: RepositoryEditor,
    originalHashes: ReadonlyMap<string, string>,
    records: readonly PatchRecord[],
    plannedFiles: ReadonlySet<string>,
  ): Promise<ChangedFile[]> {
    const results: ChangedFile[] = [];
    for (const [path, originalHash] of originalHashes) {
      const current = await editor.read(path);
      if (current.hash === originalHash) continue;
      const latest = [...records]
        .reverse()
        .flatMap((record) => record.changedFiles)
        .find((file) => file.path === path);
      if (latest !== undefined) {
        results.push({
          ...latest,
          originalHash,
          resultingHash: current.hash,
          expectedByPlan: plannedFiles.has(path),
        });
      }
    }
    return results.sort((left, right) => left.path.localeCompare(right.path));
  }

  #enforceReview(
    model: ReviewResult,
    requirementIds: readonly string[],
    requirements: readonly RequirementVerification[],
    changedFiles: readonly ChangedFile[],
    roundChecks: readonly CheckResult[],
    currentClaims: readonly {
      readonly claim: ImplementationClaim;
      readonly result: RequirementVerification;
    }[],
    patchApplicationError: string | undefined,
    round: number,
  ): ReviewResult {
    const findings: ReviewFinding[] = [...model.findings];
    if (patchApplicationError !== undefined) {
      findings.push({
        id: stableId("finding", round, "patch", patchApplicationError),
        type: "security",
        severity: "blocking",
        statement: patchApplicationError,
        requirementIds: [],
        paths: [],
        evidenceIds: [],
      });
    }
    for (const file of changedFiles.filter((item) => !item.expectedByPlan)) {
      findings.push({
        id: stableId("finding", round, "unrelated", file.path),
        type: "unrelated-change",
        severity: "blocking",
        statement: `Unexpected file changed outside the verified plan: ${file.path}`,
        requirementIds: [],
        paths: [file.path],
        evidenceIds: [],
      });
    }
    for (const result of requirements.filter((item) => item.outcome !== "supported")) {
      findings.push({
        id: stableId("finding", round, "requirement", result.requirementId, result.outcome),
        type: "requirement-gap",
        severity: "blocking",
        statement: result.explanation,
        requirementIds: requirementIds.includes(result.requirementId) ? [result.requirementId] : [],
        paths: [],
        evidenceIds: result.evidenceIds,
      });
    }
    for (const check of roundChecks.filter((item) => item.status !== "passed")) {
      findings.push({
        id: stableId("finding", round, "check", check.requestId, check.status),
        type: "failed-check",
        severity: "blocking",
        statement: `Requested check ${check.requestId} finished with ${check.status}`,
        requirementIds: [],
        paths: [],
        evidenceIds: [],
      });
    }
    for (const { claim, result } of currentClaims.filter((item) => item.result.outcome === "rejected")) {
      findings.push({
        id: stableId("finding", round, "claim", claim.id, "rejected"),
        type: "unsupported-claim",
        severity: "blocking",
        statement: `Current implementation claim is rejected: ${claim.statement}`,
        requirementIds: claim.requirementIds,
        paths: [],
        evidenceIds: result.evidenceIds,
      });
    }
    for (const { claim, result } of currentClaims.filter((item) => item.result.outcome === "uncertain")) {
      findings.push({
        id: stableId("finding", round, "claim", claim.id, "uncertain"),
        type: "unsupported-claim",
        severity: "warning",
        statement: `Current implementation claim remains uncertain: ${claim.statement}`,
        requirementIds: claim.requirementIds,
        paths: [],
        evidenceIds: result.evidenceIds,
      });
    }
    const deduped = [...new Map(findings.map((finding) => [finding.id, finding])).values()];
    const hasBlocking = deduped.some((finding) => finding.severity === "blocking");
    const hasUncertainClaim = currentClaims.some((item) => item.result.outcome === "uncertain");
    return {
      status: hasBlocking ? "revision-required" : hasUncertainClaim ? "uncertain" : model.status,
      summary: model.summary,
      findings: deduped,
    };
  }

  #verdict(
    status: ExecutionVerdict["status"],
    summary: string,
    state: MutableExecutionState,
  ): ExecutionVerdict {
    const supportedClaims = state.claims.filter(
      (claim) => state.finalClaimOutcomes.get(claim.id) === "supported",
    );
    const rejectedClaims = state.claims.filter(
      (claim) => state.finalClaimOutcomes.get(claim.id) === "rejected",
    );
    const uncertainClaims = state.claims.filter(
      (claim) => state.finalClaimOutcomes.get(claim.id) === "uncertain",
    );
    return {
      status,
      summary,
      requirements: state.finalRequirements,
      changedFiles: state.finalChangedFiles,
      supportedClaims,
      rejectedClaims,
      uncertainClaims,
      checks: state.checks,
      revisionRounds: state.revisions.length,
    };
  }

  #blockedVerdict(summary: string): ExecutionVerdict {
    return {
      status: "blocked",
      summary,
      requirements: [],
      changedFiles: [],
      supportedClaims: [],
      rejectedClaims: [],
      uncertainClaims: [],
      checks: [],
      revisionRounds: 0,
    };
  }

  #result(
    task: ImplementationTask,
    diagnosisClaims: ReasoningResult["verdict"]["claims"]["supported"],
    preChangeEvidence: readonly Evidence[],
    snapshot: RepositoryExecutionSnapshot,
    state: MutableExecutionState,
    verdict: ExecutionVerdict,
    investigation: ReasoningResult,
    trace: readonly TaskTraceEvent[],
    calls: readonly TaskAgentCallRecord[],
    started: number,
  ): TaskExecutionResult {
    const roleUsage = usage(calls);
    const metrics: TaskExecutionMetrics = {
      investigation: investigation.metrics,
      taskModelCalls: calls.length,
      commandCount: state.checks.filter((check) => check.status !== "rejected").length,
      revisionRounds: state.revisions.length,
      filesChanged: verdict.changedFiles.length,
      changedLines: verdict.changedFiles.reduce(
        (total, file) => total + file.additions + file.deletions,
        0,
      ),
      approximateInputTokens: roleUsage.reduce((total, item) => total + item.approximateInputTokens, 0),
      approximateOutputTokens: roleUsage.reduce((total, item) => total + item.approximateOutputTokens, 0),
      providerReportedInputTokens: roleUsage.reduce(
        (total, item) => total + item.providerReportedInputTokens,
        0,
      ),
      providerReportedOutputTokens: roleUsage.reduce(
        (total, item) => total + item.providerReportedOutputTokens,
        0,
      ),
      latencyMs: Math.max(0, performance.now() - started),
      roleUsage,
    };
    return {
      intent: "task",
      task,
      diagnosisClaims,
      preChangeEvidence,
      postChangeEvidence: dedupeEvidence(state.postEvidence),
      snapshot,
      patchRecords: state.patchRecords,
      capabilityDecisions: state.decisions,
      review: state.review,
      revisions: state.revisions,
      verdict,
      trace,
      metrics,
    };
  }
}

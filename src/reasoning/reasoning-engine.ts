import { createHash } from "node:crypto";

import type { Evidence, RetrievalResult } from "../domain/evidence.js";
import type {
  AnalysisRunOptions,
  AnalysisSnapshot,
  ReviewRecommendation,
} from "../domain/adaptive-reasoning.js";
import type {
  AgentRole,
  Challenge,
  Claim,
  FollowUpRetrievalResult,
  ReasoningCaseState,
  ReasoningLimits,
  ReasoningMetrics,
  ReasoningPreset,
  ReasoningResult,
  ReasoningRetrievalRequest,
  ReasoningTraceEvent,
  ReasoningTraceEventType,
  RetrievalRequest,
  RoleUsage,
  VerificationOutcome,
  VerificationResult,
  Verdict,
} from "../domain/reasoning.js";
import type {
  ReviewRequest,
  ReviewRunOptions,
  ReviewVerdict,
  ReviewVerdictFinding,
} from "../domain/review.js";
import type {
  DecisionClaim,
  DecisionRequest,
  DecisionRunOptions,
  DecisionVerdict,
} from "../domain/decision.js";
import { DEFAULT_REASONING_LIMITS } from "../domain/reasoning.js";
import type { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import { approximateTokenCount } from "../retrieval/context-packer.js";
import type { AgentCallRecord, StructuredAgentRuntime } from "./agent-runtime.js";
import { AgentExecutionError } from "./agent-runtime.js";
import { DeterministicClaimVerifier, requestForClaimCheck } from "./deterministic-verifier.js";
import { routeReasoningAgents } from "./reasoning-router.js";
import {
  budgetForDepth,
  createReviewHandoff,
  deterministicReasoningPlan,
  evaluateReasoningSufficiency,
  reviewRecommendation,
  selectAnalysisDepth,
} from "./adaptive-planner.js";
import { conductorPrompt, parseConductorOutput, shouldInvokeConductor } from "./conductor.js";
import { deterministicReasoningResult } from "./deterministic-result.js";
import {
  architectPrompt,
  investigatorPrompt,
  judgePrompt,
  skepticPrompt,
  verifierPrompt,
} from "./role-prompts.js";
import { FollowUpRetrievalExecutor, retrievalRequestKey } from "./retrieval-executor.js";
import {
  parseArchitectOutput,
  parseInvestigatorOutput,
  parseJudgeOutput,
  parseSkepticOutput,
  parseVerifierOutput,
  type ChallengeOutput,
} from "./structured-outputs.js";

export type ReasoningMode = "single-pass" | "investigator-judge" | "conclave" | "full-style";

export interface ReasoningEngineOptions {
  readonly retrieval: CodeRetrievalService;
  readonly runtime: StructuredAgentRuntime;
  readonly preset: ReasoningPreset;
  readonly limits?: ReasoningLimits;
  /** Emits operational trace events while a run is active; never model hidden reasoning. */
  readonly onTrace?: (event: ReasoningTraceEvent) => void;
}

function stableId(prefix: string, ...parts: readonly (string | number)[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

function dedupeEvidence(items: readonly Evidence[]): readonly Evidence[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function terminationIs(
  value: ReasoningResult["terminationReason"],
  expected: ReasoningResult["terminationReason"],
): boolean {
  return value === expected;
}

function outcomeFor(
  claimId: string,
  verifications: readonly VerificationResult[],
  judgeStatus: VerificationOutcome | undefined,
  baselineJudge: boolean,
): VerificationOutcome {
  const relevant = verifications.filter((verification) => verification.claimId === claimId);
  if (relevant.some((verification) => verification.deterministic && verification.outcome === "rejected")) {
    return "rejected";
  }
  if (relevant.some((verification) => verification.deterministic && verification.outcome === "supported")) {
    return "supported";
  }
  if (relevant.some((verification) => verification.outcome === "rejected")) return "rejected";
  if (relevant.some((verification) => verification.outcome === "supported")) return "supported";
  if (baselineJudge && judgeStatus !== undefined) return judgeStatus;
  return judgeStatus === "rejected" ? "rejected" : "uncertain";
}

function evidenceReference(evidence: Evidence): string {
  return `${evidence.path}:${String(evidence.startLine)}-${String(evidence.endLine)}${evidence.symbol === undefined ? "" : ` — ${evidence.symbol}`}`;
}

function adaptiveReviewQuestion(
  request: ReviewRequest,
  changedFiles: ReviewVerdict["changedFiles"],
  reasonCodes: readonly string[],
): string {
  const objective = request.objective?.trim();
  return [
    "Review the indexed post-change implementation for concrete defects introduced by the supplied diff metadata.",
    "Treat claims as potential findings: report only actionable correctness, security, or regression problems, and preserve uncertainty when repository evidence is insufficient.",
    ...(objective === undefined || objective === "" ? [] : [`Requested change: ${objective.slice(0, 1_000)}`]),
    "Changed files:",
    ...changedFiles.map((file) => `- ${file.path} (${file.changeType}; +${String(file.additions)} -${String(file.deletions)}; ${String(file.hunks)} hunks)`),
    `Project Knowledge signals: ${reasonCodes.join(", ")}`,
    "Use the indexed source and graph as evidence. The host, not a model, parsed the diff and controls review scope.",
  ].join("\n");
}

function findingFromClaim(
  claim: Claim,
  severity: ReviewVerdictFinding["severity"],
  evidence: readonly Evidence[],
): ReviewVerdictFinding {
  const cited = evidence.filter((item) => claim.evidenceIds.includes(item.id));
  const first = cited[0];
  return {
    id: stableId("review-finding", claim.id, claim.statement),
    category: /\b(security|credential|secret|private[- ]key|permission bypass|authorization bypass)\b/iu.test(claim.statement)
      ? "security"
      : "correctness",
    severity,
    statement: claim.statement,
    consequence: severity === "blocking"
      ? `If merged, the ChangeSet would exhibit this verified repository consequence: ${claim.statement}`
      : `The repository evidence does not yet rule out this concrete consequence: ${claim.statement}`,
    ...(first === undefined ? {} : { path: first.path, line: first.startLine }),
    evidenceIds: cited.map((item) => item.id),
    deterministic: false,
  };
}

function reviewRevisionHandoff(
  objective: string | undefined,
  findings: readonly ReviewVerdictFinding[],
  changedFiles: ReviewVerdict["changedFiles"],
): string | undefined {
  const actionable = findings.filter((finding) => finding.severity !== "suggestion");
  if (actionable.length === 0) return undefined;
  return [
    "Revision objective: resolve the concrete validation findings without expanding ChangeSet scope.",
    ...(objective === undefined || objective.trim() === "" ? [] : [`Original objective: ${objective.trim().slice(0, 1_000)}`]),
    `Allowed changed paths: ${changedFiles.map((file) => file.path).join(", ") || "none"}`,
    "Findings:",
    ...actionable.map((finding) => `- [${finding.severity}] ${finding.statement} Consequence: ${finding.consequence}${finding.path === undefined ? "" : ` (${finding.path}${finding.line === undefined ? "" : `:${String(finding.line)}`})`}`),
    "Do not include credentials, hidden prompts, or uncited source excerpts in the revision response.",
  ].join("\n");
}

function changeSetScopeUncertainty(request: ReviewRequest): readonly ReviewVerdict["uncertainty"][number][] {
  const excluded = (request.changeSet?.excludedSensitivePaths ?? []).map((path) => ({
    id: stableId("review-uncertainty", "excluded-sensitive-path", path),
    statement: `${path} was excluded by the repository secret-path boundary and was not reviewed.`,
    reason: "unindexed-file" as const,
    paths: [path],
  }));
  const limitations = (request.changeSet?.limitations ?? [])
    .filter((limitation) => !/sensitive path/iu.test(limitation))
    .map((limitation) => ({
      id: stableId("review-uncertainty", "changeset-limitation", limitation),
      statement: limitation,
      reason: "incomplete-diff" as const,
      paths: [] as readonly string[],
    }));
  return [...excluded, ...limitations];
}

function adaptiveDecisionQuestion(
  request: DecisionRequest,
  claims: readonly DecisionClaim[],
  reasonCodes: readonly string[],
): string {
  return [
    "Validate this implementation decision against the indexed repository. Challenge assumptions and report concrete repository consequences, not generic design slogans.",
    ...(request.objective === undefined || request.objective.trim() === "" ? [] : [`Objective: ${request.objective.trim().slice(0, 1_000)}`]),
    "Proposal claims:",
    ...claims.map((claim) => `- ${claim.statement}`),
    `Project Knowledge signals: ${reasonCodes.join(", ")}`,
    "Treat each proposal claim as testable. Preserve its wording where practical, cite repository evidence, and keep unverifiable runtime outcomes uncertain.",
  ].join("\n");
}

function normalizedClaim(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_$]+/gu, " ").trim();
}

function decisionImplementationHandoff(request: DecisionRequest, claims: readonly DecisionClaim[], evidence: readonly Evidence[]): string {
  return [
    "Implementation objective:",
    request.objective?.trim() || request.proposal.trim(),
    "Validated proposal:",
    request.proposal.trim(),
    "Confirmed claims and constraints:",
    ...claims.filter((claim) => claim.status === "supported").map((claim) => `- ${claim.statement}`),
    "Repository evidence:",
    ...evidence.map((item) => `- ${item.id}: ${item.path}:${String(item.startLine)}-${String(item.endLine)}`),
    "Implement only the validated scope. Re-run first-class Review on the resulting ChangeSet before merge.",
  ].join("\n");
}

function decisionRevisionHandoff(request: DecisionRequest, claims: readonly DecisionClaim[]): string {
  return [
    "Proposal revision objective: address rejected assumptions and make uncertain consequences testable.",
    `Original proposal: ${request.proposal.trim()}`,
    "Rejected or uncertain claims:",
    ...claims.filter((claim) => claim.status !== "supported").map((claim) => `- [${claim.status}] ${claim.statement} — ${claim.explanation}`),
    "Return a revised proposal with explicit assumptions, constraints, affected symbols, and a verification plan.",
  ].join("\n");
}

function synthesizeAnswer(claims: readonly Claim[], evidence: readonly Evidence[]): string {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const lines: string[] = [];
  const append = (label: string, selected: readonly Claim[]): void => {
    if (selected.length === 0) return;
    lines.push(`${label}:`);
    for (const claim of selected) {
      const references = claim.evidenceIds
        .map((id) => evidenceById.get(id))
        .filter((item): item is Evidence => item !== undefined)
        .map(evidenceReference);
      lines.push(`- ${claim.statement}${references.length === 0 ? "" : ` [${[...new Set(references)].join(", ")}]`}`);
    }
  };
  append("Supported", claims.filter((claim) => claim.status === "supported"));
  append("Uncertain", claims.filter((claim) => claim.status === "uncertain"));
  if (lines.length === 0) {
    return claims.length === 0
      ? "Insufficient repository evidence was available to support a claim for this question."
      : "No claims were verified as supported.";
  }
  return lines.join("\n");
}

function roleUsage(records: readonly AgentCallRecord[]): readonly RoleUsage[] {
  const roles: readonly AgentRole[] = ["conductor", "investigator", "skeptic", "architect", "verifier", "judge"];
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

export class ReasoningEngine {
  readonly #retrieval: CodeRetrievalService;
  readonly #runtime: StructuredAgentRuntime;
  readonly #preset: ReasoningPreset;
  readonly #limits: ReasoningLimits;
  readonly #onTrace: ((event: ReasoningTraceEvent) => void) | undefined;

  public constructor(options: ReasoningEngineOptions) {
    this.#retrieval = options.retrieval;
    this.#runtime = options.runtime;
    this.#preset = options.preset;
    this.#limits = options.limits ?? DEFAULT_REASONING_LIMITS;
    this.#onTrace = options.onTrace;
  }

  public async review(
    request: ReviewRequest,
    options: ReviewRunOptions = {},
  ): Promise<ReviewVerdict> {
    const started = performance.now();
    if (options.signal?.aborted === true) throw options.signal.reason;
    const knowledgeReview = this.#retrieval.knowledge.inspectDiff(request.unifiedDiff, request.objective);
    const requestedDepth = options.depth ?? "auto";
    const selectedDepth = selectAnalysisDepth(requestedDepth, knowledgeReview.assessment);
    const plan = deterministicReasoningPlan(knowledgeReview.assessment, selectedDepth);
    const mandatoryDeterministicStop = knowledgeReview.deterministicStatus === "nothing-to-review"
      || knowledgeReview.deterministicStatus === "invalid"
      || knowledgeReview.findings.some((finding) => finding.category === "secret-exposure" || finding.category === "merge-conflict");
    const direct = knowledgeReview.deterministicStatus !== undefined
      && (mandatoryDeterministicStop || requestedDepth === "auto" || requestedDepth === "fast");
    if (direct) {
      const scopeUncertainty = changeSetScopeUncertainty(request);
      const status: ReviewVerdict["status"] = scopeUncertainty.length > 0
        && knowledgeReview.deterministicStatus !== "changes-requested"
        && knowledgeReview.deterministicStatus !== "invalid"
          ? "uncertain"
          : knowledgeReview.deterministicStatus;
      const changed = knowledgeReview.changedFiles.length;
      const summary = status === "approved"
        ? `Deterministic Project Knowledge checks support approval of ${String(changed)} changed file${changed === 1 ? "" : "s"}.`
        : status === "nothing-to-review"
          ? "There is no substantive diff to review; no implementation approval was issued."
          : status === "invalid"
            ? "The supplied diff is incomplete or invalid, so no implementation verdict was issued."
            : status === "uncertain"
              ? "A ChangeSet scope or Project Knowledge limitation prevents a complete implementation verdict."
            : `Deterministic Project Knowledge review found ${String(knowledgeReview.findings.filter((finding) => finding.severity === "blocking").length)} blocking issue${knowledgeReview.findings.filter((finding) => finding.severity === "blocking").length === 1 ? "" : "s"}.`;
      const occurredAt = new Date().toISOString();
      const trace: ReasoningTraceEvent[] = [
        { sequence: 1, type: "reasoning_started", occurredAt, iteration: 0, detail: "Started knowledge-first adaptive review" },
        { sequence: 2, type: "query_assessed", occurredAt, iteration: 0, detail: "Project Knowledge assessed the supplied diff", data: { changedFiles: changed, findings: knowledgeReview.findings.length } },
        { sequence: 3, type: "conductor_skipped", occurredAt, iteration: 0, role: "conductor", detail: "Deterministic diff assessment made orchestration unnecessary" },
        { sequence: 4, type: "deterministic_answer_completed", occurredAt, iteration: 0, detail: "Completed deterministic diff review", data: { findings: knowledgeReview.findings.length } },
        { sequence: 5, type: "reasoning_early_exit", occurredAt, iteration: 0, detail: "Project Knowledge was sufficient for a ReviewVerdict" },
        { sequence: 6, type: "verdict_completed", occurredAt, iteration: 0, detail: summary },
      ];
      for (const event of trace) this.#onTrace?.(event);
      options.onSnapshot?.({
        status: "complete",
        provisionalConclusion: summary,
        supportedClaims: [],
        rejectedClaims: [],
        uncertainClaims: [],
        evidence: knowledgeReview.evidence,
        remainingChecks: [],
      });
      const revisionHandoff = reviewRevisionHandoff(request.objective, knowledgeReview.findings, knowledgeReview.changedFiles);
      return {
        status,
        summary,
        ...(request.objective === undefined ? {} : { objective: request.objective }),
        ...(request.changeSet === undefined ? {} : { changeSet: {
          id: request.changeSet.id,
          source: request.changeSet.source,
          excludedSensitivePaths: request.changeSet.excludedSensitivePaths,
          limitations: request.changeSet.limitations,
        } }),
        findings: knowledgeReview.findings,
        confirmedProperties: knowledgeReview.confirmedProperties,
        uncertainty: [...knowledgeReview.uncertainty, ...scopeUncertainty],
        changedFiles: knowledgeReview.changedFiles,
        impact: knowledgeReview.impact,
        evidence: knowledgeReview.evidence,
        limitations: [...knowledgeReview.limitations, ...(request.changeSet?.limitations ?? [])],
        ...(revisionHandoff === undefined ? {} : { revisionHandoff }),
        trace,
        metrics: {
          modelCalls: 0,
          deterministicOperations: 1 + knowledgeReview.findings.length,
          approximateInputTokens: 0,
          approximateOutputTokens: 0,
          latencyMs: Math.max(0, performance.now() - started),
        },
        analysis: {
          route: "project-knowledge",
          requestedDepth,
          selectedDepth,
          assessment: knowledgeReview.assessment,
          plan,
          deterministic: true,
          reasonCodes: knowledgeReview.reasonCodes,
        },
      };
    }

    const question = adaptiveReviewQuestion(request, knowledgeReview.changedFiles, knowledgeReview.reasonCodes);
    const reasoning = await this.ask(question, "conclave", {
      depth: requestedDepth,
      intent: "review",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onSnapshot === undefined ? {} : { onSnapshot: options.onSnapshot }),
    });
    const evidence = dedupeEvidence([...knowledgeReview.evidence, ...reasoning.state.evidence]);
    const supported = reasoning.verdict.claims.supported.map((claim) => findingFromClaim(claim, "blocking", evidence));
    const uncertain = reasoning.verdict.claims.uncertain.map((claim) => findingFromClaim(claim, "warning", evidence));
    const findings = [...knowledgeReview.findings, ...supported, ...uncertain];
    const scopeUncertainty = changeSetScopeUncertainty(request);
    const status: ReviewVerdict["status"] = findings.some((finding) => finding.severity === "blocking")
      ? "changes-requested"
      : reasoning.terminationReason !== "completed" || uncertain.length > 0 || knowledgeReview.uncertainty.length > 0 || scopeUncertainty.length > 0
        ? "uncertain"
        : "approved";
    const revisionHandoff = reviewRevisionHandoff(request.objective, findings, knowledgeReview.changedFiles);
    return {
      status,
      summary: status === "approved"
        ? "Adaptive review found no evidence-grounded defect in the changed implementation."
        : status === "changes-requested"
          ? `Adaptive review found ${String(findings.filter((finding) => finding.severity === "blocking").length)} evidence-grounded blocking issue${findings.filter((finding) => finding.severity === "blocking").length === 1 ? "" : "s"}.`
          : "Adaptive review could not resolve every material risk from available repository evidence.",
      findings,
      ...(request.objective === undefined ? {} : { objective: request.objective }),
      ...(request.changeSet === undefined ? {} : { changeSet: {
        id: request.changeSet.id,
        source: request.changeSet.source,
        excludedSensitivePaths: request.changeSet.excludedSensitivePaths,
        limitations: request.changeSet.limitations,
      } }),
      confirmedProperties: knowledgeReview.confirmedProperties,
      uncertainty: [
        ...knowledgeReview.uncertainty,
        ...scopeUncertainty,
        ...reasoning.verdict.claims.uncertain.map((claim) => ({
          id: stableId("review-uncertainty", claim.id), statement: claim.statement, reason: "model" as const,
          paths: evidence.filter((item) => claim.evidenceIds.includes(item.id)).map((item) => item.path),
        })),
      ],
      changedFiles: knowledgeReview.changedFiles,
      impact: knowledgeReview.impact,
      evidence,
      limitations: [...knowledgeReview.limitations, ...(request.changeSet?.limitations ?? [])],
      ...(revisionHandoff === undefined ? {} : { revisionHandoff }),
      trace: reasoning.trace,
      metrics: {
        modelCalls: reasoning.metrics.modelCalls,
        deterministicOperations: reasoning.metrics.deterministicOperations + 1,
        approximateInputTokens: reasoning.metrics.approximateInputTokens,
        approximateOutputTokens: reasoning.metrics.approximateOutputTokens,
        latencyMs: Math.max(0, performance.now() - started),
      },
      analysis: {
        route: "adaptive-orchestration",
        requestedDepth: reasoning.analysis.requestedDepth,
        selectedDepth: reasoning.analysis.selectedDepth,
        assessment: reasoning.analysis.assessment,
        plan: reasoning.analysis.plan,
        deterministic: false,
        reasonCodes: [...knowledgeReview.reasonCodes, ...reasoning.analysis.plan.reasonCodes],
      },
    };
  }

  public async decide(
    request: DecisionRequest,
    options: DecisionRunOptions = {},
  ): Promise<DecisionVerdict> {
    const started = performance.now();
    if (options.signal?.aborted === true) throw options.signal.reason;
    const requestedDepth = options.depth ?? "auto";
    const proposal = request.proposal.trim();
    const knowledge = this.#retrieval.knowledge.inspectProposal(proposal);
    const selectedDepth = selectAnalysisDepth(requestedDepth, knowledge.assessment);
    const plan = deterministicReasoningPlan(knowledge.assessment, selectedDepth);
    const invalid = proposal === "" || knowledge.claims.length === 0;
    const direct = invalid || (knowledge.deterministicComplete && (requestedDepth === "auto" || requestedDepth === "fast"));
    if (direct) {
      const status: DecisionVerdict["status"] = invalid
        ? "invalid"
        : knowledge.claims.some((claim) => claim.status === "rejected") ? "revise" : "proceed";
      const summary = status === "invalid"
        ? "The proposal contains no explicit claim that can be validated."
        : status === "revise"
          ? "Deterministic Project Knowledge contradicts at least one proposal assumption."
          : "Deterministic Project Knowledge supports every explicit factual proposal claim.";
      const occurredAt = new Date().toISOString();
      const trace: ReasoningTraceEvent[] = [
        { sequence: 1, type: "reasoning_started", occurredAt, iteration: 0, detail: "Started validation-first decision analysis" },
        { sequence: 2, type: "query_assessed", occurredAt, iteration: 0, detail: `Decomposed ${String(knowledge.claims.length)} explicit proposal claims` },
        { sequence: 3, type: "conductor_skipped", occurredAt, iteration: 0, role: "conductor", detail: "Deterministic claim validation made model planning unnecessary" },
        { sequence: 4, type: "deterministic_answer_completed", occurredAt, iteration: 0, detail: summary },
        { sequence: 5, type: "verdict_completed", occurredAt, iteration: 0, detail: "DecisionVerdict completed" },
      ];
      for (const event of trace) this.#onTrace?.(event);
      return {
        status, summary, claims: knowledge.claims,
        confirmedProperties: knowledge.claims.filter((claim) => claim.status === "supported").map((claim) => claim.statement),
        challengedAssumptions: knowledge.claims.filter((claim) => claim.status === "rejected").map((claim) => claim.statement),
        uncertainty: knowledge.claims.filter((claim) => claim.status === "uncertain").map((claim) => claim.statement),
        evidence: knowledge.evidence,
        ...(status === "proceed" ? { implementationHandoff: decisionImplementationHandoff(request, knowledge.claims, knowledge.evidence) } : {}),
        ...(status === "revise" ? { revisionHandoff: decisionRevisionHandoff(request, knowledge.claims) } : {}),
        trace,
        metrics: {
          modelCalls: 0, deterministicOperations: Math.max(1, knowledge.claims.length),
          approximateInputTokens: 0, approximateOutputTokens: 0, latencyMs: Math.max(0, performance.now() - started),
        },
        analysis: { requestedDepth, selectedDepth, assessment: knowledge.assessment, plan, deterministic: true },
      };
    }

    const reasoning = await this.ask(adaptiveDecisionQuestion(request, knowledge.claims, knowledge.reasonCodes), "conclave", {
      depth: requestedDepth, intent: "decide", ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const reasoningClaims = [
      ...reasoning.verdict.claims.supported.map((claim) => ({ claim, status: "supported" as const })),
      ...reasoning.verdict.claims.rejected.map((claim) => ({ claim, status: "rejected" as const })),
      ...reasoning.verdict.claims.uncertain.map((claim) => ({ claim, status: "uncertain" as const })),
    ];
    const matchedReasoning = new Set<string>();
    const claims: DecisionClaim[] = knowledge.claims.map((claim) => {
      if (claim.deterministic) return claim;
      const normalized = normalizedClaim(claim.statement);
      const match = reasoningClaims.find((candidate) => {
        const other = normalizedClaim(candidate.claim.statement);
        return other === normalized || (normalized.length >= 12 && (other.includes(normalized) || normalized.includes(other)));
      });
      if (match === undefined) return claim;
      matchedReasoning.add(match.claim.id);
      return {
        ...claim,
        status: match.status,
        evidenceIds: match.claim.evidenceIds,
        explanation: match.status === "supported"
          ? "Adaptive reasoning and deterministic verification support this proposal claim."
          : match.status === "rejected"
            ? "Adaptive challenge and repository verification contradict this proposal claim."
            : "Repository evidence does not resolve this proposal claim.",
        deterministic: false,
      };
    });
    for (const candidate of reasoningClaims.filter((item) => !matchedReasoning.has(item.claim.id) && item.status !== "rejected")) {
      claims.push({
        id: stableId("decision-claim", candidate.claim.id), statement: candidate.claim.statement, kind: "assumption",
        status: candidate.status, evidenceIds: candidate.claim.evidenceIds,
        explanation: candidate.status === "supported" ? "Evidence-grounded validation supports this derived claim."
          : candidate.status === "rejected" ? "Repository verification rejects this derived assumption."
            : "This derived consequence remains uncertain.",
        deterministic: candidate.claim.verificationIds.some((id) => reasoning.state.verifications.find((verification) => verification.id === id)?.deterministic === true),
      });
    }
    const status: DecisionVerdict["status"] = claims.some((claim) => claim.status === "rejected")
      ? "revise"
      : reasoning.terminationReason !== "completed" || claims.some((claim) => claim.status === "uncertain")
        ? "uncertain" : "proceed";
    const evidence = dedupeEvidence([...knowledge.evidence, ...reasoning.verdict.evidence]);
    return {
      status,
      summary: status === "proceed" ? "The proposal is consistent with verified repository evidence and can proceed to bounded implementation."
        : status === "revise" ? "The proposal relies on a contradicted repository assumption and should be revised before implementation."
          : "Material proposal consequences remain uncertain and need a sharper claim or runtime validation plan.",
      claims,
      confirmedProperties: claims.filter((claim) => claim.status === "supported").map((claim) => claim.statement),
      challengedAssumptions: claims.filter((claim) => claim.status === "rejected").map((claim) => claim.statement),
      uncertainty: claims.filter((claim) => claim.status === "uncertain").map((claim) => claim.statement),
      evidence,
      ...(status === "proceed" ? { implementationHandoff: decisionImplementationHandoff(request, claims, evidence) } : {}),
      ...(status !== "proceed" ? { revisionHandoff: decisionRevisionHandoff(request, claims) } : {}),
      trace: reasoning.trace,
      metrics: {
        modelCalls: reasoning.metrics.modelCalls,
        deterministicOperations: reasoning.metrics.deterministicOperations + knowledge.claims.filter((claim) => claim.deterministic).length,
        approximateInputTokens: reasoning.metrics.approximateInputTokens,
        approximateOutputTokens: reasoning.metrics.approximateOutputTokens,
        latencyMs: Math.max(0, performance.now() - started),
      },
      analysis: {
        requestedDepth: reasoning.analysis.requestedDepth, selectedDepth: reasoning.analysis.selectedDepth,
        assessment: reasoning.analysis.assessment, plan: reasoning.analysis.plan, deterministic: false,
      },
    };
  }

  public async ask(
    question: string,
    mode: ReasoningMode = "conclave",
    options: AnalysisRunOptions = {},
  ): Promise<ReasoningResult> {
    const started = performance.now();
    const requestedDepth = options.depth ?? "auto";
    const assessment = this.#retrieval.knowledge.assess(question, options.intent ?? "ask");
    const selectedDepth = mode === "full-style"
      ? "deep"
      : selectAnalysisDepth(requestedDepth, assessment);
    const depthBudget = budgetForDepth(selectedDepth, this.#limits);
    const limits = mode === "full-style" ? this.#limits : depthBudget.limits;
    const plannedDepth = mode === "full-style" ? "balanced" : selectedDepth;
    const basePlan = deterministicReasoningPlan(assessment, plannedDepth);
    let plan = mode === "full-style"
      ? {
          ...basePlan,
          depth: selectedDepth,
          reasonCodes: ["depth:deep", "route:full-style", ...basePlan.reasonCodes.filter((code) => !code.startsWith("depth:"))],
        }
      : basePlan;
    const direct = this.#retrieval.knowledge.answer(question);
    if (
      direct !== undefined &&
      mode !== "single-pass" &&
      mode !== "full-style" &&
      (requestedDepth === "auto" || requestedDepth === "fast")
    ) {
      return deterministicReasoningResult({
        question,
        answer: direct,
        assessment,
        requestedDepth,
        selectedDepth,
        plan,
        timeoutMs: depthBudget.providerTimeoutMs,
        retrieval: this.#retrieval,
        started,
        ...(this.#onTrace === undefined ? {} : { onTrace: this.#onTrace }),
        ...(options.onSnapshot === undefined ? {} : { onSnapshot: options.onSnapshot }),
      });
    }
    const trace: ReasoningTraceEvent[] = [];
    const calls: AgentCallRecord[] = [];
    const agentsExecuted = new Set<AgentRole>();
    let iteration = 0;
    let terminationReason: ReasoningResult["terminationReason"] = "completed";
    const executionState = { agentFailed: false, conductorFailed: false };
    let conductorInvoked = false;
    let conductorReason = "Skipped because deterministic routing was unambiguous.";
    let earlyExitReason: string | undefined;
    const emit = (
      type: ReasoningTraceEventType,
      detail: string,
      fields: Partial<Pick<ReasoningTraceEvent, "role" | "claimId" | "requestId" | "data">> = {},
    ): void => {
      const event: ReasoningTraceEvent = {
        sequence: trace.length + 1,
        type,
        occurredAt: new Date().toISOString(),
        iteration,
        detail,
        ...fields,
      };
      trace.push(event);
      this.#onTrace?.(event);
    };
    emit("reasoning_started", `Started ${mode} knowledge-first reasoning`);
    emit("query_assessed", `Classified ${assessment.queryKind} with ${assessment.deterministicCoverage} deterministic coverage`, {
      data: {
        resolvedEntities: assessment.resolvedEntities.length,
        relevantFiles: assessment.relevantFiles.length,
        crossModule: assessment.crossModule,
      },
    });

    if (signalAborted(options.signal)) {
      throw options.signal?.reason;
    }

    emit("initial_retrieval_started", "Retrieving bounded repository evidence");
    const initialRetrieval = await this.#retrieval.retrieve(question, {
      budget: {
        graphDepth: 2,
        graphNodes: Math.min(30, limits.maxEvidenceUnits * 2),
        retrievalCandidates: Math.max(20, limits.maxEvidenceUnits * 2),
        finalEvidence: Math.min(10, limits.maxEvidenceUnits),
        sourceBytes: 24_000,
        approximateTokens: Math.min(6_000, limits.maxApproximateInputTokens),
      },
    });
    if (signalAborted(options.signal)) throw options.signal?.reason;
    emit("initial_retrieval_completed", "Selected initial repository evidence", {
      data: { evidence: initialRetrieval.results.length, graphEdges: initialRetrieval.graphEdges.length },
    });
    const initialContext = this.#retrieval.packContext(initialRetrieval);
    emit("context_packed", "Packed bounded context for selected roles", {
      data: { evidence: initialContext.evidence.length, approximateTokens: initialContext.stats.approximateTokens },
    });
    let evidence = dedupeEvidence(initialRetrieval.results.map((result) => result.evidence));
    let graphEdges = [...initialRetrieval.graphEdges];
    let claims: Claim[] = [];
    const challenges: Challenge[] = [];
    const verifications: VerificationResult[] = [];
    const retrievalRequests: ReasoningRetrievalRequest[] = [];
    const retrievalResults: FollowUpRetrievalResult[] = [];

    const publishSnapshot = (
      status: AnalysisSnapshot["status"],
      remainingChecks: readonly string[],
      provisionalConclusion?: string,
    ): AnalysisSnapshot => {
      const snapshot: AnalysisSnapshot = {
        status,
        ...(provisionalConclusion === undefined ? {} : { provisionalConclusion }),
        supportedClaims: claims.filter((claim) => claim.status === "supported"),
        rejectedClaims: claims.filter((claim) => claim.status === "rejected"),
        uncertainClaims: claims.filter((claim) => claim.status === "uncertain" || claim.status === "proposed" || claim.status === "challenged"),
        evidence,
        remainingChecks,
      };
      options.onSnapshot?.(snapshot);
      emit("snapshot_emitted", `Published ${status} evidence snapshot`, {
        data: {
          supported: snapshot.supportedClaims.length,
          rejected: snapshot.rejectedClaims.length,
          uncertain: snapshot.uncertainClaims.length,
          remainingChecks: remainingChecks.length,
        },
      });
      return snapshot;
    };

    const executeAgent = async <T>(
      role: AgentRole,
      prompt: string,
      validate: (raw: string) => T,
      optional = false,
    ): Promise<T | undefined> => {
      if (signalAborted(options.signal)) {
        terminationReason = "cancelled";
        emit("reasoning_cancelled", `Cancelled before ${role}`, { role });
        return undefined;
      }
      const remainingCalls = limits.maxAgentCalls - calls.length;
      const estimatedInput = approximateTokenCount(Buffer.byteLength(prompt));
      const usedInput = calls.reduce((total, call) => total + call.approximateInputTokens, 0);
      if (remainingCalls < 1 || usedInput + estimatedInput > limits.maxApproximateInputTokens) {
        terminationReason = "budget-exhausted";
        emit("reasoning_budget_exhausted", `Skipped ${role}: reasoning budget exhausted`, { role });
        return undefined;
      }
      agentsExecuted.add(role);
      emit("agent_started", `Started ${role}`, { role });
      try {
        const execution = await this.#runtime.execute(role, prompt, validate, remainingCalls, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs: depthBudget.providerTimeoutMs,
          ...(plan.modelRequirements[role] === undefined ? {} : { requirement: plan.modelRequirements[role] }),
          previousModels: calls.map((call) => `${call.providerId}:${call.modelId}`),
        });
        calls.push(...execution.calls);
        for (const call of execution.calls) {
          emit("model_selected", `${role} used ${call.providerId}/${call.modelId}: ${call.selectionReason}`, {
            role,
            data: { fallback: call.fallback, latencyMs: call.latencyMs },
          });
        }
        for (const call of execution.calls.filter((record) => record.repaired)) {
          emit("agent_output_repair_requested", `${role} structured output was repaired`, {
            role,
            data: { latencyMs: call.latencyMs },
          });
        }
        emit("agent_completed", `Completed ${role}`, {
          role,
          data: { calls: execution.calls.length },
        });
        return execution.output;
      } catch (error) {
        if (error instanceof AgentExecutionError) calls.push(...error.calls);
        const message = error instanceof Error ? error.message : `${role} failed`;
        if (signalAborted(options.signal)) {
          terminationReason = "cancelled";
          emit("reasoning_cancelled", "User cancelled the active analysis", { role });
        } else if (/timeout|timed out/i.test(message)) {
          terminationReason = "timed-out";
          emit("reasoning_timed_out", `${role} exceeded the ${selectedDepth} timeout policy`, { role });
        } else if (role === "conductor") {
          executionState.conductorFailed = true;
        } else if (!optional) {
          executionState.agentFailed = true;
        }
        emit("agent_completed", message, { role });
        return undefined;
      }
    };

    const conductorNeeded = mode === "conclave" && shouldInvokeConductor(assessment, selectedDepth);
    if (conductorNeeded && this.#runtime.hasAssignment("conductor")) {
      conductorInvoked = true;
      conductorReason = "Invoked because deterministic routing found a high-ambiguity reasoning case.";
      emit("conductor_started", conductorReason, { role: "conductor" });
      const conductor = await executeAgent(
        "conductor",
        conductorPrompt(question, assessment, selectedDepth, limits, true),
        (raw) => parseConductorOutput(raw, selectedDepth, limits),
        true,
      );
      if (conductor !== undefined) {
        plan = conductor;
        emit("conductor_completed", `Conductor selected ${conductor.strategy}`, {
          role: "conductor",
          data: { roles: conductor.roles.length },
        });
      } else {
        conductorReason = "Conductor was unavailable or invalid; host deterministic routing supplied the bounded fallback plan.";
        emit("conductor_completed", conductorReason, { role: "conductor" });
      }
    } else {
      conductorReason = conductorNeeded
        ? "Skipped because no Conductor assignment is configured; deterministic routing supplied the plan."
        : "Skipped because deterministic routing was sufficiently clear.";
      emit("conductor_skipped", conductorReason, { role: "conductor" });
    }

    emit("agent_selected", "Investigator is required for evidence decomposition", {
      role: "investigator",
    });
    const initialEvidenceIds = new Set(
      initialContext.evidence.flatMap((item) => item.sourceEvidenceIds),
    );
    const investigator = await executeAgent(
      "investigator",
      investigatorPrompt(question, initialContext),
      (raw) => parseInvestigatorOutput(raw, initialEvidenceIds),
    );
    if (investigator !== undefined) {
      claims = investigator.claims.map((claim, index) => {
        const id = stableId("claim", question, index, claim.statement);
        emit("claim_proposed", claim.statement, { claimId: id, role: "investigator" });
        return {
          id,
          statement: claim.statement,
          evidenceIds: claim.evidenceIds,
          challengeIds: [],
          verificationIds: [],
          status: "proposed",
          uncertainty: claim.uncertainty,
          ...(claim.check === undefined ? {} : { check: claim.check }),
          origin: { role: "investigator", iteration },
        };
      });
    }
    publishSnapshot(
      terminationIs(terminationReason, "cancelled") ? "cancelled" : terminationIs(terminationReason, "timed-out") ? "timed-out" : "working",
      claims.length === 0 ? ["form at least one evidence-grounded claim"] : ["challenge material alternatives", "verify claims against repository structure"],
      investigator?.summary,
    );

    let selections = [
      {
        role: "conductor" as const,
        selected: conductorInvoked,
        reason: conductorReason,
      },
      ...routeReasoningAgents(this.#preset, question, initialContext, claims, selectedDepth, plan),
    ].map(
      (selection) => {
        const baselineSelected =
          selection.role === "investigator" ||
          (mode === "investigator-judge" && selection.role === "judge");
        const selected =
          selection.role === "conductor"
            ? conductorInvoked
            : claims.length > 0 || selection.role === "investigator"
            ? mode === "conclave" || mode === "full-style"
              ? selection.selected
              : baselineSelected
            : false;
        return selected
          ? selection
          : {
              ...selection,
              selected: false,
              reason:
                claims.length === 0 && selection.role !== "investigator"
                  ? "no valid investigator claims are available"
                  : selection.role === "conductor"
                    ? conductorReason
                    : `${mode} baseline excludes ${selection.role}`,
            };
      },
    );
    for (const selection of selections.filter((item) => item.role !== "investigator" && item.role !== "conductor" && (item.role !== "judge" || mode !== "conclave"))) {
      emit(selection.selected ? "agent_selected" : "agent_skipped", selection.reason, {
        role: selection.role,
      });
    }

    if (mode === "single-pass") {
      claims = claims.map((claim) => ({ ...claim, status: "supported" }));
    }

    const requestCounts = new Map<string, number>();
    const requestByKey = new Map<string, ReasoningRetrievalRequest>();
    const enqueue = (
      request: RetrievalRequest,
      requestedBy: AgentRole,
      claimId?: string,
      challengeId?: string,
    ): string | undefined => {
      const key = retrievalRequestKey(request);
      const count = requestCounts.get(key) ?? 0;
      if (
        retrievalRequests.length >= limits.maxFollowUpRequests ||
        count >= limits.maxRepeatedRequestCount
      ) {
        emit("reasoning_no_progress", `Ignored repeated or over-budget retrieval request: ${key}`, {
          role: requestedBy,
          ...(claimId === undefined ? {} : { claimId }),
        });
        return requestByKey.get(key)?.id;
      }
      const id = stableId("request", question, iteration, retrievalRequests.length, key);
      const record: ReasoningRetrievalRequest = {
        id,
        request,
        requestedBy,
        ...(claimId === undefined ? {} : { claimId }),
        ...(challengeId === undefined ? {} : { challengeId }),
        iteration,
      };
      requestCounts.set(key, count + 1);
      requestByKey.set(key, record);
      retrievalRequests.push(record);
      emit("retrieval_requested", key, { role: requestedBy, requestId: id, ...(claimId === undefined ? {} : { claimId }) });
      return id;
    };

    if ((mode === "conclave" || mode === "full-style") && investigator !== undefined && !terminationIs(terminationReason, "cancelled")) {
      for (const request of investigator.retrievalRequests) enqueue(request, "investigator");
      for (const claim of claims) {
        if (claim.check !== undefined) enqueue(requestForClaimCheck(claim.check), "verifier", claim.id);
      }
    }

    const addChallenges = (outputs: readonly ChallengeOutput[], role: "skeptic" | "architect"): void => {
      for (const output of outputs) {
        const id = stableId("challenge", question, role, challenges.length, output.claimId, output.explanation);
        const requestIds = output.retrievalRequests
          .map((request) => enqueue(request, role, output.claimId, id))
          .filter((requestId): requestId is string => requestId !== undefined);
        challenges.push({
          id,
          claimId: output.claimId,
          type: output.type,
          explanation: output.explanation,
          retrievalRequestIds: [...new Set(requestIds)],
          origin: { role, iteration },
        });
        claims = claims.map((claim) =>
          claim.id === output.claimId
            ? { ...claim, status: "challenged", challengeIds: [...claim.challengeIds, id] }
            : claim,
        );
        emit("claim_challenged", output.explanation, { role, claimId: output.claimId });
      }
    };

    const claimIds = new Set(claims.map((claim) => claim.id));
    const adaptiveWorkflow = mode === "conclave" || mode === "full-style";
    if (adaptiveWorkflow && !terminationIs(terminationReason, "cancelled") && selections.find((item) => item.role === "skeptic")?.selected === true) {
      const output = await executeAgent("skeptic", skepticPrompt(question, claims, initialContext), (raw) =>
        parseSkepticOutput(raw, claimIds),
      true);
      if (output !== undefined) addChallenges(output.challenges, "skeptic");
    }
    if (adaptiveWorkflow && !terminationIs(terminationReason, "cancelled") && selections.find((item) => item.role === "architect")?.selected === true) {
      const output = await executeAgent("architect", architectPrompt(question, claims, initialContext), (raw) =>
        parseArchitectOutput(raw, claimIds),
      true);
      if (output !== undefined) {
        addChallenges(output.challenges, "architect");
        for (const requested of output.retrievalRequests) {
          enqueue(requested.request, "architect", requested.claimId);
        }
      }
    }

    if (adaptiveWorkflow && !terminationIs(terminationReason, "cancelled") && retrievalRequests.length > 0) {
      iteration += 1;
      const executor = new FollowUpRetrievalExecutor(
        this.#retrieval,
        limits.maxEvidenceUnits,
        initialRetrieval.budget.graphDepth + 2,
      );
      for (const request of retrievalRequests) {
        if (iteration > limits.maxRounds) {
          terminationReason = "budget-exhausted";
          emit("reasoning_budget_exhausted", "Maximum retrieval rounds reached");
          break;
        }
        if (signalAborted(options.signal)) {
          terminationReason = "cancelled";
          emit("reasoning_cancelled", "Cancelled during follow-up repository retrieval", { requestId: request.id });
          break;
        }
        const result = await executor.execute(request, options.signal);
        retrievalResults.push(result);
        emit("retrieval_completed", `Completed ${retrievalRequestKey(request.request)}`, {
          role: request.requestedBy,
          requestId: request.id,
          data: { evidence: result.evidence.length, graphEdges: result.graphEdges.length },
        });
      }
      evidence = dedupeEvidence([...evidence, ...retrievalResults.flatMap((result) => result.evidence)]).slice(
        0,
        limits.maxEvidenceUnits,
      );
      graphEdges = [...new Map([...graphEdges, ...retrievalResults.flatMap((result) => result.graphEdges)].map((edge) => [edge.id, edge])).values()];
      claims = claims.map((claim) => {
        const followUpEvidenceIds = retrievalRequests
          .filter((request) => request.claimId === claim.id)
          .flatMap(
            (request) =>
              retrievalResults.find((result) => result.requestId === request.id)?.evidence.map((item) => item.id) ?? [],
          );
        return { ...claim, evidenceIds: [...new Set([...claim.evidenceIds, ...followUpEvidenceIds])] };
      });
    }

    const resultByRequestId = new Map(retrievalResults.map((result) => [result.requestId, result]));
    if (adaptiveWorkflow && !terminationIs(terminationReason, "cancelled")) {
      agentsExecuted.add("verifier");
      emit("verification_started", "Started deterministic verification", { role: "verifier" });
      const verifier = new DeterministicClaimVerifier();
      for (const claim of claims) {
        if (claim.check === undefined) continue;
        const request = requestByKey.get(retrievalRequestKey(requestForClaimCheck(claim.check)));
        const result = request === undefined ? undefined : resultByRequestId.get(request.id);
        if (result === undefined) continue;
        const verification = verifier.verifyCheck(claim, result, iteration);
        if (verification !== undefined) verifications.push(verification);
      }
      for (const challenge of challenges) {
        const claim = claims.find((item) => item.id === challenge.claimId);
        if (claim === undefined) continue;
        for (const requestId of challenge.retrievalRequestIds) {
          const result = resultByRequestId.get(requestId);
          if (result === undefined) continue;
          const verification = verifier.verifyChallenge(claim, challenge, result, iteration);
          if (verification !== undefined) verifications.push(verification);
        }
      }

      const deterministicallyResolved = new Set(
        verifications.filter((verification) => verification.deterministic).map((verification) => verification.claimId),
      );
      const unresolvedClaims = claims.filter((claim) => !deterministicallyResolved.has(claim.id));
      if (unresolvedClaims.length > 0) {
        const packedResults: RetrievalResult[] = evidence.map((item, index) => ({
          evidence: item,
          rank: index + 1,
          score: 1 / (index + 1),
          signals: {},
          reasons: [{ strategy: "graph", detail: "reasoning evidence" }],
        }));
        const context = this.#retrieval.packResults(packedResults, graphEdges, initialRetrieval.budget);
        const allEvidenceIds = new Set(evidence.map((item) => item.id));
        const edgeIds = new Set(graphEdges.map((edge) => edge.id));
        const output = await executeAgent(
          "verifier",
          verifierPrompt(question, unresolvedClaims, challenges, verifications, context),
          (raw) => parseVerifierOutput(raw, new Set(unresolvedClaims.map((claim) => claim.id)), allEvidenceIds, edgeIds),
          true,
        );
        if (output !== undefined) {
          for (const decision of output.decisions) {
            verifications.push({
              id: stableId("verification", decision.claimId, iteration, decision.outcome, decision.explanation),
              claimId: decision.claimId,
              outcome: decision.outcome,
              method: decision.method,
              explanation: decision.explanation,
              evidenceIds: decision.evidenceIds,
              graphEdgeIds: decision.graphEdgeIds,
              deterministic: false,
              iteration,
            });
          }
        }
      } else {
        emit("agent_completed", "Verifier completed using deterministic operations", { role: "verifier" });
      }
    }

    let judgeStatuses = new Map<string, VerificationOutcome>();
    const sufficiency = evaluateReasoningSufficiency(claims, verifications, 0);
    const unresolvedAfterVerification = claims.filter((claim) => {
      const relevant = verifications.filter((verification) => verification.claimId === claim.id);
      return !relevant.some((verification) => verification.outcome !== "uncertain");
    });
    const conflictingVerification = claims.some((claim) => {
      const outcomes = new Set(verifications.filter((verification) => verification.claimId === claim.id).map((verification) => verification.outcome));
      return outcomes.has("supported") && outcomes.has("rejected");
    });
    const meaningfulDisagreement = conflictingVerification ||
      challenges.length > 0 ||
      unresolvedAfterVerification.length > 1;
    const judgeSelected = claims.length > 0 && !terminationIs(terminationReason, "cancelled") && (
      mode === "investigator-judge" ||
      mode === "full-style" ||
      (mode === "conclave" && (selectedDepth === "deep" || meaningfulDisagreement))
    );
    selections = selections.map((selection) => selection.role === "judge"
      ? {
          ...selection,
          selected: judgeSelected,
          reason: judgeSelected
            ? selectedDepth === "deep" ? "Deep analysis requests independent final adjudication" : "unresolved competing claims require adjudication"
            : sufficiency.sufficient
              ? sufficiency.reason
              : "verified claims do not contain a material disagreement",
        }
      : selection);
    if (mode === "conclave" || mode === "full-style") {
      const selection = selections.find((item) => item.role === "judge");
      if (selection !== undefined) emit(selection.selected ? "agent_selected" : "agent_skipped", selection.reason, { role: "judge" });
    }
    if (!judgeSelected && sufficiency.sufficient) {
      earlyExitReason = sufficiency.reason;
      emit("reasoning_early_exit", earlyExitReason);
      publishSnapshot("sufficient", [], synthesizeAnswer(claims, evidence));
    }
    if (judgeSelected) {
      emit("judge_started", "Started final adjudication", { role: "judge" });
      const output = await executeAgent("judge", judgePrompt(question, claims, challenges, verifications, evidence), (raw) =>
        parseJudgeOutput(raw, claimIds),
      mode === "conclave");
      if (output !== undefined) judgeStatuses = new Map(output.decisions.map((decision) => [decision.claimId, decision.status]));
    }

    if (mode !== "single-pass") {
      claims = claims.map((claim) => {
        const relevant = verifications.filter((verification) => verification.claimId === claim.id);
        const status = outcomeFor(
          claim.id,
          verifications,
          judgeStatuses.get(claim.id),
          mode === "investigator-judge",
        );
        emit(`claim_${status}` as ReasoningTraceEventType, `${claim.statement}: ${status}`, { claimId: claim.id });
        return {
          ...claim,
          status,
          evidenceIds: [...new Set([...claim.evidenceIds, ...relevant.flatMap((verification) => verification.evidenceIds)])],
          verificationIds: relevant.map((verification) => verification.id),
        };
      });
    }

    const verdictEvidenceIds = new Set(
      claims.filter((claim) => claim.status !== "rejected").flatMap((claim) => claim.evidenceIds),
    );
    const verdictEvidence = evidence.filter((item) => verdictEvidenceIds.has(item.id));
    const verdict: Verdict = {
      answer: synthesizeAnswer(claims, verdictEvidence),
      claims: {
        supported: claims.filter((claim) => claim.status === "supported"),
        rejected: claims.filter((claim) => claim.status === "rejected"),
        uncertain: claims.filter((claim) => claim.status === "uncertain"),
      },
      evidence: verdictEvidence,
      traceSummary: {
        agentsExecuted: [...agentsExecuted],
        agentsSkipped: selections.filter((selection) => !selection.selected),
        retrievalRounds: retrievalResults.length > 0 ? iteration : 0,
        modelCalls: calls.length,
      },
    };
    const finalSnapshot = publishSnapshot(
      terminationIs(terminationReason, "cancelled")
        ? "cancelled"
        : terminationIs(terminationReason, "timed-out")
          ? "timed-out"
          : "complete",
      sufficiency.sufficient ? [] : sufficiency.unresolvedClaimIds.map((id) => `resolve material claim ${id}`),
      verdict.answer,
    );
    emit("verdict_completed", "Completed evidence-grounded verdict", {
      data: {
        supported: verdict.claims.supported.length,
        rejected: verdict.claims.rejected.length,
        uncertain: verdict.claims.uncertain.length,
      },
    });
    if (executionState.agentFailed && terminationReason === "completed") terminationReason = "agent-failure";

    const usage = roleUsage(calls);
    const metrics: ReasoningMetrics = {
      modelCalls: calls.length,
      retrievalRounds: verdict.traceSummary.retrievalRounds,
      followUpRequests: retrievalRequests.length,
      deterministicOperations: retrievalResults.reduce(
        (total, result) => total + result.deterministicOperations.length,
        initialRetrieval.plan.operations.filter((operation) => operation.status === "executed").length,
      ),
      evidenceCount: evidence.length,
      approximateInputTokens: usage.reduce((total, item) => total + item.approximateInputTokens, 0),
      approximateOutputTokens: usage.reduce((total, item) => total + item.approximateOutputTokens, 0),
      providerReportedInputTokens: usage.reduce((total, item) => total + item.providerReportedInputTokens, 0),
      providerReportedOutputTokens: usage.reduce((total, item) => total + item.providerReportedOutputTokens, 0),
      latencyMs: Math.max(0, performance.now() - started),
      roleUsage: usage,
      finalClaims: {
        supported: verdict.claims.supported.length,
        rejected: verdict.claims.rejected.length,
        uncertain: verdict.claims.uncertain.length,
      },
      deterministicAnswer: false,
      conductorInvoked,
      earlyExit: earlyExitReason !== undefined,
    };
    const state: ReasoningCaseState = {
      question,
      iteration,
      initialRetrieval,
      initialContext,
      claims,
      challenges,
      verifications,
      retrievalRequests,
      retrievalResults,
      evidence,
      graphEdges,
      selections,
    };
    const baseReview = reviewRecommendation(assessment, claims, new Set(evidence.map((item) => item.path)).size);
    const review: ReviewRecommendation = baseReview.recommended
      ? {
          ...baseReview,
          handoff: createReviewHandoff(question, verdict.answer, claims, evidence, graphEdges),
        }
      : baseReview;
    return {
      verdict,
      state,
      trace,
      metrics,
      analysis: {
        requestedDepth,
        selectedDepth,
        assessment,
        plan,
        conductorInvoked,
        conductorReason,
        timeoutMs: depthBudget.providerTimeoutMs,
        deterministicAnswer: false,
        ...(earlyExitReason === undefined ? {} : { earlyExitReason }),
        finalSnapshot,
        review,
      },
      terminationReason,
    };
  }
}

import { createHash } from "node:crypto";

import type {
  AnalysisDepth,
  AnalysisSnapshot,
  QueryAssessment,
  ReasoningPlan,
  SelectedAnalysisDepth,
} from "../domain/adaptive-reasoning.js";
import type { Claim, ReasoningResult, ReasoningTraceEvent, RoleUsage, VerificationResult } from "../domain/reasoning.js";
import type { DeterministicAnswer } from "../knowledge/project-knowledge.js";
import type { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";

function id(prefix: string, question: string): string {
  return `${prefix}_${createHash("sha256").update(question).digest("hex").slice(0, 24)}`;
}

function emptyUsage(role: RoleUsage["role"]): RoleUsage {
  return {
    role,
    providerIds: [], modelIds: [], calls: 0,
    approximateInputTokens: 0, approximateOutputTokens: 0,
    providerReportedInputTokens: 0, providerReportedOutputTokens: 0,
    latencyMs: 0,
  };
}

export function deterministicReasoningResult(options: {
  readonly question: string;
  readonly answer: DeterministicAnswer;
  readonly assessment: QueryAssessment;
  readonly requestedDepth: AnalysisDepth;
  readonly selectedDepth: SelectedAnalysisDepth;
  readonly plan: ReasoningPlan;
  readonly timeoutMs: number;
  readonly retrieval: CodeRetrievalService;
  readonly started: number;
  readonly onTrace?: (event: ReasoningTraceEvent) => void;
  readonly onSnapshot?: (snapshot: AnalysisSnapshot) => void;
}): ReasoningResult {
  const results = options.retrieval.knowledge.asRetrievalResults(options.answer);
  const initialRetrieval = {
    query: options.question,
    plan: {
      operations: options.answer.operations.map((kind) => ({ kind, status: "executed" as const, reason: "Project Knowledge direct query", resultCount: options.answer.evidence.length })),
      reasons: ["deterministic project knowledge fully resolved the requested lookup"],
      deterministicEvidenceSufficient: true,
    },
    results,
    graphEdges: options.answer.graphEdges,
    budget: {
      graphDepth: 2, graphNodes: 30, retrievalCandidates: 30,
      finalEvidence: 20, sourceBytes: 24_000, approximateTokens: 6_000,
    },
  };
  const context = options.retrieval.packContext(initialRetrieval);
  const claimId = id("claim", options.question);
  const verificationId = id("verification", options.question);
  const claim: Claim = {
    id: claimId,
    statement: options.answer.answer,
    evidenceIds: options.answer.evidence.map((item) => item.id),
    challengeIds: [],
    verificationIds: [verificationId],
    status: "supported",
    uncertainty: "none",
    origin: { role: "verifier", iteration: 0 },
  };
  const verification: VerificationResult = {
    id: verificationId,
    claimId,
    outcome: "supported",
    method: options.answer.graphEdges.length > 0 ? "graph" : "symbol",
    explanation: "Resolved directly from bounded deterministic Project Knowledge.",
    evidenceIds: claim.evidenceIds,
    graphEdgeIds: options.answer.graphEdges.map((edge) => edge.id),
    deterministic: true,
    iteration: 0,
  };
  const roles = ["conductor", "investigator", "skeptic", "architect", "verifier", "judge"] as const;
  const selections = roles.map((role) => ({
    role,
    selected: false,
    reason: role === "conductor"
      ? "deterministic pre-router produced a complete route"
      : "Project Knowledge was sufficient; no model role was necessary",
  }));
  const occurredAt = new Date().toISOString();
  const trace: ReasoningTraceEvent[] = [
    { sequence: 1, type: "reasoning_started", occurredAt, iteration: 0, detail: "Started knowledge-first reasoning" },
    { sequence: 2, type: "query_assessed", occurredAt, iteration: 0, detail: `Classified ${options.assessment.queryKind} with strong deterministic coverage` },
    { sequence: 3, type: "conductor_skipped", occurredAt, iteration: 0, role: "conductor", detail: "Obvious deterministic route; Conductor was unnecessary" },
    { sequence: 4, type: "deterministic_answer_completed", occurredAt, iteration: 0, detail: "Answered from indexed symbols and deterministic graph provenance", data: { operations: options.answer.operations.length, evidence: options.answer.evidence.length } },
    { sequence: 5, type: "reasoning_early_exit", occurredAt, iteration: 0, detail: "Project Knowledge fully resolved the requested relationship" },
    { sequence: 6, type: "verdict_completed", occurredAt, iteration: 0, detail: "Completed deterministic evidence-grounded answer", data: { supported: 1, rejected: 0, uncertain: 0 } },
  ];
  for (const event of trace) options.onTrace?.(event);
  const snapshot: AnalysisSnapshot = {
    status: "complete",
    provisionalConclusion: options.answer.answer,
    supportedClaims: [claim], rejectedClaims: [], uncertainClaims: [],
    evidence: options.answer.evidence,
    remainingChecks: [],
  };
  options.onSnapshot?.(snapshot);
  const latencyMs = Math.max(0, performance.now() - options.started);
  return {
    verdict: {
      answer: [options.answer.answer, ...options.answer.limitations.map((item) => `Static-analysis limit: ${item}`)].join("\n\n"),
      claims: { supported: [claim], rejected: [], uncertain: [] },
      evidence: options.answer.evidence,
      traceSummary: { agentsExecuted: [], agentsSkipped: selections, retrievalRounds: 0, modelCalls: 0 },
    },
    state: {
      question: options.question,
      iteration: 0,
      initialRetrieval,
      initialContext: context,
      claims: [claim], challenges: [], verifications: [verification],
      retrievalRequests: [], retrievalResults: [],
      evidence: options.answer.evidence, graphEdges: options.answer.graphEdges, selections,
    },
    trace,
    metrics: {
      modelCalls: 0, retrievalRounds: 0, followUpRequests: 0,
      deterministicOperations: options.answer.operations.length,
      evidenceCount: options.answer.evidence.length,
      approximateInputTokens: 0, approximateOutputTokens: 0,
      providerReportedInputTokens: 0, providerReportedOutputTokens: 0,
      latencyMs,
      roleUsage: roles.map(emptyUsage),
      finalClaims: { supported: 1, rejected: 0, uncertain: 0 },
      deterministicAnswer: true, conductorInvoked: false, earlyExit: true,
    },
    analysis: {
      requestedDepth: options.requestedDepth,
      selectedDepth: options.selectedDepth,
      assessment: options.assessment,
      plan: options.plan,
      conductorInvoked: false,
      conductorReason: "Skipped because deterministic Project Knowledge fully resolved the query.",
      timeoutMs: options.timeoutMs,
      deterministicAnswer: true,
      earlyExitReason: "requested lookup was resolved by deterministic Project Knowledge",
      finalSnapshot: snapshot,
      review: { recommended: false, reasons: [] },
    },
    terminationReason: "completed",
  };
}
